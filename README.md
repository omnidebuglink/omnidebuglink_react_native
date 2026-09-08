# @omnidebuglink/react-native

OmniDebugLink React Native client SDK — bring AI-powered remote debugging to your React Native app.

## Install (GitHub git dependency, not published to npm)

```bash
npm install omnidebuglink/omnidebuglink_react_native#v0.1.7
cd ios && pod install        # iOS autolinking (RN 0.60+); Android is automatic
```

Or pin it in `package.json`:

```json
"dependencies": {
  "@omnidebuglink/react-native": "omnidebuglink/omnidebuglink_react_native#v0.1.7"
}
```

No manual `MainApplication.kt` / `AppDelegate` changes — RN CLI autolinking registers `OmlReactPackage` and the pod automatically (dist artifacts are committed to the repo, so git installs work out of the box).

**Expo**: bare / prebuild workflows work (`npx expo prebuild`, then as usual); managed + `expo-dev-client` works (rebuild the dev client); **Expo Go does not** (no third-party native modules).

## Quick start

```typescript
import { OmniDebugLink } from '@omnidebuglink/react-native';

const client = new OmniDebugLink({
  onLog: (msg) => console.log('[ODL]', msg),
  onStateChange: (connected) => console.log('[ODL] connected:', connected),
});

client.start('your-device-token'); // from the console

// Optional: report the react-navigation route stack in get_state
OmniDebugLink.setNavigator(navigationRef.current);

// Register custom tasks (registry changes auto-resend hello)
client.registry.register(
  'my_task',
  async (payload) => ({ status: 'done' }),
  'Does something meaningful, returns status.',
  { type: 'object', properties: { value: { type: 'string' } } },
);

client.stop();
```

> ### ⚠️ Do not call `start()` in release builds
>
> `start()` opens a debug channel that can inspect and drive your app, and
> its client token is embedded in the bundle. Keep it out of production:
> gate the call on `__DEV__`, or remove it from release bundles.
>
> Every connection with the same token kicks the previous one offline, and
> being kicked **terminates the app by design** (the SDK exits via the native
> bridge; see `start(token)`/`stop()` below). If `start()` ships in a release
> build, your users' sessions will be terminated and any loss that results is
> on you, not on OmniDebugLink.
>
> One `OmniDebugLink` instance per process. Creating a second instance that
> connects with the same token kicks the first one, and the kicked instance
> exits the app by design — this includes dev-time double initialization
> (e.g. re-running module top-level code under Fast Refresh).

## API

### `new OmniDebugLink(options?)`

| Option | Default | Description |
|---|---|---|
| `onLog` | — | Log callback |
| `onStateChange` | — | Connection state callback |
| `captureConsole` | `true` | Patch console.log/warn/error into the log buffer (read_logs) |

The constructor also installs `ErrorUtils.setGlobalHandler` so global JS errors (red-screen/fatal) land in the log buffer.

### `start(token)` / `stop()`

Connects to `wss://api.omnidebuglink.dev/ws?token=<token>`. Automatic exponential-backoff reconnect (1s→30s); **close code 4000 (token replaced) stops permanently and exits the app** via the native bridge — a live token in a release build must not stay silent.

### `setActionsEnabled(bool)`

Master switch for write operations. `false` = read-only observation mode — every write task returns `ACTION_DISABLED`; the change is announced with the next hello automatically.

### `OmniDebugLink.setNavigator(nav)`

Static. Register a react-navigation navigator (or ref.current) so get_state can report the live route stack. Unregistered → `routes: null` plus a hint.

### `registry.register(type, handler, description?, schema?, { write })`

Register custom tasks; `write: true` marks write operations (gated by actionsEnabled).

## Built-in tasks (18 + 1 in dev builds)

**Pure JS (no native code needed):**

| Type | Write | Description |
|---|---|---|
| `echo` / `ping` / `get_stats` | no | Connectivity basics |
| `read_logs` | no | 500-line ring buffer: console + global errors + SDK events; level/contains/sinceMs filters |
| `find_objects` | no | Find nodes by text/type/id substring; returns center px + normalized coords + an atomic-action hint |
| `wait_for` | no | Poll every 200ms until a node appears; timeout returns `found:false` without error |
| `reload` | yes | Reloads the JS bundle (same as the RN dev menu). **Registered in dev builds only**; pairs with metro for an AI edit→reload→verify loop |

**Native-backed (OmlReactModule via autolinking):**

| Type | Write | Description |
|---|---|---|
| `screenshot` | no | JPEG in a `__odl_file` envelope; degrades quality then downsamples to fit the 900KB budget; composes ALL windows so RN `<Modal>` shows up |
| `ui_traverse` | no | View hierarchy dump, **flat by default** (token-efficient; `flat:false` for nested), 3000-node cap, absolute screen px, top-left origin, overlay windows included |
| `tap_screen` | yes | Tap at normalized [0,1] coordinates, top-left origin, routed to the topmost window covering the point |
| `long_press` | yes | Long press at normalized coordinates (default 800ms) |
| `swipe` | yes | Swipe gesture, durationMs controlled |
| `ui_click` | yes | Click a node located by text/type/index/fieldId — locating and clicking happen atomically in one call (React tags go stale after re-renders; targets scrolled off-screen are brought back automatically) |
| `input_text` | yes | Write text into a field located by fieldId/type+index; `text` is the VALUE to enter |
| `send_key` | yes | Android: back/home/recents (back dismisses dialogs via overlay-window dispatch); iOS: enter/escape/backspace/tab/space |
| `get_state` | no | Screen/network/native activity·VC stack + react-navigation routes (requires setNavigator) |
| `get_perf` | no | ~1s fps sample (p50/p95/p99 frame times) + process memory |
| `view_component` | no | Single-node detail: layout + native view state |
| `prefs` | no/yes | Read/write the NATIVE preference store (SharedPreferences / NSUserDefaults); get/set/delete/list with valueType coercion |

When the native module is not linked, native-backed tasks return `TASK_FAILED` with install guidance; pure-JS tasks keep working.

## Native implementation notes

**Android (Kotlin)** in `android/` — touch injection dispatches MotionEvents directly on window roots (in-process, no permissions needed); real wall-clock gaps between DOWN and UP with honest timestamps (RN's JS gesture pipeline rejects synthetic future-timestamp sequences); multi-window support enumerates every window root via WindowManagerGlobal so RN `<Modal>`/Dialog is visible to screenshot/traverse/touch; `ui_click`/`input_text`(by fieldId)/`view_component` resolve React tags via `UIManagerModule` (**Paper architecture only** — Fabric errors with guidance); text/type-based locating is unaffected.

**iOS (Swift)** in `ios/` — touch injection synthesizes UITouch via KVC on underscored ivars delivered through `UIWindow.sendEvent` (same technique as in-process automation tools; a major iOS release may require adapting the KVC keys); keyboard events go through first-responder capture (`sendAction(to: nil)` responder-chain trick, no private API) + UIKeyInput. RN Modal presents within the same UIWindow on iOS, so no multi-window handling is needed there.

**Coordinates** — always **top-left origin**. Normalized coordinates are relative to the full window; ui_traverse reports absolute screen px (Android px / iOS pt).

## Known limitations

- Android **Fabric** (new architecture, default in RN 0.76+): `resolveView`-dependent paths (`input_text` by fieldId, `view_component`, `ui_click` by fieldId) are unavailable — disable `newArchEnabled` or wait for Fabric support; text/type locating, screenshot/ui_traverse/tap/swipe/get_state/get_perf work on both architectures
- `input_text` on fully controlled inputs may be overwritten by the next re-render — Android backflows through TextWatcher→onChange and iOS through `editingChanged`, which covers most cases; verify with ui_traverse
- iOS touch injection relies on UITouch private ivars (as every in-process injection does); major iOS versions may need adaptation
- `prefs` only covers the native preference store; RN AsyncStorage (SQLite)/MMKV data is not visible — wrap your own storage as a custom task
- The connection drops during `reload` and re-establishes via auto-reconnect (the task returns before the drop)

## Docs

- Protocol & third-party client guide: [clients/guide/en/third-party-client-guide.md](../guide/en/third-party-client-guide.md)
- Component development notes: [CLAUDE.md](./CLAUDE.md)

## License

Released under the [MIT License](LICENSE).
