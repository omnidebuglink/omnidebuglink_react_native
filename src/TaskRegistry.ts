/** Called when actionsEnabled=false and a write task is dispatched. */
const ACTION_DISABLED = 'ACTION_DISABLED';

/** Throw this to short-circuit a write task when actions are disabled. */
class ActionDisabledError extends Error {
  constructor() {
    super('write actions disabled (set actionsEnabled = true)');
    this.name = 'ActionDisabledError';
  }
}

export interface TaskEntry {
  handler: (payload: Record<string, unknown>) => Promise<unknown>;
  description?: string;
  payloadSchema?: Record<string, unknown>;
  /** true = write task; rejected when actionsEnabled=false */
  write?: boolean;
}

export class TaskRegistry {
  private readonly _tasks = new Map<string, TaskEntry>();
  private _onChanged: (() => void) | null = null;
  /** When true, write tasks throw ActionDisabledError; default true = writes allowed */
  private _actionsEnabled = true;

  set actionsEnabled(val: boolean) {
    const changed = this._actionsEnabled !== val;
    this._actionsEnabled = val;
    // Guide §5: takes effect on the next hello resend after the change
    if (changed) this._notifyChanged();
  }
  get actionsEnabled(): boolean {
    return this._actionsEnabled;
  }

  /** Called by the connection layer when the registry changes to re-send hello. */
  set onChanged(fn: (() => void) | null) {
    this._onChanged = fn;
  }

  register(
    taskType: string,
    handler: (payload: Record<string, unknown>) => Promise<unknown>,
    description?: string,
    payloadSchema?: Record<string, unknown>,
    options?: { write?: boolean },
  ): void {
    this._tasks.set(taskType, { handler, description, payloadSchema, write: options?.write ?? false });
    this._notifyChanged();
  }

  unregister(taskType: string): void {
    if (this._tasks.has(taskType)) {
      this._tasks.delete(taskType);
      this._notifyChanged();
    }
  }

  async run(
    requestId: string,
    taskType: string,
    payload: Record<string, unknown>,
  ): Promise<{ ok: boolean; result?: unknown; error?: { code: string; message: string } }> {
    const entry = this._tasks.get(taskType);
    if (!entry) {
      return {
        ok: false,
        error: { code: 'TASK_UNKNOWN', message: `no handler for "${taskType}"` },
      };
    }
    // Write tasks rejected when actionsEnabled=false
    if (entry.write && !this._actionsEnabled) {
      return { ok: false, error: { code: ACTION_DISABLED, message: 'write actions disabled' } };
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
        error: { code: 'TASK_FAILED', message: String(e) },
      };
    }
  }

  snapshot(): Array<{ type: string; description?: string; payloadSchema?: Record<string, unknown> }> {
    const out: Array<{ type: string; description?: string; payloadSchema?: Record<string, unknown> }> = [];
    for (const [type, entry] of this._tasks) {
      const spec: { type: string; description?: string; payloadSchema?: Record<string, unknown> } = { type };
      if (entry.description) spec.description = entry.description;
      if (entry.payloadSchema) spec.payloadSchema = entry.payloadSchema;
      out.push(spec);
    }
    return out;
  }

  private _notifyChanged(): void {
    // Coalesce bursts: registering N builtins at once fires N callbacks —
    // each would re-send hello over the wire. One zero-delay timer per burst.
    if (this._notifyScheduled) return;
    this._notifyScheduled = true;
    setTimeout(() => {
      this._notifyScheduled = false;
      this._onChanged?.();
    }, 0);
  }

  private _notifyScheduled = false;
}