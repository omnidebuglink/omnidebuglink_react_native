// @omnidebuglink/react-native v0.1.6

// src/OmniDebugLink.ts
import { Platform } from "react-native";

// src/TaskRegistry.ts
var ACTION_DISABLED = "ACTION_DISABLED";
var ActionDisabledError = class extends Error {
  constructor() {
    super("write actions disabled (set actionsEnabled = true)");
    this.name = "ActionDisabledError";
  }
};
var TaskRegistry = class {
  constructor() {
    this._tasks = /* @__PURE__ */ new Map();
    this._onChanged = null;
    /** When true, write tasks throw ActionDisabledError; default true = writes allowed */
    this._actionsEnabled = true;
    this._notifyScheduled = false;
  }
  set actionsEnabled(val) {
    const changed = this._actionsEnabled !== val;
    this._actionsEnabled = val;
    if (changed) this._notifyChanged();
  }
  get actionsEnabled() {
    return this._actionsEnabled;
  }
  /** Called by the connection layer when the registry changes to re-send hello. */
  set onChanged(fn) {
    this._onChanged = fn;
  }
  register(taskType, handler, description, payloadSchema, options) {
    this._tasks.set(taskType, { handler, description, payloadSchema, write: options?.write ?? false });
    this._notifyChanged();
  }
  unregister(taskType) {
    if (this._tasks.has(taskType)) {
      this._tasks.delete(taskType);
      this._notifyChanged();
    }
  }
  async run(requestId, taskType, payload) {
    const entry = this._tasks.get(taskType);
    if (!entry) {
      return {
        ok: false,
        error: { code: "TASK_UNKNOWN", message: `no handler for "${taskType}"` }
      };
    }
    if (entry.write && !this._actionsEnabled) {
      return { ok: false, error: { code: ACTION_DISABLED, message: "write actions disabled" } };
    }
    try {
      const result = await entry.handler(payload);
      return { ok: true, result };
    } catch (e) {
      if (e instanceof ActionDisabledError) {
        return { ok: false, error: { code: ACTION_DISABLED, message: String(e) } };
      }
      return {
        ok: false,
        error: { code: "TASK_FAILED", message: String(e) }
      };
    }
  }
  snapshot() {
    const out = [];
    for (const [type, entry] of this._tasks) {
      const spec = { type };
      if (entry.description) spec.description = entry.description;
      if (entry.payloadSchema) spec.payloadSchema = entry.payloadSchema;
      out.push(spec);
    }
    return out;
  }
  _notifyChanged() {
    if (this._notifyScheduled) return;
    this._notifyScheduled = true;
    setTimeout(() => {
      this._notifyScheduled = false;
      this._onChanged?.();
    }, 0);
  }
};

// src/LinkConnection.ts
import { NativeModules } from "react-native";

// src/types.ts
var CLOSE_CODE_REPLACED = 4e3;

// src/LinkConnection.ts
var CLOSE_CODE = 4e3;
var LinkConnection = class {
  constructor(opts) {
    this._ws = null;
    this._replaced = false;
    /** stop() was called by the host app — a late 4000 must not exit the process then. */
    this._stoppedByUser = false;
    this._backoffMs = 1e3;
    this._HEARTBEAT_MS = 55e3;
    this._WATCHDOG_MS = 18e4;
    this._BACKOFF_CAP = 3e4;
    this._heartbeatTimer = null;
    this._lastInbound = 0;
    this._actionsEnabled = true;
    this._url = opts.url;
    this._registry = opts.registry;
    this._libVersion = opts.libVersion;
    this._platform = opts.platform;
    this._onLog = opts.onLog ?? (() => {
    });
    this._onStateChange = opts.onStateChange ?? (() => {
    });
    this._actionsEnabled = opts.actionsEnabled ?? true;
    const syncActions = () => {
      this._actionsEnabled = this._registry.actionsEnabled;
    };
    this._registry.onChanged = () => {
      syncActions();
      this._sendHello();
    };
    syncActions();
  }
  start() {
    this._replaced = false;
    this._stoppedByUser = false;
    this._reconnect();
  }
  stop() {
    this._stoppedByUser = true;
    this._replaced = true;
    this._closeWs(true);
    this._clearHeartbeat();
    this._setConnected(false);
  }
  _reconnect() {
    if (this._replaced) return;
    this._closeWs(true);
    this._open();
  }
  _open() {
    let ws;
    try {
      ws = new WebSocket(this._url);
      this._ws = ws;
    } catch (e) {
      this._onLog(`WebSocket open failed: ${e}`);
      this._scheduleReconnect();
      return;
    }
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      this._onLog("connected");
      this._backoffMs = 1e3;
      this._lastInbound = Date.now();
      this._setConnected(true);
      this._sendHello();
      this._startHeartbeat();
    };
    ws.onmessage = (event) => {
      this._lastInbound = Date.now();
      if (typeof event.data !== "string") return;
      this._handleFrame(event.data);
    };
    ws.onerror = () => {
      this._onLog(`websocket error`);
    };
    ws.onclose = (event) => {
      if (this._ws !== ws) return;
      this._clearHeartbeat();
      this._setConnected(false);
      this._ws = null;
      if (event.code === CLOSE_CODE_REPLACED) {
        this._replaced = true;
        this._onLog(
          "TOKEN REPLACED (close 4000) \u2014 another client just connected with the same device token. One token pair belongs to ONE device. Exiting the app now; if this is a release build, remove OmniDebugLink.start() from it."
        );
        if (!this._stoppedByUser) this._exitAfterReplaced();
        return;
      }
      if (this._replaced) return;
      this._scheduleReconnect();
    };
  }
  /**
   * Fail loud after a 4000: the process exits so a token that was accidentally
   * shipped in a release build cannot keep the debug channel alive silently.
   * RN JS has no way to quit the app itself — goes through the native bridge.
   */
  _exitAfterReplaced() {
    const native = NativeModules.OmlReactModule;
    if (native && typeof native.exitApp === "function") {
      try {
        native.exitApp();
      } catch {
      }
    } else {
      this._onLog("exitApp unavailable (native side not linked) \u2014 staying stopped");
    }
  }
  _scheduleReconnect() {
    if (this._replaced || this._ws !== null) return;
    this._onLog(`reconnecting in ${this._backoffMs}ms`);
    setTimeout(() => {
      this._reconnect();
    }, this._backoffMs);
    this._backoffMs = Math.min(this._backoffMs * 2, this._BACKOFF_CAP);
  }
  _closeWs(soft) {
    if (!this._ws) return;
    this._clearHeartbeat();
    try {
      if (soft) {
        this._ws.close();
      } else {
        this._ws.close(1e3, "client stop");
      }
    } catch {
    }
    this._ws = null;
  }
  _sendHello() {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
    const frame = {
      v: 1,
      type: "hello",
      client: {
        platform: this._platform,
        libVersion: this._libVersion,
        actionsEnabled: this._actionsEnabled
      },
      tasks: this._registry.snapshot()
    };
    this._send(JSON.stringify(frame));
  }
  _handleFrame(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object" || msg.v !== 1) return;
    const type = msg.type;
    if (type === "pong") return;
    if (type === "task") {
      const requestId = msg.requestId;
      const task = msg.task;
      const taskType = task.type;
      if (!requestId || !task || typeof taskType !== "string") return;
      this._dispatchTask(requestId, taskType, task.payload ?? {});
      return;
    }
  }
  async _dispatchTask(requestId, taskType, payload) {
    const outcome = await this._registry.run(requestId, taskType, payload);
    if (outcome.ok && outcome.result !== void 0) {
      this._sendResultOk(requestId, outcome.result);
    } else {
      this._sendResultError(
        requestId,
        outcome.error?.code ?? "TASK_FAILED",
        outcome.error?.message ?? "unknown error"
      );
    }
  }
  _sendResultOk(requestId, result) {
    const frame = {
      v: 1,
      type: "result",
      requestId,
      ok: true,
      result
    };
    this._send(JSON.stringify(frame));
  }
  _sendResultError(requestId, code, message) {
    const frame = {
      v: 1,
      type: "result",
      requestId,
      ok: false,
      error: { code, message }
    };
    this._send(JSON.stringify(frame));
  }
  _send(text) {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
    try {
      this._ws.send(text);
    } catch (e) {
      this._onLog(`send failed: ${e}`);
    }
  }
  _startHeartbeat() {
    this._clearHeartbeat();
    this._heartbeatTimer = setInterval(() => this._tick(), this._HEARTBEAT_MS);
  }
  _clearHeartbeat() {
    if (this._heartbeatTimer !== null) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }
  _tick() {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
    const now = Date.now();
    if (now - this._lastInbound > this._WATCHDOG_MS) {
      this._onLog("watchdog: server silent >180s, dropping");
      this._closeWs(false);
      this._scheduleReconnect();
      return;
    }
    this._send('{"v":1,"type":"ping"}');
  }
  _setConnected(connected) {
    this._onStateChange(connected);
  }
};

// src/tasks.ts
import { NativeModules as NativeModules2 } from "react-native";

// src/log-buffer.ts
var MAX_LINES = 500;
var buffer = [];
var consoleInstalled = false;
var errorInstalled = false;
function pushLog(level, text) {
  buffer.push({ ts: Date.now(), level, text });
  if (buffer.length > MAX_LINES) {
    buffer.splice(0, buffer.length - MAX_LINES);
  }
}
function readLogs(filter) {
  const count = Math.max(1, Math.min(500, filter.count ?? 50));
  const tail = filter.tail !== false;
  let entries = buffer;
  if (filter.level) {
    const lv = filter.level.toLowerCase();
    entries = entries.filter((e) => e.level === lv || lv === "warn" && e.level === "warning");
  }
  if (filter.contains) {
    const needle = filter.contains.toLowerCase();
    entries = entries.filter((e) => e.text.toLowerCase().includes(needle));
  }
  if (typeof filter.sinceMs === "number") {
    entries = entries.filter((e) => e.ts >= filter.sinceMs);
  }
  const slice = tail ? entries.slice(-count) : entries.slice(0, count);
  const lines = slice.map((e) => `${new Date(e.ts).toISOString()} [${e.level}] ${e.text}`);
  return { lines, total: buffer.length, matched: entries.length };
}
function installLogCapture() {
  if (consoleInstalled) return;
  consoleInstalled = true;
  const wrap = (level, orig) => {
    return (...args) => {
      pushLog(level, args.map(fmt).join(" "));
      orig(...args);
    };
  };
  console.log = wrap("log", console.log.bind(console));
  console.info = wrap("info", console.info.bind(console));
  console.warn = wrap("warn", console.warn.bind(console));
  console.error = wrap("error", console.error.bind(console));
}
function installErrorCapture() {
  if (errorInstalled) return;
  errorInstalled = true;
  const g = globalThis;
  const eu = g.ErrorUtils;
  if (!eu?.setGlobalHandler) return;
  const prev = eu.getGlobalHandler?.();
  eu.setGlobalHandler((e, isFatal) => {
    const err = e;
    pushLog("error", `${isFatal ? "FATAL " : ""}${err?.stack ?? String(e)}`);
    prev?.(e, isFatal);
  });
}
function fmt(v) {
  if (typeof v === "string") return v;
  if (v instanceof Error) return `${v.name}: ${v.message}`;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

// src/navigation.ts
var navigator = null;
function setNavigator(nav) {
  navigator = nav;
}
function getNavigatorState() {
  try {
    return navigator?.getState() ?? null;
  } catch {
    return null;
  }
}

// src/tasks.ts
var nativeModule = NativeModules2.OmlReactModule;
function nativeUnavailable(method) {
  throw new Error(
    `${method}: OmlReactModule not linked. Install the native side \u2014 Android: android/ (Gradle autolink), iOS: OmniDebugLinkReactNative.podspec (pod install). See README.`
  );
}
var OML = nativeModule ?? {
  screenshot: () => nativeUnavailable("screenshot"),
  uiTree: () => nativeUnavailable("ui_traverse"),
  tap: () => nativeUnavailable("tap_screen"),
  longPress: () => nativeUnavailable("long_press"),
  swipe: () => nativeUnavailable("swipe"),
  clickView: () => nativeUnavailable("ui_click"),
  inputText: () => nativeUnavailable("input_text"),
  sendKey: () => nativeUnavailable("send_key"),
  getState: () => nativeUnavailable("get_state"),
  getPerf: () => nativeUnavailable("get_perf"),
  viewComponent: () => nativeUnavailable("view_component"),
  prefsGet: () => nativeUnavailable("prefs"),
  prefsSet: () => nativeUnavailable("prefs"),
  prefsDelete: () => nativeUnavailable("prefs"),
  prefsList: () => nativeUnavailable("prefs"),
  // Never routed through this stub: LinkConnection resolves the native module
  // itself and degrades to a log entry when it is missing.
  exitApp: () => {
  }
};
function matches(n, q) {
  if (q.id !== void 0 && n.id === q.id) return true;
  if (q.text !== void 0) {
    if (!n.text || !n.text.toLowerCase().includes(q.text.toLowerCase())) return false;
  }
  if (q.type !== void 0) {
    if (!n.type.toLowerCase().includes(q.type.toLowerCase())) return false;
  }
  return q.id !== void 0 || q.text !== void 0 || q.type !== void 0;
}
async function findInTree(q) {
  const { root, overlayRoots, windowWidth, windowHeight } = await OML.uiTree();
  const out = [];
  const walk = (n) => {
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
        window: n.window
      });
    }
    n.children?.forEach(walk);
  };
  walk(root);
  overlayRoots?.forEach(walk);
  return out;
}
async function locateOne(payload) {
  if (typeof payload.fieldId === "number" && Number.isInteger(payload.fieldId)) {
    return payload.fieldId;
  }
  const q = {};
  if (typeof payload.text === "string") q.text = payload.text;
  if (typeof payload.type === "string") q.type = payload.type;
  const index = typeof payload.index === "number" ? payload.index : 0;
  const found = await findInTree(q);
  if (found.length === 0) {
    throw new Error(`no node matches text=${q.text ?? "-"} type=${q.type ?? "-"}`);
  }
  if (index >= found.length) {
    throw new Error(`index ${index} out of range: ${found.length} matches for text=${q.text ?? "-"} type=${q.type ?? "-"}`);
  }
  return found[index].id;
}
var LOCATE_SCHEMA = {
  fieldId: { type: "integer", description: "Direct node id from ui_traverse/find_objects" },
  text: { type: "string", description: "Substring of node text to locate by" },
  type: { type: "string", description: "Substring of view type to locate by" },
  index: { type: "integer", minimum: 0, default: 0, description: "Disambiguator when multiple nodes match" }
};
function flattenTree(root, overlays) {
  const nodes = [];
  let truncated = false;
  const walk = (n, depth, path) => {
    if (nodes.length >= 3e3) {
      truncated = true;
      return;
    }
    const { children, ...rest } = n;
    if (n.truncated) truncated = true;
    nodes.push({ ...rest, depth, path });
    children?.forEach((c, i) => walk(c, depth + 1, `${path}/${i}`));
  };
  walk(root, 0, "");
  overlays.forEach((o, i) => walk(o, 0, `#o${i}`));
  return { nodes, truncated };
}
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function toNum(v) {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return NaN;
}
function registerBuiltinTasks(registry) {
  registry.register(
    "echo",
    async (payload) => ({ echo: typeof payload.text === "string" ? payload.text : "" }),
    "Returns the input string (for connectivity test).",
    { type: "object", properties: { text: { type: "string" } } }
  );
  registry.register(
    "ping",
    async () => ({}),
    "Measure round-trip time. Server calculates RTT from sentAt field.",
    {
      type: "object",
      properties: { sentAt: { type: "integer", description: "Timestamp in ms when ping was sent" } }
    }
  );
  const registeredAt = Date.now();
  let taskCount = 0;
  registry.register(
    "get_stats",
    async () => {
      taskCount += 1;
      return { uptimeMs: Date.now() - registeredAt, taskCount, registeredAt };
    },
    "Returns client resource overview (uptime, task count, registration time)."
  );
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
function registerScreenshotTask(registry) {
  registry.register(
    "screenshot",
    async () => {
      const r = await OML.screenshot();
      return {
        width: r.width,
        height: r.height,
        __odl_file: { mime: "image/jpeg", data: r.data }
      };
    },
    "Captures the current screen and returns a JPEG in the __odl_file envelope along with width/height in pixels. Native side degrades quality then downsamples until the frame fits the 900KB budget.",
    {
      type: "object",
      properties: { fullPage: { type: "boolean", description: "Accepted for API compatibility; whole window is always captured" } }
    }
  );
}
function registerUiTraverseTask(registry) {
  registry.register(
    "ui_traverse",
    async (payload) => {
      const flat = payload.flat !== false;
      const tree = await OML.uiTree();
      if (!flat) return tree;
      const { nodes, truncated } = flattenTree(tree.root, tree.overlayRoots ?? []);
      return {
        windowWidth: tree.windowWidth,
        windowHeight: tree.windowHeight,
        flat: true,
        truncated,
        nodes
      };
    },
    'Dumps the native view hierarchy. Default flat:true returns a flat node list with depth and path ("/0/2" = child indexes; "#o0..." = overlay window such as an open RN <Modal>) \u2014 much cheaper token-wise; flat:false returns the nested tree (3000 node cap). Node: { id, type, text?, hint?, desc?, x, y, width, height, window? }. Coordinates are absolute screen pixels, origin top-left. The id of RN views is the React tag \u2014 pass it as fieldId to ui_click/input_text.',
    {
      type: "object",
      properties: {
        flat: { type: "boolean", default: true, description: "true = flat list (default, token-efficient), false = nested tree" }
      }
    }
  );
}
function registerReadLogsTask(registry) {
  registry.register(
    "read_logs",
    async (payload) => readLogs({
      count: typeof payload.count === "number" ? payload.count : void 0,
      tail: payload.tail === void 0 ? void 0 : payload.tail !== false,
      level: typeof payload.level === "string" ? payload.level : void 0,
      contains: typeof payload.contains === "string" ? payload.contains : void 0,
      sinceMs: typeof payload.sinceMs === "number" ? payload.sinceMs : void 0
    }),
    "Reads the client log buffer (console.log/warn/error + global JS errors + SDK connection events), last 500 lines. Supports level/contains/sinceMs filters. Returns { lines, total, matched }. tail=true (default) returns the most recent lines.",
    {
      type: "object",
      properties: {
        count: { type: "integer", minimum: 1, maximum: 500, default: 50 },
        tail: { type: "boolean", default: true, description: "true = last N lines, false = first N lines" },
        level: { type: "string", enum: ["error", "warn", "info", "log", "odl"], description: "Filter by level" },
        contains: { type: "string", description: "Substring filter (case-insensitive)" },
        sinceMs: { type: "integer", description: "Epoch ms \u2014 only entries at/after this timestamp" }
      }
    }
  );
}
function registerTapScreenTask(registry) {
  registry.register(
    "tap_screen",
    async (payload) => {
      const x = toNum(payload.x);
      const y = toNum(payload.y);
      if (!(x >= 0 && x <= 1) || !(y >= 0 && y <= 1)) {
        throw new Error(
          `x and y must be normalized [0,1], origin top-left \u2014 got x=${JSON.stringify(payload.x)}, y=${JSON.stringify(payload.y)}`
        );
      }
      await OML.tap(x, y);
      return { tapped: true, x, y };
    },
    "Taps the screen at normalized coordinates. x/y \u2208 [0,1], origin is top-left. Use find_objects to locate targets by text first.",
    {
      type: "object",
      required: ["x", "y"],
      properties: {
        x: { type: "number", minimum: 0, maximum: 1 },
        y: { type: "number", minimum: 0, maximum: 1 }
      }
    },
    { write: true }
  );
}
function registerLongPressTask(registry) {
  registry.register(
    "long_press",
    async (payload) => {
      const x = toNum(payload.x);
      const y = toNum(payload.y);
      if (!(x >= 0 && x <= 1) || !(y >= 0 && y <= 1)) {
        throw new Error(
          `x and y must be normalized [0,1], origin top-left \u2014 got x=${JSON.stringify(payload.x)}, y=${JSON.stringify(payload.y)}`
        );
      }
      const durationMs = toNum(payload.durationMs) || 800;
      await OML.longPress(x, y, durationMs);
      return { pressed: true, durationMs };
    },
    "Performs a long press at normalized coordinates [0,1] (origin top-left) holding for durationMs (default 800). Triggers context menus, drag starts, etc.",
    {
      type: "object",
      required: ["x", "y"],
      properties: {
        x: { type: "number", minimum: 0, maximum: 1 },
        y: { type: "number", minimum: 0, maximum: 1 },
        durationMs: { type: "integer", minimum: 100, maximum: 5e3, default: 800 }
      }
    },
    { write: true }
  );
}
function registerUiClickTask(registry) {
  registry.register(
    "ui_click",
    async (payload) => {
      const hasLocator = typeof payload.fieldId === "number" || typeof payload.text === "string" || typeof payload.type === "string";
      if (!hasLocator) {
        throw new Error("provide fieldId, or text/type to locate by (index disambiguates)");
      }
      const id = await locateOne(payload);
      const clicked = await OML.clickView(id);
      return { clicked, fieldId: id };
    },
    "Clicks a UI node. Locate by text/type substring + index disambiguator, or fieldId directly \u2014 locating and clicking happen within this single call (React tags go stale after re-renders, so prefer text/type over ids fetched earlier).",
    { type: "object", properties: LOCATE_SCHEMA },
    { write: true }
  );
}
function registerSwipeTask(registry) {
  registry.register(
    "swipe",
    async (payload) => {
      const x1 = toNum(payload.x1);
      const y1 = toNum(payload.y1);
      const x2 = toNum(payload.x2);
      const y2 = toNum(payload.y2);
      if (![x1, y1, x2, y2].every((v) => v >= 0 && v <= 1)) {
        throw new Error(
          `x1/y1/x2/y2 must all be normalized [0,1], origin top-left \u2014 got ${JSON.stringify({ x1: payload.x1, y1: payload.y1, x2: payload.x2, y2: payload.y2 })}`
        );
      }
      const durationMs = toNum(payload.durationMs) || 300;
      await OML.swipe(x1, y1, x2, y2, durationMs);
      return { swiped: true };
    },
    "Swipes from (x1,y1) to (x2,y2) over durationMs. Coordinates normalized [0,1], origin top-left. Example \u2014 scroll up: {x1:0.5, y1:0.8, x2:0.5, y2:0.2, durationMs:300}.",
    {
      type: "object",
      required: ["x1", "y1", "x2", "y2"],
      properties: {
        x1: { type: "number", minimum: 0, maximum: 1 },
        y1: { type: "number", minimum: 0, maximum: 1 },
        x2: { type: "number", minimum: 0, maximum: 1 },
        y2: { type: "number", minimum: 0, maximum: 1 },
        durationMs: { type: "integer", minimum: 50, default: 300 }
      }
    },
    { write: true }
  );
}
function registerInputTextTask(registry) {
  registry.register(
    "input_text",
    async (payload) => {
      const hasLocator = typeof payload.fieldId === "number" || typeof payload.text === "string" || typeof payload.type === "string";
      const text = typeof payload.text === "string" ? payload.text : "";
      if (!hasLocator) {
        throw new Error("provide fieldId, or type to locate by (note: text is the value to type, not a locator)");
      }
      const id = typeof payload.fieldId === "number" ? payload.fieldId : await (async () => {
        const q = {};
        if (typeof payload.type === "string") q.type = payload.type;
        else if (payload.locateText !== void 0) q.text = String(payload.locateText);
        else if (typeof payload.text === "string" && !payload.type) {
          throw new Error("cannot use text as both locator and value \u2014 pass type or fieldId to locate the field");
        }
        const index = typeof payload.index === "number" ? payload.index : 0;
        const found = await findInTree(q);
        if (found.length === 0) throw new Error(`no text field matches type=${q.type ?? "-"}`);
        if (index >= found.length) throw new Error(`index out of range: ${found.length} matches`);
        return found[index].id;
      })();
      await OML.inputText(id, text);
      return { entered: text.length };
    },
    "Sets the text of a text field. Locate the field by fieldId or type + index (text is the VALUE to enter, not a locator; use locateText to disambiguate by current content). For fully controlled RN inputs a re-render may overwrite the value \u2014 verify with ui_traverse.",
    {
      type: "object",
      required: ["text"],
      properties: {
        ...LOCATE_SCHEMA,
        type: { type: "string", description: 'Substring of view type to locate the field by, e.g. "TextField"' },
        text: { type: "string", description: "The value to enter" },
        locateText: { type: "string", description: "Substring of the field current text, to disambiguate" }
      }
    },
    { write: true }
  );
}
function registerSendKeyTask(registry) {
  registry.register(
    "send_key",
    async (payload) => {
      const key = typeof payload.key === "string" ? payload.key : "";
      const supported = ["back", "home", "recents", "enter", "escape", "backspace", "tab", "space"];
      if (!supported.includes(key)) {
        throw new Error(`key must be one of ${supported.join("/")}`);
      }
      const handled = await OML.sendKey(key);
      return { sent: true, handled };
    },
    "Sends a key press. Android: back/home/recents (hardware keys; home falls back to the system intent if injection is rejected). iOS: enter/escape/backspace/tab/space dispatched to the first responder (escape dismisses the keyboard).",
    {
      type: "object",
      required: ["key"],
      properties: { key: { type: "string", enum: ["back", "home", "recents", "enter", "escape", "backspace", "tab", "space"] } }
    },
    { write: true }
  );
}
function registerFindObjectsTask(registry) {
  registry.register(
    "find_objects",
    async (payload) => {
      const q = {};
      if (typeof payload.text === "string") q.text = payload.text;
      if (typeof payload.type === "string") q.type = payload.type;
      if (typeof payload.id === "number") q.id = payload.id;
      const found = await findInTree(q);
      return {
        found,
        count: found.length,
        hint: "pass the same text/type (+index) directly to ui_click to act on a match \u2014 locating and clicking then happen atomically in one call"
      };
    },
    "Finds nodes by substring match on text and/or type (case-insensitive). Returns matches with center px coordinates (centerX/centerY) and normalized coordinates (nx/ny) ready for tap_screen.",
    {
      type: "object",
      properties: {
        text: { type: "string", description: "Substring of node text to match" },
        type: { type: "string", description: 'Substring of view type, e.g. "Text", "Button"' },
        id: { type: "integer", description: "Exact node id match" }
      }
    }
  );
}
function registerWaitForTask(registry) {
  registry.register(
    "wait_for",
    async (payload) => {
      const q = {};
      if (typeof payload.text === "string") q.text = payload.text;
      if (typeof payload.type === "string") q.type = payload.type;
      if (typeof payload.id === "number") q.id = payload.id;
      const timeoutMs = typeof payload.timeoutMs === "number" ? payload.timeoutMs : 5e3;
      const deadline = Date.now() + timeoutMs;
      for (; ; ) {
        const found = await findInTree(q);
        if (found.length > 0) return { found: true, matches: found };
        if (Date.now() >= deadline) return { found: false };
        await sleep(200);
      }
    },
    "Polls every 200ms until a node matching text/type/id appears, then returns it. On timeout returns { found: false } without error.",
    {
      type: "object",
      properties: {
        text: { type: "string" },
        type: { type: "string" },
        id: { type: "integer" },
        timeoutMs: { type: "integer", minimum: 100, default: 5e3 }
      }
    }
  );
}
function registerGetStateTask(registry) {
  registry.register(
    "get_state",
    async () => {
      const native = await OML.getState();
      const routes = getNavigatorState();
      const out = { ...native, routes };
      if (!routes) {
        out.routesHint = "routes unavailable \u2014 if using react-navigation, call OmniDebugLink.setNavigator(navigationRef) once at startup";
      }
      return out;
    },
    "Returns app state: screen metrics, network connectivity, the native view/activity stack, and (when the host registered a navigator) the react-navigation route stack.",
    { type: "object", properties: {} }
  );
}
function registerGetPerfTask(registry) {
  registry.register(
    "get_perf",
    async () => OML.getPerf(),
    "Returns performance metrics: fps sampled over ~1s with frame-time p50/p95/p99, plus process memory (Android: java heap + native/total PSS; iOS: resident + available + physical). fps 0 with hint means the screen was idle during sampling.",
    { type: "object", properties: {} }
  );
}
function registerViewComponentTask(registry) {
  registry.register(
    "view_component",
    async (payload) => {
      if (typeof payload.fieldId !== "number") {
        throw new Error("fieldId required \u2014 get it from ui_traverse or find_objects");
      }
      return OML.viewComponent(payload.fieldId);
    },
    "Returns detailed properties of a single node by fieldId: layout rect plus native view state (alpha/visibility/enabled/clickable/selected/focused, text properties when applicable). Note RN props/state live in JS \u2014 this reports the native layout result.",
    {
      type: "object",
      required: ["fieldId"],
      properties: { fieldId: { type: "integer", description: "Node id from ui_traverse/find_objects" } }
    }
  );
}
function registerPrefsTask(registry) {
  registry.register(
    "prefs",
    async (payload) => {
      const action = typeof payload.action === "string" ? payload.action : "list";
      switch (action) {
        case "get": {
          if (typeof payload.key !== "string") throw new Error("get requires key");
          const entry = await OML.prefsGet(payload.key);
          return entry ?? { found: false };
        }
        case "set": {
          if (typeof payload.key !== "string" || payload.value === void 0) {
            throw new Error("set requires key and value");
          }
          const valueType = typeof payload.valueType === "string" ? payload.valueType : typeof payload.value === "boolean" ? "bool" : typeof payload.value === "number" ? Number.isInteger(payload.value) ? "int" : "float" : "string";
          await OML.prefsSet({ key: payload.key, value: payload.value, valueType });
          return { set: payload.key };
        }
        case "delete": {
          if (typeof payload.key !== "string") throw new Error("delete requires key");
          const existed = await OML.prefsDelete(payload.key);
          return { deleted: existed };
        }
        case "list":
          return OML.prefsList();
        default:
          throw new Error(`action must be get/set/delete/list, got "${action}"`);
      }
    },
    "Reads/writes the NATIVE preferences store (Android SharedPreferences / iOS NSUserDefaults \u2014 the host app default store). NOTE: RN AsyncStorage/MMKV data is NOT visible here; wrap your own storage as a custom task if needed. set accepts valueType (string/int/long/float/bool) coercion.",
    {
      type: "object",
      required: ["action"],
      properties: {
        action: { type: "string", enum: ["get", "set", "delete", "list"] },
        key: { type: "string" },
        value: { description: "For set: string|number|boolean" },
        valueType: { type: "string", enum: ["string", "int", "long", "float", "bool"], description: "Coerce value before storing (default inferred)" }
      }
    }
  );
}
function registerReloadTask(registry) {
  if (!__DEV__) return;
  registry.register(
    "reload",
    async () => {
      const DevSettings = NativeModules2.DevSettings;
      if (!DevSettings?.reload) {
        throw new Error("DevSettings.reload unavailable in this build");
      }
      DevSettings.reload();
      return { reloaded: true, note: "JS bundle reload initiated; connection will re-establish via auto-reconnect" };
    },
    "Reloads the JS bundle (same as the RN dev-menu Reload). Dev builds only. Use after editing JS sources so metro serves the new bundle, then continue with ui_traverse to verify. Note: the device connection drops during reload and auto-reconnects.",
    { type: "object", properties: {} },
    { write: true }
  );
}

// src/OmniDebugLink.ts
var LIB_VERSION = "0.1.6";
var INSTANCE_ID = (() => {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === "function") {
    return cryptoApi.randomUUID();
  }
  if (typeof cryptoApi?.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    cryptoApi.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  let hex = "";
  for (let i = 0; i < 16; i++) {
    hex += Math.floor(Math.random() * 256).toString(16).padStart(2, "0");
  }
  return hex;
})();
var OmniDebugLink = class {
  constructor(options = {}) {
    this._conn = null;
    this.actionsEnabled = true;
    this.registry = new TaskRegistry();
    if (options.captureConsole !== false) {
      installLogCapture();
    }
    installErrorCapture();
    this._onLog = (msg) => {
      pushLog("odl", msg);
      options.onLog?.(msg);
    };
    this._onStateChange = (connected) => {
      pushLog("odl", `connection ${connected ? "established" : "lost"}`);
      options.onStateChange?.(connected);
    };
    registerBuiltinTasks(this.registry);
  }
  /**
   * Start the client and connect to the server.
   *
   * @param token The client token assigned to this device.
   *              Obtain from the console or MCP tool's device_detail.
   *
   * @example
   * ```ts
   * const client = new OmniDebugLink();
   * client.start('your-client-token-here');
   * ```
   */
  start(token) {
    if (this._conn) {
      this.stop();
    }
    const url = `wss://api.omnidebuglink.dev/ws?token=${token}&instance=${encodeURIComponent(INSTANCE_ID)}`;
    this._conn = new LinkConnection({
      url,
      registry: this.registry,
      libVersion: LIB_VERSION,
      platform: Platform.OS,
      // 'ios' | 'android'
      onLog: this._onLog,
      onStateChange: this._onStateChange
    });
    this._conn.start();
  }
  /**
   * Stop the client and close the connection.
   * Will NOT attempt to reconnect after calling stop().
   */
  stop() {
    this._conn?.stop();
    this._conn = null;
  }
  /**
   * Set actionsEnabled. When false, all write tasks (tap_screen, swipe,
   * input_text, ui_click, long_press, send_key, reload) are rejected with
   * ACTION_DISABLED — read-only observation mode. The new value is reflected
   * in the next hello frame.
   */
  setActionsEnabled(enabled) {
    this.actionsEnabled = enabled;
    this.registry.actionsEnabled = enabled;
  }
};
/**
 * Register the react-navigation navigator so get_state can report the live
 * route stack. Call once at startup:
 *   OmniDebugLink.setNavigator(navigationRef.current)
 * (or wire it from your NavigationService). Without it get_state returns
 * routes:null plus a hint.
 */
OmniDebugLink.setNavigator = setNavigator;
export {
  CLOSE_CODE as CLOSE_CODE_REPLACED,
  LIB_VERSION,
  LinkConnection,
  OmniDebugLink,
  TaskRegistry,
  getNavigatorState,
  installErrorCapture,
  installLogCapture,
  pushLog,
  readLogs,
  registerBuiltinTasks,
  setNavigator
};
