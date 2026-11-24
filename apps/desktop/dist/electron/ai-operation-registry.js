// Reconstructed and refactored (phase 2.1): AI operations now use the shared
// OperationRegistry so cancellation, sender scoping and lifecycle are unified
// with GIS and table-transfer operations.
import { OperationRegistry } from "@db-studio/core";
export function registerAiOperation(operations, requestId, senderId, connectionId) {
    return operations.start({
        id: requestId,
        type: "ai-chat",
        senderId,
        connectionId,
    });
}
export function cancelAiOperation(operations, requestId, senderId) {
    return operations.cancel(requestId, senderId);
}
export function handleAiCancellationRequest(operations, requestId, senderId) {
    if (typeof requestId !== "string")
        return;
    cancelAiOperation(operations, requestId, senderId);
}
export function finishAiOperation(operations, requestId, operation) {
    return operations.finish(requestId, operation);
}
export function throwIfAiOperationCancelled(operation) {
    if (operation.controller.signal.aborted)
        throw new Error("AI 请求已取消。");
}
//# sourceMappingURL=ai-operation-registry.js.map