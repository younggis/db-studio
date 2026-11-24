// Phase 2.1: unified task lifecycle shared by GIS, AI and other cancellable
// operations. One registry owns IDs, sender scoping, connection ownership and
// abort state; the main process only wires IPC handlers to these methods.
export class OperationRegistry {
    operations = new Map();
    now;
    onCancel;
    constructor(options = {}) {
        this.now = options.now ?? (() => Date.now());
        this.onCancel = options.onCancel;
    }
    start(input) {
        if (!input.id || this.operations.has(input.id)) {
            throw new Error(`任务标识已在使用中：${input.id}`);
        }
        if (input.signal?.aborted)
            throw new Error("任务在开始前已被取消。");
        const handle = {
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
    get(id) {
        return this.operations.get(id);
    }
    has(id) {
        return this.operations.has(id);
    }
    get size() {
        return this.operations.size;
    }
    /** Cancel only when the caller owns the operation (sender id must match). */
    cancel(id, senderId) {
        const handle = this.operations.get(id);
        if (!handle || handle.senderId !== senderId || handle.status === "cancelling")
            return false;
        handle.status = "cancelling";
        handle.controller.abort();
        this.onCancel?.(handle);
        return true;
    }
    /** Cancel everything belonging to a connection (used on delete/switch/tunnel loss). */
    cancelByConnection(connectionId) {
        const affected = [];
        for (const handle of this.operations.values()) {
            if (handle.connectionId !== connectionId || handle.status === "cancelling")
                continue;
            handle.status = "cancelling";
            handle.controller.abort();
            this.onCancel?.(handle);
            affected.push(handle);
        }
        return affected;
    }
    cancelBySender(senderId) {
        const affected = [];
        for (const handle of this.operations.values()) {
            if (handle.senderId !== senderId || handle.status === "cancelling")
                continue;
            handle.status = "cancelling";
            handle.controller.abort();
            this.onCancel?.(handle);
            affected.push(handle);
        }
        return affected;
    }
    /** Finish only if the stored handle is still the one passed in (stale guard). */
    finish(id, handle, status = "completed") {
        if (this.operations.get(id) !== handle)
            return false;
        handle.status = status;
        this.operations.delete(id);
        return true;
    }
    throwIfCancelled(handle) {
        if (handle.controller.signal.aborted)
            throw new Error("任务已取消。");
    }
    list() {
        return [...this.operations.values()];
    }
}
//# sourceMappingURL=operation-handle.js.map