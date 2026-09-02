import { NativeModules } from 'react-native';
import { TaskRegistry } from './TaskRegistry';
import { readLogs } from './log-buffer';
import { getNavigatorState } from './navigation';
import type { OmlNativeModule, OmlNode } from './types';

declare const __DEV__: boolean;

// ─── Native module handle ────────────────────────────────────────────────────

const nativeModule = NativeModules.OmlReactModule as OmlNativeModule | undefined;

function nativeUnavailable(method: string): never {
  throw new Error(
    `${method}: OmlReactModule not linked. ` +
      'Install the native side — Android: android/ (Gradle autolink), ' +
      'iOS: OmniDebugLinkReactNative.podspec (pod install). See README.',
  );
}

const OML: OmlNativeModule = nativeModule ?? {
  screenshot: () => nativeUnavailable('screenshot'),
  uiTree: () => nativeUnavailable('ui_traverse'),
  tap: () => nativeUnavailable('tap_screen'),
  longPress: () => nativeUnavailable('long_press'),
  swipe: () => nativeUnavailable('swipe'),
  clickView: () => nativeUnavailable('ui_click'),
  inputText: () => nativeUnavailable('input_text'),
  sendKey: () => nativeUnavailable('send_key'),
  getState: () => nativeUnavailable('get_state'),
  getPerf: () => nativeUnavailable('get_perf'),
  viewComponent: () => nativeUnavailable('view_component'),
  prefsGet: () => nativeUnavailable('prefs'),
  prefsSet: () => nativeUnavailable('prefs'),
  prefsDelete: () => nativeUnavailable('prefs'),
  prefsList: () => nativeUnavailable('prefs'),
};

// ─── Tree helpers (shared by ui_traverse / find_objects / wait_for / ui_click) ─

export interface FindQuery {
  text?: string;
  type?: string;
  id?: number;
}

export interface FoundNode {
  id: number;
  type: string;
  text?: string;
  /** Absolute screen px, top-left origin */
  centerX: number;
  centerY: number;
  /** Normalized [0,1] — directly usable by tap_screen */
  nx: number;
  ny: number;
}

function matches(n: OmlNode, q: FindQuery): boolean {
  if (q.id !== undefined && n.id === q.id) return true;
  if (q.text !== undefined) {
    if (!n.text || !n.text.toLowerCase().includes(q.text.toLowerCase())) return false;
  }
  if (q.type !== undefined) {
    if (!n.type.toLowerCase().includes(q.type.toLowerCase())) return false;
  }
  return q.id !== undefined || q.text !== undefined || q.type !== undefined;
}

async function findInTree(q: FindQuery): Promise<FoundNode[]> {
  const { root, windowWidth, windowHeight } = await OML.uiTree();
  const out: FoundNode[] = [];
  const walk = (n: OmlNode) => {
    if (matches(n, q)) {
      const cx = n.x + n.width / 2;
      const cy = n.y + n.height / 2;
      out.push({
        id: n.id,
        type: n.type,
        text: n.text,
        centerX: cx,
        centerY: cy,
        nx: windowWidth > 0 ? cx / windowWidth : 0,
        ny: windowHeight > 0 ? cy / windowHeight : 0,
      });
    }
    n.children?.forEach(walk);
  };
  walk(root);
  return out;
}

/** Resolve a LocateQuery to a single node id (index disambiguates matches). */
async function locateOne(payload: Record<string, unknown>): Promise<number> {
  if (typeof payload.fieldId === 'number' && Number.isInteger(payload.fieldId)) {
    return payload.fieldId;
  }
  const q: FindQuery = {};
  if (typeof payload.text === 'string') q.text = payload.text;
  if (typeof payload.type === 'string') q.type = payload.type;
  const index = typeof payload.index === 'number' ? payload.index : 0;
  const found = await findInTree(q);
  if (found.length === 0) {
    throw new Error(`no node matches text=${q.text ?? '-'} type=${q.type ?? '-'}`);
  }
  if (index >= found.length) {
    throw new Error(`index ${index} out of range: ${found.length} matches for text=${q.text ?? '-'} type=${q.type ?? '-'}`);
  }
  return found[index].id;
}

const LOCATE_SCHEMA: Record<string, unknown> = {
  fieldId: { type: 'integer', description: 'Direct node id from ui_traverse/find_objects' },
  text: { type: 'string', description: 'Substring of node text to locate by' },
  type: { type: 'string', description: 'Substring of view type to locate by' },
  index: { type: 'integer', minimum: 0, default: 0, description: 'Disambiguator when multiple nodes match' },
};

interface FlatNode extends Omit<OmlNode, 'children'> {
  depth: number;
  path: string;
}

function flattenTree(root: OmlNode): { nodes: FlatNode[]; truncated: boolean } {
  const nodes: FlatNode[] = [];
  let truncated = false;
  const walk = (n: OmlNode, depth: number, path: string) => {
    if (nodes.length >= 3000) {
      truncated = true;
      return;
    }
    const { children, ...rest } = n;
    if (n.truncated) truncated = true;
    nodes.push({ ...rest, depth, path });
    children?.forEach((c, i) => walk(c, depth + 1, `${path}/${i}`));
  };
  walk(root, 0, '');
  return { nodes, truncated };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ─── Registration ────────────────────────────────────────────────────────────

export function registerBuiltinTasks(registry: TaskRegistry): void {
  // -- Required basics (§7.1) --
  registry.register(
    'echo',
    async (payload) => ({ echo: typeof payload.text === 'string' ? payload.text : '' }),
    'Returns the input string (for connectivity test).',
    { type: 'object', properties: { text: { type: 'string' } } },
  );

  registry.register(
    'ping',
    async () => ({}),
    'Measure round-trip time. Server calculates RTT from sentAt field.',
    {
      type: 'object',
      properties: { sentAt: { type: 'integer', description: 'Timestamp in ms when ping was sent' } },
    },
  );

  const registeredAt = Date.now();
  let taskCount = 0;
  registry.register(
    'get_stats',
    async () => {
      taskCount += 1;
      return { uptimeMs: Date.now() - registeredAt, taskCount, registeredAt };
    },
    'Returns client resource overview (uptime, task count, registration time).',
  );

  // -- High-value tasks (§7.2) + optional set (§7.3) --
  registerScreenshotTask(registry);
  registerUiTraverseTask(registry);
  registerReadLogsTask(registry);
  registerTapScreenTask(registry);
  registerLongPressTask(registry);
  registerUiClickTask(registry);
  registerSwipeTask(registry);
  registerInputTextTask(registry);
  registerSendKeyTask(registry);
  registerFindObjectsTask(registry);
  registerWaitForTask(registry);
  registerGetStateTask(registry);
  registerGetPerfTask(registry);
  registerViewComponentTask(registry);
  registerPrefsTask(registry);
  registerReloadTask(registry);
}

// ─── screenshot ──────────────────────────────────────────────────────────────

function registerScreenshotTask(registry: TaskRegistry): void {
  registry.register(
    'screenshot',
    async () => {
      const r = await OML.screenshot();
      return {
        width: r.width,
        height: r.height,
        __odl_file: { mime: 'image/jpeg', data: r.data },
      };
    },
    'Captures the current screen and returns a JPEG in the __odl_file envelope along with width/height in pixels. Native side degrades quality then downsamples until the frame fits the 900KB budget.',
    {
      type: 'object',
      properties: { fullPage: { type: 'boolean', description: 'Accepted for API compatibility; whole window is always captured' } },
    },
  );
}

// ─── ui_traverse ─────────────────────────────────────────────────────────────

function registerUiTraverseTask(registry: TaskRegistry): void {
  registry.register(
    'ui_traverse',
    async (payload) => {
      const flat = payload.flat !== false;
      const tree = await OML.uiTree();
      if (!flat) return tree;
      const { nodes, truncated } = flattenTree(tree.root);
      return {
        windowWidth: tree.windowWidth,
        windowHeight: tree.windowHeight,
        flat: true,
        truncated,
        nodes,
      };
    },
    'Dumps the native view hierarchy. Default flat:true returns a flat node list with depth and path ("/0/2" = child indexes) — much cheaper token-wise; flat:false returns the nested tree (3000 node cap). Node: { id, type, text?, hint?, desc?, x, y, width, height }. Coordinates are absolute screen pixels, origin top-left. The id of RN views is the React tag — pass it as fieldId to ui_click/input_text.',
    {
      type: 'object',
      properties: {
        flat: { type: 'boolean', default: true, description: 'true = flat list (default, token-efficient), false = nested tree' },
      },
    },
  );
}

// ─── read_logs ───────────────────────────────────────────────────────────────

function registerReadLogsTask(registry: TaskRegistry): void {
  registry.register(
    'read_logs',
    async (payload) =>
      readLogs({
        count: typeof payload.count === 'number' ? payload.count : undefined,
        tail: payload.tail === undefined ? undefined : payload.tail !== false,
        level: typeof payload.level === 'string' ? payload.level : undefined,
        contains: typeof payload.contains === 'string' ? payload.contains : undefined,
        sinceMs: typeof payload.sinceMs === 'number' ? payload.sinceMs : undefined,
      }),
    'Reads the client log buffer (console.log/warn/error + global JS errors + SDK connection events), last 500 lines. Supports level/contains/sinceMs filters. Returns { lines, total, matched }. tail=true (default) returns the most recent lines.',
    {
      type: 'object',
      properties: {
        count: { type: 'integer', minimum: 1, maximum: 500, default: 50 },
        tail: { type: 'boolean', default: true, description: 'true = last N lines, false = first N lines' },
        level: { type: 'string', enum: ['error', 'warn', 'info', 'log', 'odl'], description: 'Filter by level' },
        contains: { type: 'string', description: 'Substring filter (case-insensitive)' },
        sinceMs: { type: 'integer', description: 'Epoch ms — only entries at/after this timestamp' },
      },
    },
  );
}

// ─── tap_screen ──────────────────────────────────────────────────────────────

function registerTapScreenTask(registry: TaskRegistry): void {
  registry.register(
    'tap_screen',
    async (payload) => {
      const x = typeof payload.x === 'number' ? payload.x : NaN;
      const y = typeof payload.y === 'number' ? payload.y : NaN;
      if (!(x >= 0 && x <= 1) || !(y >= 0 && y <= 1)) {
        throw new Error('x and y must be normalized [0,1], origin top-left');
      }
      await OML.tap(x, y);
      return { tapped: true, x, y };
    },
    'Taps the screen at normalized coordinates. x/y ∈ [0,1], origin is top-left. Use find_objects to locate targets by text first.',
    {
      type: 'object',
      required: ['x', 'y'],
      properties: {
        x: { type: 'number', minimum: 0, maximum: 1 },
        y: { type: 'number', minimum: 0, maximum: 1 },
      },
    },
    { write: true },
  );
}

// ─── long_press ──────────────────────────────────────────────────────────────

function registerLongPressTask(registry: TaskRegistry): void {
  registry.register(
    'long_press',
    async (payload) => {
      const x = typeof payload.x === 'number' ? payload.x : NaN;
      const y = typeof payload.y === 'number' ? payload.y : NaN;
      if (!(x >= 0 && x <= 1) || !(y >= 0 && y <= 1)) {
        throw new Error('x and y must be normalized [0,1], origin top-left');
      }
      const durationMs = typeof payload.durationMs === 'number' ? payload.durationMs : 800;
      await OML.longPress(x, y, durationMs);
      return { pressed: true, durationMs };
    },
    'Performs a long press at normalized coordinates [0,1] (origin top-left) holding for durationMs (default 800). Triggers context menus, drag starts, etc.',
    {
      type: 'object',
      required: ['x', 'y'],
      properties: {
        x: { type: 'number', minimum: 0, maximum: 1 },
        y: { type: 'number', minimum: 0, maximum: 1 },
        durationMs: { type: 'integer', minimum: 100, maximum: 5000, default: 800 },
      },
    },
    { write: true },
  );
}

// ─── ui_click ────────────────────────────────────────────────────────────────

function registerUiClickTask(registry: TaskRegistry): void {
  registry.register(
    'ui_click',
    async (payload) => {
      const hasLocator =
        typeof payload.fieldId === 'number' ||
        typeof payload.text === 'string' ||
        typeof payload.type === 'string';
      if (!hasLocator) {
        throw new Error('provide fieldId, or text/type to locate by (index disambiguates)');
      }
      const id = await locateOne(payload);
      const clicked = await OML.clickView(id);
      return { clicked, fieldId: id };
    },
    'Clicks a UI node. Locate by text/type substring + index disambiguator, or fieldId directly — locating and clicking happen within this single call (React tags go stale after re-renders, so prefer text/type over ids fetched earlier).',
    { type: 'object', properties: LOCATE_SCHEMA },
    { write: true },
  );
}

// ─── swipe ───────────────────────────────────────────────────────────────────

function registerSwipeTask(registry: TaskRegistry): void {
  registry.register(
    'swipe',
    async (payload) => {
      const nums = [payload.x1, payload.y1, payload.x2, payload.y2];
      if (!nums.every((v) => typeof v === 'number' && v >= 0 && v <= 1)) {
        throw new Error('x1/y1/x2/y2 must all be normalized [0,1], origin top-left');
      }
      const durationMs = typeof payload.durationMs === 'number' ? payload.durationMs : 300;
      await OML.swipe(payload.x1 as number, payload.y1 as number,
        payload.x2 as number, payload.y2 as number, durationMs);
      return { swiped: true };
    },
    'Swipes from (x1,y1) to (x2,y2) over durationMs. Coordinates normalized [0,1], origin top-left. Example — scroll up: {x1:0.5, y1:0.8, x2:0.5, y2:0.2, durationMs:300}.',
    {
      type: 'object',
      required: ['x1', 'y1', 'x2', 'y2'],
      properties: {
        x1: { type: 'number', minimum: 0, maximum: 1 },
        y1: { type: 'number', minimum: 0, maximum: 1 },
        x2: { type: 'number', minimum: 0, maximum: 1 },
        y2: { type: 'number', minimum: 0, maximum: 1 },
        durationMs: { type: 'integer', minimum: 50, default: 300 },
      },
    },
    { write: true },
  );
}

// ─── input_text ──────────────────────────────────────────────────────────────

function registerInputTextTask(registry: TaskRegistry): void {
  registry.register(
    'input_text',
    async (payload) => {
      const hasLocator =
        typeof payload.fieldId === 'number' ||
        typeof payload.text === 'string' ||
        typeof payload.type === 'string';
      const text = typeof payload.text === 'string' ? payload.text : '';
      if (!hasLocator) {
        throw new Error('provide fieldId, or type to locate by (note: text is the value to type, not a locator)');
      }
      // text doubles as the value to enter — when only text is given, the
      // field must be located by type (e.g. TextField)
      const id =
        typeof payload.fieldId === 'number'
          ? payload.fieldId
          : await (async () => {
              const q: FindQuery = {};
              if (typeof payload.type === 'string') q.type = payload.type;
              else if (payload.locateText !== undefined) q.text = String(payload.locateText);
              else if (typeof payload.text === 'string' && !payload.type) {
                throw new Error('cannot use text as both locator and value — pass type or fieldId to locate the field');
              }
              const index = typeof payload.index === 'number' ? payload.index : 0;
              const found = await findInTree(q);
              if (found.length === 0) throw new Error(`no text field matches type=${q.type ?? '-'}`);
              if (index >= found.length) throw new Error(`index out of range: ${found.length} matches`);
              return found[index].id;
            })();
      await OML.inputText(id, text);
      return { entered: text.length };
    },
    'Sets the text of a text field. Locate the field by fieldId or type + index (text is the VALUE to enter, not a locator; use locateText to disambiguate by current content). For fully controlled RN inputs a re-render may overwrite the value — verify with ui_traverse.',
    {
      type: 'object',
      required: ['text'],
      properties: {
        ...LOCATE_SCHEMA,
        type: { type: 'string', description: 'Substring of view type to locate the field by, e.g. "TextField"' },
        text: { type: 'string', description: 'The value to enter' },
        locateText: { type: 'string', description: 'Substring of the field current text, to disambiguate' },
      },
    },
    { write: true },
  );
}

// ─── send_key ────────────────────────────────────────────────────────────────

function registerSendKeyTask(registry: TaskRegistry): void {
  registry.register(
    'send_key',
    async (payload) => {
      const key = typeof payload.key === 'string' ? payload.key : '';
      const supported = ['back', 'home', 'recents', 'enter', 'escape', 'backspace', 'tab', 'space'];
      if (!supported.includes(key)) {
        throw new Error(`key must be one of ${supported.join('/')}`);
      }
      const handled = await OML.sendKey(key);
      return { sent: true, handled };
    },
    'Sends a key press. Android: back/home/recents (hardware keys; home falls back to the system intent if injection is rejected). iOS: enter/escape/backspace/tab/space dispatched to the first responder (escape dismisses the keyboard).',
    {
      type: 'object',
      required: ['key'],
      properties: { key: { type: 'string', enum: ['back', 'home', 'recents', 'enter', 'escape', 'backspace', 'tab', 'space'] } },
    },
    { write: true },
  );
}

// ─── find_objects ────────────────────────────────────────────────────────────

function registerFindObjectsTask(registry: TaskRegistry): void {
  registry.register(
    'find_objects',
    async (payload) => {
      const q: FindQuery = {};
      if (typeof payload.text === 'string') q.text = payload.text;
      if (typeof payload.type === 'string') q.type = payload.type;
      if (typeof payload.id === 'number') q.id = payload.id;
      const found = await findInTree(q);
      return {
        found,
        count: found.length,
        hint: 'pass the same text/type (+index) directly to ui_click to act on a match — locating and clicking then happen atomically in one call',
      };
    },
    'Finds nodes by substring match on text and/or type (case-insensitive). Returns matches with center px coordinates (centerX/centerY) and normalized coordinates (nx/ny) ready for tap_screen.',
    {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Substring of node text to match' },
        type: { type: 'string', description: 'Substring of view type, e.g. "Text", "Button"' },
        id: { type: 'integer', description: 'Exact node id match' },
      },
    },
  );
}

// ─── wait_for ────────────────────────────────────────────────────────────────

function registerWaitForTask(registry: TaskRegistry): void {
  registry.register(
    'wait_for',
    async (payload) => {
      const q: FindQuery = {};
      if (typeof payload.text === 'string') q.text = payload.text;
      if (typeof payload.type === 'string') q.type = payload.type;
      if (typeof payload.id === 'number') q.id = payload.id;
      const timeoutMs = typeof payload.timeoutMs === 'number' ? payload.timeoutMs : 5000;
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = await findInTree(q);
        if (found.length > 0) return { found: true, matches: found };
        if (Date.now() >= deadline) return { found: false };
        await sleep(200);
      }
    },
    'Polls every 200ms until a node matching text/type/id appears, then returns it. On timeout returns { found: false } without error.',
    {
      type: 'object',
      properties: {
        text: { type: 'string' },
        type: { type: 'string' },
        id: { type: 'integer' },
        timeoutMs: { type: 'integer', minimum: 100, default: 5000 },
      },
    },
  );
}

// ─── get_state ───────────────────────────────────────────────────────────────

function registerGetStateTask(registry: TaskRegistry): void {
  registry.register(
    'get_state',
    async () => {
      const native = await OML.getState();
      const routes = getNavigatorState();
      const out: Record<string, unknown> = { ...native, routes };
      if (!routes) {
        out.routesHint =
          'routes unavailable — if using react-navigation, call OmniDebugLink.setNavigator(navigationRef) once at startup';
      }
      return out;
    },
    'Returns app state: screen metrics, network connectivity, the native view/activity stack, and (when the host registered a navigator) the react-navigation route stack.',
    { type: 'object', properties: {} },
  );
}

// ─── get_perf ────────────────────────────────────────────────────────────────

function registerGetPerfTask(registry: TaskRegistry): void {
  registry.register(
    'get_perf',
    async () => OML.getPerf(),
    'Returns performance metrics: fps sampled over ~1s with frame-time p50/p95/p99, plus process memory (Android: java heap + native/total PSS; iOS: resident + available + physical). fps 0 with hint means the screen was idle during sampling.',
    { type: 'object', properties: {} },
  );
}

// ─── view_component ──────────────────────────────────────────────────────────

function registerViewComponentTask(registry: TaskRegistry): void {
  registry.register(
    'view_component',
    async (payload) => {
      if (typeof payload.fieldId !== 'number') {
        throw new Error('fieldId required — get it from ui_traverse or find_objects');
      }
      return OML.viewComponent(payload.fieldId);
    },
    'Returns detailed properties of a single node by fieldId: layout rect plus native view state (alpha/visibility/enabled/clickable/selected/focused, text properties when applicable). Note RN props/state live in JS — this reports the native layout result.',
    {
      type: 'object',
      required: ['fieldId'],
      properties: { fieldId: { type: 'integer', description: 'Node id from ui_traverse/find_objects' } },
    },
  );
}

// ─── prefs ───────────────────────────────────────────────────────────────────

function registerPrefsTask(registry: TaskRegistry): void {
  registry.register(
    'prefs',
    async (payload) => {
      const action = typeof payload.action === 'string' ? payload.action : 'list';
      switch (action) {
        case 'get': {
          if (typeof payload.key !== 'string') throw new Error('get requires key');
          const entry = await OML.prefsGet(payload.key);
          return entry ?? { found: false };
        }
        case 'set': {
          if (typeof payload.key !== 'string' || payload.value === undefined) {
            throw new Error('set requires key and value');
          }
          const valueType =
            typeof payload.valueType === 'string'
              ? payload.valueType
              : typeof payload.value === 'boolean'
                ? 'bool'
                : typeof payload.value === 'number'
                  ? Number.isInteger(payload.value)
                    ? 'int'
                    : 'float'
                  : 'string';
          await OML.prefsSet({ key: payload.key, value: payload.value, valueType });
          return { set: payload.key };
        }
        case 'delete': {
          if (typeof payload.key !== 'string') throw new Error('delete requires key');
          const existed = await OML.prefsDelete(payload.key);
          return { deleted: existed };
        }
        case 'list':
          return OML.prefsList();
        default:
          throw new Error(`action must be get/set/delete/list, got "${action}"`);
      }
    },
    'Reads/writes the NATIVE preferences store (Android SharedPreferences / iOS NSUserDefaults — the host app default store). NOTE: RN AsyncStorage/MMKV data is NOT visible here; wrap your own storage as a custom task if needed. set accepts valueType (string/int/long/float/bool) coercion.',
    {
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['get', 'set', 'delete', 'list'] },
        key: { type: 'string' },
        value: { description: 'For set: string|number|boolean' },
        valueType: { type: 'string', enum: ['string', 'int', 'long', 'float', 'bool'], description: 'Coerce value before storing (default inferred)' },
      },
    },
  );
}

// ─── reload (dev builds only) ────────────────────────────────────────────────

function registerReloadTask(registry: TaskRegistry): void {
  // Registered at bootstrap only in dev builds — release builds must not
  // advertise the capability (list_tasks/UNKNOWN_TASK pre-check stays accurate)
  if (!__DEV__) return;
  registry.register(
    'reload',
    async () => {
      const DevSettings = (NativeModules as { DevSettings?: { reload(): void } }).DevSettings;
      if (!DevSettings?.reload) {
        throw new Error('DevSettings.reload unavailable in this build');
      }
      DevSettings.reload();
      return { reloaded: true, note: 'JS bundle reload initiated; connection will re-establish via auto-reconnect' };
    },
    'Reloads the JS bundle (same as the RN dev-menu Reload). Dev builds only. Use after editing JS sources so metro serves the new bundle, then continue with ui_traverse to verify. Note: the device connection drops during reload and auto-reconnects.',
    { type: 'object', properties: {} },
    { write: true },
  );
}
