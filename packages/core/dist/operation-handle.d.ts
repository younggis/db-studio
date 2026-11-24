export type OperationType = "gis-import" | "gis-export" | "ai-chat" | "ai-schema-index" | "ai-mongo" | "table-transfer";
export interface OperationHandle {
    readonly id: string;
    readonly type: OperationType;
    readonly senderId: number;
    readonly connectionId?: string;
    readonly controller: AbortController;
    readonly startedAt: number;
    status: "running" | "cancelling" | "completed" | "failed" | "rolled-back";
    progress?: number;
    detail?: string;
}
export interface OperationRegistryOptions {
    now?: () => number;
    onCancel?: (operation: OperationHandle) => void;
}
export declare class OperationRegistry {
    private readonly operations;
    private readonly now;
    private readonly onCancel?;
    constructor(options?: OperationRegistryOptions);
    start(input: {
        id: string;
        type: OperationType;
        senderId: number;
        connectionId?: string;
        signal?: AbortSignal;
    }): OperationHandle;
    get(id: string): OperationHandle | undefined;
    has(id: string): boolean;
    get size(): number;
    /** Cancel only when the caller owns the operation (sender id must match). */
    cancel(id: string, senderId: number): boolean;
    /** Cancel everything belonging to a connection (used on delete/switch/tunnel loss). */
    cancelByConnection(connectionId: string): OperationHandle[];
    cancelBySender(senderId: number): OperationHandle[];
    /** Finish only if the stored handle is still the one passed in (stale guard). */
    finish(id: string, handle: OperationHandle, status?: "completed" | "failed" | "rolled-back"): boolean;
    throwIfCancelled(handle: OperationHandle): void;
    list(): OperationHandle[];
}
//# sourceMappingURL=operation-handle.d.ts.map