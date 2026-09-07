import { NativeModules } from 'react-native';
import { TaskRegistry } from './TaskRegistry';
import type { LogCallback, StateCallback, HelloFrame, ResultFrame, OmlNativeModule } from './types';
import { CLOSE_CODE_REPLACED } from './types';

export const CLOSE_CODE = 4000;

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

export class LinkConnection {
  private readonly _url: string;
  private readonly _registry: TaskRegistry;
  private readonly _libVersion: string;
  private readonly _platform: string;
  private readonly _onLog: LogCallback;
  private readonly _onStateChange: StateCallback;

  private _ws: WebSocket | null = null;
  private _replaced = false;
  /** stop() was called by the host app — a late 4000 must not exit the process then. */
  private _stoppedByUser = false;
  private _backoffMs = 1000;
  private readonly _HEARTBEAT_MS = 55_000;
  private readonly _WATCHDOG_MS = 180_000;
  private readonly _BACKOFF_CAP = 30_000;
  private _heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private _lastInbound = 0;
  private _actionsEnabled = true;

  constructor(opts: LinkConnectionOptions) {
    this._url = opts.url;
    this._registry = opts.registry;
    this._libVersion = opts.libVersion;
    this._platform = opts.platform;
    this._onLog = opts.onLog ?? (() => {});
    this._onStateChange = opts.onStateChange ?? (() => {});
    this._actionsEnabled = opts.actionsEnabled ?? true;

    // Mirror registry actionsEnabled so hello always reflects current state
    const syncActions = () => { this._actionsEnabled = this._registry.actionsEnabled; };
    this._registry.onChanged = () => {
      syncActions();
      this._sendHello();
    };
    syncActions();
  }

  start(): void {
    this._replaced = false;
    this._stoppedByUser = false;
    this._reconnect();
  }

  stop(): void {
    this._stoppedByUser = true;
    this._replaced = true;
    this._closeWs(true);
    this._clearHeartbeat();
    this._setConnected(false);
  }

  private _reconnect(): void {
    if (this._replaced) return;
    this._closeWs(true);
    this._open();
  }

  private _open(): void {
    let ws: WebSocket;
    try {
      ws = new WebSocket(this._url);
      this._ws = ws;
    } catch (e) {
      this._onLog(`WebSocket open failed: ${e}`);
      this._scheduleReconnect();
      return;
    }

    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      this._onLog('connected');
      this._backoffMs = 1000;
      this._lastInbound = Date.now();
      this._setConnected(true);
      this._sendHello();
      this._startHeartbeat();
    };

    ws.onmessage = (event: WebSocketMessageEvent) => {
      this._lastInbound = Date.now();
      if (typeof event.data !== 'string') return;
      this._handleFrame(event.data);
    };

    ws.onerror = () => {
      this._onLog(`websocket error`);
    };

    ws.onclose = (event: WebSocketCloseEvent) => {
      // Generational guard: events from a socket we already abandoned (a new
      // attempt replaced it) are irrelevant — the server kicks the OLD socket
      // with 4000 when our own reconnect took the seat, and that must not be
      // mistaken for a real takeover by another device.
      if (this._ws !== ws) return;
      this._clearHeartbeat();
      this._setConnected(false);
      this._ws = null;

      if (event.code === CLOSE_CODE_REPLACED) {
        this._replaced = true;
        this._onLog(
          'TOKEN REPLACED (close 4000) — another client just connected with the same ' +
            'device token. One token pair belongs to ONE device. Exiting the app now; ' +
            'if this is a release build, remove OmniDebugLink.start() from it.',
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
  private _exitAfterReplaced(): void {
    const native = NativeModules.OmlReactModule as OmlNativeModule | undefined;
    if (native && typeof native.exitApp === 'function') {
      try {
        native.exitApp();
      } catch {
        // bridge already torn down; the log above is the trace
      }
    } else {
      this._onLog('exitApp unavailable (native side not linked) — staying stopped');
    }
  }

  private _scheduleReconnect(): void {
    if (this._replaced || this._ws !== null) return;
    this._onLog(`reconnecting in ${this._backoffMs}ms`);
    setTimeout(() => {
      this._reconnect();
    }, this._backoffMs);
    this._backoffMs = Math.min(this._backoffMs * 2, this._BACKOFF_CAP);
  }

  private _closeWs(soft: boolean): void {
    if (!this._ws) return;
    this._clearHeartbeat();
    try {
      if (soft) {
        // Allow existing handlers to finish before closing
        this._ws.close();
      } else {
        this._ws.close(1000, 'client stop');
      }
    } catch {
      // ignore
    }
    this._ws = null;
  }

  private _sendHello(): void {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
    const frame: HelloFrame = {
      v: 1,
      type: 'hello',
      client: {
        platform: this._platform,
        libVersion: this._libVersion,
        actionsEnabled: this._actionsEnabled,
      },
      tasks: this._registry.snapshot(),
    };
    this._send(JSON.stringify(frame));
  }

  private _handleFrame(raw: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object' || msg.v !== 1) return;

    const type = msg.type as string | undefined;
    if (type === 'pong') return;

    if (type === 'task') {
      const requestId = msg.requestId as string;
      const task = msg.task as { type: string; payload?: Record<string, unknown> };
      const taskType = task.type;
      if (!requestId || !task || typeof taskType !== 'string') return;
      // Fire-and-forget handler; must always reply with result
      this._dispatchTask(requestId, taskType, (task.payload as Record<string, unknown>) ?? {});
      return;
    }
  }

  private async _dispatchTask(
    requestId: string,
    taskType: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const outcome = await this._registry.run(requestId, taskType, payload);
    if (outcome.ok && outcome.result !== undefined) {
      this._sendResultOk(requestId, outcome.result);
    } else {
      this._sendResultError(
        requestId,
        outcome.error?.code ?? 'TASK_FAILED',
        outcome.error?.message ?? 'unknown error',
      );
    }
  }

  private _sendResultOk(requestId: string, result: unknown): void {
    const frame: ResultFrame = {
      v: 1,
      type: 'result',
      requestId,
      ok: true,
      result,
    };
    this._send(JSON.stringify(frame));
  }

  private _sendResultError(requestId: string, code: string, message: string): void {
    const frame: ResultFrame = {
      v: 1,
      type: 'result',
      requestId,
      ok: false,
      error: { code, message },
    };
    this._send(JSON.stringify(frame));
  }

  private _send(text: string): void {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
    try {
      this._ws.send(text);
    } catch (e) {
      this._onLog(`send failed: ${e}`);
    }
  }

  private _startHeartbeat(): void {
    this._clearHeartbeat();
    this._heartbeatTimer = setInterval(() => this._tick(), this._HEARTBEAT_MS);
  }

  private _clearHeartbeat(): void {
    if (this._heartbeatTimer !== null) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }

  private _tick(): void {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
    const now = Date.now();
    if (now - this._lastInbound > this._WATCHDOG_MS) {
      this._onLog('watchdog: server silent >180s, dropping');
      // _closeWs nulls this._ws, so the late onclose for this socket dies on
      // the generational guard — the reconnect must be scheduled here.
      this._closeWs(false);
      this._scheduleReconnect();
      return;
    }
    this._send('{"v":1,"type":"ping"}');
  }

  private _setConnected(connected: boolean): void {
    this._onStateChange(connected);
  }
}