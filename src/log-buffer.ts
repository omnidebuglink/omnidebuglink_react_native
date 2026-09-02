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

const MAX_LINES = 500;

const buffer: LogEntry[] = [];
let consoleInstalled = false;
let errorInstalled = false;

export function pushLog(level: string, text: string): void {
  buffer.push({ ts: Date.now(), level, text });
  if (buffer.length > MAX_LINES) {
    buffer.splice(0, buffer.length - MAX_LINES);
  }
}

export function readLogs(filter: ReadLogsFilter): { lines: string[]; total: number; matched: number } {
  const count = Math.max(1, Math.min(500, filter.count ?? 50));
  const tail = filter.tail !== false;
  let entries = buffer;
  if (filter.level) {
    const lv = filter.level.toLowerCase();
    entries = entries.filter((e) => e.level === lv || (lv === 'warn' && e.level === 'warning'));
  }
  if (filter.contains) {
    const needle = filter.contains.toLowerCase();
    entries = entries.filter((e) => e.text.toLowerCase().includes(needle));
  }
  if (typeof filter.sinceMs === 'number') {
    entries = entries.filter((e) => e.ts >= filter.sinceMs!);
  }
  const slice = tail ? entries.slice(-count) : entries.slice(0, count);
  const lines = slice.map((e) => `${new Date(e.ts).toISOString()} [${e.level}] ${e.text}`);
  return { lines, total: buffer.length, matched: entries.length };
}

export function installLogCapture(): void {
  if (consoleInstalled) return;
  consoleInstalled = true;

  const wrap = (level: string, orig: (...args: unknown[]) => void) => {
    return (...args: unknown[]) => {
      pushLog(level, args.map(fmt).join(' '));
      orig(...args);
    };
  };

  console.log = wrap('log', console.log.bind(console));
  console.info = wrap('info', console.info.bind(console));
  console.warn = wrap('warn', console.warn.bind(console));
  console.error = wrap('error', console.error.bind(console));
}

/** Capture RN global JS errors (red-screen / fatal) into the buffer. */
export function installErrorCapture(): void {
  if (errorInstalled) return;
  errorInstalled = true;
  // RN injects ErrorUtils into the JS global scope (not in any lib .d.ts)
  const g = globalThis as unknown as {
    ErrorUtils?: {
      getGlobalHandler?: () => (e: unknown, isFatal?: boolean) => void;
      setGlobalHandler?: (fn: (e: unknown, isFatal?: boolean) => void) => void;
    };
  };
  const eu = g.ErrorUtils;
  if (!eu?.setGlobalHandler) return;
  const prev = eu.getGlobalHandler?.();
  eu.setGlobalHandler((e, isFatal) => {
    const err = e as Error | undefined;
    pushLog('error', `${isFatal ? 'FATAL ' : ''}${err?.stack ?? String(e)}`);
    prev?.(e, isFatal);
  });
}

function fmt(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v instanceof Error) return `${v.name}: ${v.message}`;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
