// Phase 2.1: unified task lifecycle shared by GIS, AI and other cancellable
// operations. One registry owns IDs, sender scoping, connection ownership and
// abort state; the main process only wires IPC handlers to these methods.

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

export class OperationRegistry {
  private readonly operations = new Map<string, OperationHandle>();
  private readonly now: () => number;
  private readonly onCancel?: (operation: OperationHandle) => void;

  constructor(options: OperationRegistryOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.onCancel = options.onCancel;
  }

  start(input: {
    id: string;
    type: OperationType;
    senderId: number;
    connectionId?: string;
    signal?: AbortSignal;
  }): OperationHandle {
    if (!input.id || this.operations.has(input.id)) {
      throw new Error(`任务标识已在使用中：${input.id}`);
    }
    if (input.signal?.aborted) throw new Error("任务在开始前已被取消。");
    const handle: OperationHandle = {
      id: input.id,
      type: input.type,
      senderId: input.senderId,
      connectionId: input.connectionId,
      controller: new AbortController(),
      startedAt: this.now(),
      status: "running",
    };
    this.operations.set(input.id, handle);
    return handle;
  }

  get(id: string): OperationHandle | undefined {
    return this.operations.get(id);
  }

  has(id: string): boolean {
    return this.operations.has(id);
  }

  get size(): number {
    return this.operations.size;
  }

  /** Cancel only when the caller owns the operation (sender id must match). */
  cancel(id: string, senderId: number): boolean {
    const handle = this.operations.get(id);
    if (!handle || handle.senderId !== senderId || handle.status === "cancelling") return false;
    handle.status = "cancelling";
    handle.controller.abort();
    this.onCancel?.(handle);
    return true;
  }

  /** Cancel everything belonging to a connection (used on delete/switch/tunnel loss). */
  cancelByConnection(connectionId: string): OperationHandle[] {
    const affected: OperationHandle[] = [];
    for (const handle of this.operations.values()) {
      if (handle.connectionId !== connectionId || handle.status === "cancelling") continue;
      handle.status = "cancelling";
      handle.controller.abort();
      this.onCancel?.(handle);
      affected.push(handle);
    }
    return affected;
  }

  cancelBySender(senderId: number): OperationHandle[] {
    const affected: OperationHandle[] = [];
    for (const handle of this.operations.values()) {
      if (handle.senderId !== senderId || handle.status === "cancelling") continue;
      handle.status = "cancelling";
      handle.controller.abort();
      this.onCancel?.(handle);
      affected.push(handle);
    }
    return affected;
  }

  /** Finish only if the stored handle is still the one passed in (stale guard). */
  finish(id: string, handle: OperationHandle, status: "completed" | "failed" | "rolled-back" = "completed"): boolean {
    if (this.operations.get(id) !== handle) return false;
    handle.status = status;
    this.operations.delete(id);
    return true;
  }

  throwIfCancelled(handle: OperationHandle): void {
    if (handle.controller.signal.aborted) throw new Error("任务已取消。");
  }

  list(): OperationHandle[] {
    return [...this.operations.values()];
  }
}
