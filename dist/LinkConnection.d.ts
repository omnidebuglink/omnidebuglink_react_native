import { TaskRegistry } from './TaskRegistry';
import type { LogCallback, StateCallback } from './types';
export declare const CLOSE_CODE = 4000;
export interface LinkConnectionOptions {
    url: string;
    registry: TaskRegistry;
    libVersion: string;
    platform: string;
    onLog?: LogCallback;
    onStateChange?: StateCallback;
    /** Reflects current write-action policy; updated automatically when registry.actionsEnabled changes. */
    actionsEnabled?: boolean;
}
export declare class LinkConnection {
    private readonly _url;
    private readonly _registry;
    private readonly _libVersion;
    private readonly _platform;
    private readonly _onLog;
    private readonly _onStateChange;
    private _ws;
    private _reconnecting;
    private _replaced;
    private _backoffMs;
    private readonly _HEARTBEAT_MS;
    private readonly _WATCHDOG_MS;
    private readonly _BACKOFF_CAP;
    private _heartbeatTimer;
    private _lastInbound;
    private _actionsEnabled;
    constructor(opts: LinkConnectionOptions);
    start(): void;
    stop(): void;
    private _reconnect;
    private _open;
    private _scheduleReconnect;
    private _closeWs;
    private _sendHello;
    private _handleFrame;
    private _dispatchTask;
    private _sendResultOk;
    private _sendResultError;
    private _send;
    private _startHeartbeat;
    private _clearHeartbeat;
    private _tick;
    private _setConnected;
}
//# sourceMappingURL=LinkConnection.d.ts.map