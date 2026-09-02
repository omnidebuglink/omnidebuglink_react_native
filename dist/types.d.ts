/** All frames carry v: 1 at the top level. */
export interface Frame {
    v: 1;
    type: string;
}
export interface HelloFrame extends Frame {
    type: 'hello';
    client: ClientInfo;
    tasks: TaskSpec[];
}
export interface ClientInfo {
    platform: string;
    version?: string;
    libVersion: string;
    actionsEnabled: boolean;
}
export interface TaskSpec {
    type: string;
    description?: string;
    payloadSchema?: Record<string, unknown>;
}
export interface TaskFrame extends Frame {
    type: 'task';
    requestId: string;
    task: {
        type: string;
        payload?: Record<string, unknown>;
    };
    timeoutMs?: number;
}
export interface ResultFrame {
    v: 1;
    type: 'result';
    requestId: string;
    ok: boolean;
    result?: unknown;
    error?: {
        code: string;
        message: string;
    };
}
export interface PingFrame extends Frame {
    type: 'ping';
}
export interface PongFrame extends Frame {
    type: 'pong';
}
export type ClientMessage = HelloFrame | PingFrame | ResultFrame;
export type ServerMessage = TaskFrame | PongFrame;
export type LogCallback = (msg: string) => void;
export type StateCallback = (connected: boolean) => void;
export declare const CLOSE_CODE_REPLACED = 4000;
export declare const CLOSE_CODE_PAYLOAD_TOO_LARGE = 1009;
/** Node in the ui_traverse dump. Coordinates are absolute screen px, top-left origin. */
export interface OmlNode {
    /** React tag (RN views) or native view id — usable as ui_click/input_text fieldId */
    id: number;
    type: string;
    text?: string;
    hint?: string;
    desc?: string;
    clickable?: boolean;
    disabled?: boolean;
    x: number;
    y: number;
    width: number;
    height: number;
    children?: OmlNode[];
    truncated?: boolean;
}
export interface OmlScreenshotResult {
    /** Pixels */
    width: number;
    height: number;
    /** base64 JPEG */
    data: string;
}
export interface OmlTreeResult {
    /** Window size in the same unit as node x/y (Android px / iOS pt) */
    windowWidth: number;
    windowHeight: number;
    root: OmlNode;
}
export interface OmlStateResult {
    screen: {
        width: number;
        height: number;
        scale?: number;
        density?: number;
    };
    network: {
        connected: boolean;
        type: string;
    };
    /** Android: activity class names, bottom → top */
    activities?: string[];
    /** iOS: flattened view-controller stack */
    viewControllers?: string[];
}
export interface OmlPerfResult {
    fps: {
        fps: number;
        sampledFrames: number;
        frameMs?: {
            p50: number;
            p95: number;
            p99: number;
        };
        /** present when 0 frames sampled (idle screen) */
        hint?: string;
    };
    /** Platform-specific memory fields (Android: javaHeap/pss/native; iOS: resident/available/physical) */
    memory: Record<string, number>;
    threads?: number;
}
export interface OmlPrefsEntry {
    value: unknown;
    valueType: 'string' | 'int' | 'long' | 'float' | 'bool';
}
export interface OmlNativeModule {
    /** Inbound x/y are normalized [0,1], top-left origin. */
    screenshot(): Promise<OmlScreenshotResult>;
    uiTree(): Promise<OmlTreeResult>;
    tap(x: number, y: number): Promise<void>;
    longPress(x: number, y: number, durationMs: number): Promise<void>;
    swipe(x1: number, y1: number, x2: number, y2: number, durationMs: number): Promise<void>;
    clickView(fieldId: number): Promise<boolean>;
    inputText(fieldId: number, text: string): Promise<void>;
    /** key: 'back'|'home'|'recents' (Android) / 'enter'|'escape'|'backspace'|'tab'|'space' (iOS) */
    sendKey(key: string): Promise<boolean>;
    getState(): Promise<OmlStateResult>;
    getPerf(): Promise<OmlPerfResult>;
    viewComponent(fieldId: number): Promise<Record<string, unknown>>;
    prefsGet(key: string): Promise<OmlPrefsEntry | null>;
    prefsSet(opts: {
        key: string;
        value: unknown;
        valueType: string;
    }): Promise<void>;
    prefsDelete(key: string): Promise<boolean>;
    prefsList(): Promise<{
        entries: Record<string, OmlPrefsEntry>;
    }>;
}
//# sourceMappingURL=types.d.ts.map