import { TaskRegistry } from './TaskRegistry';
import { setNavigator } from './navigation';
import type { LogCallback, StateCallback } from './types';
export declare const LIB_VERSION = "0.1.4";
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
export declare class OmniDebugLink {
    private _conn;
    readonly registry: TaskRegistry;
    actionsEnabled: boolean;
    constructor(options?: OmniDebugLinkOptions);
    private readonly _onLog;
    private readonly _onStateChange;
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
    start(token: string): void;
    /**
     * Stop the client and close the connection.
     * Will NOT attempt to reconnect after calling stop().
     */
    stop(): void;
    /**
     * Set actionsEnabled. When false, all write tasks (tap_screen, swipe,
     * input_text, ui_click, long_press, send_key, reload) are rejected with
     * ACTION_DISABLED — read-only observation mode. The new value is reflected
     * in the next hello frame.
     */
    setActionsEnabled(enabled: boolean): void;
    /**
     * Register the react-navigation navigator so get_state can report the live
     * route stack. Call once at startup:
     *   OmniDebugLink.setNavigator(navigationRef.current)
     * (or wire it from your NavigationService). Without it get_state returns
     * routes:null plus a hint.
     */
    static setNavigator: typeof setNavigator;
}
//# sourceMappingURL=OmniDebugLink.d.ts.map