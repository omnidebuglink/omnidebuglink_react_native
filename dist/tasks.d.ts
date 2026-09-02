import { TaskRegistry } from './TaskRegistry';
export interface FindQuery {
    text?: string;
    type?: string;
    id?: number;
}
export interface FoundNode {
    id: number;
    type: string;
    text?: string;
    /** Absolute screen px, top-left origin */
    centerX: number;
    centerY: number;
    /** Normalized [0,1] — directly usable by tap_screen */
    nx: number;
    ny: number;
    /** "dialog" when the node lives in an overlay window (RN <Modal>) */
    window?: string;
}
export declare function registerBuiltinTasks(registry: TaskRegistry): void;
//# sourceMappingURL=tasks.d.ts.map