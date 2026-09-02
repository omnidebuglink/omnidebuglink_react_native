/**
 * Ring-buffer log capture.
 *
 * Patches console.log/info/warn/error on install and captures JS global
 * errors via ErrorUtils.setGlobalHandler, keeping the last MAX_LINES
 * entries. The SDK's own onLog output is also pushed here, so read_logs
 * surfaces app logs, crashes (red-screen) and connection lifecycle events
 * (reconnects, 4000 replacement, watchdog drops).
 */
export interface LogEntry {
    ts: number;
    level: string;
    text: string;
}
export interface ReadLogsFilter {
    count?: number;
    tail?: boolean;
    level?: string;
    contains?: string;
    sinceMs?: number;
}
export declare function pushLog(level: string, text: string): void;
export declare function readLogs(filter: ReadLogsFilter): {
    lines: string[];
    total: number;
    matched: number;
};
export declare function installLogCapture(): void;
/** Capture RN global JS errors (red-screen / fatal) into the buffer. */
export declare function installErrorCapture(): void;
//# sourceMappingURL=log-buffer.d.ts.map