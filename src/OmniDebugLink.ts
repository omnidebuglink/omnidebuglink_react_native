import { Platform } from 'react-native';
import { TaskRegistry } from './TaskRegistry';
import { LinkConnection } from './LinkConnection';
import { registerBuiltinTasks } from './tasks';
import { installLogCapture, installErrorCapture, pushLog } from './log-buffer';
import { setNavigator } from './navigation';
import type { LogCallback, StateCallback } from './types';

export const LIB_VERSION = '0.1.6';

/**
 * Process-level random instance id, generated once at module load and reused
 * for the lifetime of the JS runtime — across reconnects and stop()/start()
 * cycles alike. Sent as the `instance` query param on the /ws URL so the
 * server can tell this process's own reconnects (old socket closed as a
 * normal disconnect, keep reconnecting) from a foreign session taking over
 * the token (close code 4000, fail loud — handled in LinkConnection).
 *
 * Hermes does not guarantee the full WebCrypto surface, so feature-detect:
 * crypto.randomUUID → crypto.getRandomValues hex → Math.random fallback.
 * RN's TS setup has no DOM lib, hence the manual typing of globalThis.crypto.
 */
const INSTANCE_ID: string = (() => {
  const cryptoApi = (
    globalThis as unknown as {
      crypto?: {
        randomUUID?: () => string;
        getRandomValues?: (array: Uint8Array) => Uint8Array;
      };
    }
  ).crypto;
  if (typeof cryptoApi?.randomUUID === 'function') {
    return cryptoApi.randomUUID();
  }
  if (typeof cryptoApi?.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    cryptoApi.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  // Math.random fallback (Hermes without WebCrypto): 16 random bytes as hex.
  let hex = '';
  for (let i = 0; i < 16; i++) {
    hex += Math.floor(Math.random() * 256)
      .toString(16)
      .padStart(2, '0');
  }
  return hex;
})();

export interface OmniDebugLinkOptions {
  /** Callback for log messages. */
  onLog?: LogCallback;
  /** Callback when connection state changes. */
  onStateChange?: StateCallback;
  /**
   * Patch console.log/info/warn/error into the log buffer so read_logs can
   * return app logs. Default true. The buffer always records SDK events
   * regardless of this flag.
   */
  captureConsole?: boolean;
}

export class OmniDebugLink {
  private _conn: LinkConnection | null = null;
  readonly registry: TaskRegistry;
  actionsEnabled = true;

  constructor(options: OmniDebugLinkOptions = {}) {
    this.registry = new TaskRegistry();
    if (options.captureConsole !== false) {
      installLogCapture();
    }
    installErrorCapture();
    this._onLog = (msg) => {
      pushLog('odl', msg);
      options.onLog?.(msg);
    };
    this._onStateChange = (connected) => {
      pushLog('odl', `connection ${connected ? 'established' : 'lost'}`);
      options.onStateChange?.(connected);
    };
    registerBuiltinTasks(this.registry);
  }

  private readonly _onLog: LogCallback;
  private readonly _onStateChange: StateCallback;

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
  start(token: string): void {
    if (this._conn) {
      this.stop();
    }
    const url = `wss://api.omnidebuglink.dev/ws?token=${token}&instance=${encodeURIComponent(INSTANCE_ID)}`;
    this._conn = new LinkConnection({
      url,
      registry: this.registry,
      libVersion: LIB_VERSION,
      platform: Platform.OS, // 'ios' | 'android'
      onLog: this._onLog,
      onStateChange: this._onStateChange,
    });
    this._conn.start();
  }

  /**
   * Stop the client and close the connection.
   * Will NOT attempt to reconnect after calling stop().
   */
  stop(): void {
    this._conn?.stop();
    this._conn = null;
  }

  /**
   * Set actionsEnabled. When false, all write tasks (tap_screen, swipe,
   * input_text, ui_click, long_press, send_key, reload) are rejected with
   * ACTION_DISABLED — read-only observation mode. The new value is reflected
   * in the next hello frame.
   */
  setActionsEnabled(enabled: boolean): void {
    this.actionsEnabled = enabled;
    // setter fires onChanged → connection re-sends hello with the new flag
    this.registry.actionsEnabled = enabled;
  }

  /**
   * Register the react-navigation navigator so get_state can report the live
   * route stack. Call once at startup:
   *   OmniDebugLink.setNavigator(navigationRef.current)
   * (or wire it from your NavigationService). Without it get_state returns
   * routes:null plus a hint.
   */
  static setNavigator = setNavigator;
}
