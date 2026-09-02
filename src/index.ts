export { OmniDebugLink, LIB_VERSION } from './OmniDebugLink';
export { TaskRegistry } from './TaskRegistry';
export type { TaskEntry } from './TaskRegistry';
export { LinkConnection, CLOSE_CODE as CLOSE_CODE_REPLACED } from './LinkConnection';
export { installLogCapture, installErrorCapture, readLogs, pushLog } from './log-buffer';
export { setNavigator, getNavigatorState } from './navigation';
export type { NavState, NavRoute, NavigatorLike } from './navigation';
export { registerBuiltinTasks } from './tasks';
export type { FindQuery, FoundNode } from './tasks';

export type {
  ClientMessage,
  ServerMessage,
  HelloFrame,
  TaskFrame,
  ResultFrame,
  PingFrame,
  PongFrame,
  TaskSpec,
  ClientInfo,
  LogCallback,
  StateCallback,
  OmlNode,
  OmlScreenshotResult,
  OmlTreeResult,
  OmlStateResult,
  OmlPerfResult,
  OmlPrefsEntry,
  OmlNativeModule,
} from './types';