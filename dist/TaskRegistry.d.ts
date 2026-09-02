export interface TaskEntry {
    handler: (payload: Record<string, unknown>) => Promise<unknown>;
    description?: string;
    payloadSchema?: Record<string, unknown>;
    /** true = write task; rejected when actionsEnabled=false */
    write?: boolean;
}
export declare class TaskRegistry {
    private readonly _tasks;
    private _onChanged;
    /** When true, write tasks throw ActionDisabledError; default true = writes allowed */
    private _actionsEnabled;
    set actionsEnabled(val: boolean);
    get actionsEnabled(): boolean;
    /** Called by the connection layer when the registry changes to re-send hello. */
    set onChanged(fn: (() => void) | null);
    register(taskType: string, handler: (payload: Record<string, unknown>) => Promise<unknown>, description?: string, payloadSchema?: Record<string, unknown>, options?: {
        write?: boolean;
    }): void;
    unregister(taskType: string): void;
    run(requestId: string, taskType: string, payload: Record<string, unknown>): Promise<{
        ok: boolean;
        result?: unknown;
        error?: {
            code: string;
            message: string;
        };
    }>;
    snapshot(): Array<{
        type: string;
        description?: string;
        payloadSchema?: Record<string, unknown>;
    }>;
    private _notifyChanged;
    private _notifyScheduled;
}
//# sourceMappingURL=TaskRegistry.d.ts.map