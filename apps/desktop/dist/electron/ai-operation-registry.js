export function registerAiOperation(operations, requestId, senderId, connectionId) {
    if (operations.has(requestId))
        throw new Error("该 AI 请求标识已在使用中。");
    const operation = { senderId, connectionId, controller: new AbortController() };
    operations.set(requestId, operation);
    return operation;
}
export function cancelAiOperation(operations, requestId, senderId) {
    const operation = operations.get(requestId);
    if (operation?.senderId === senderId)
        operation.controller.abort();
}
export function handleAiCancellationRequest(operations, requestId, senderId) {
    if (typeof requestId !== "string")
        return;
    cancelAiOperation(operations, requestId, senderId);
}
export function finishAiOperation(operations, requestId, operation) {
    if (operations.get(requestId) === operation)
        operations.delete(requestId);
}
export function throwIfAiOperationCancelled(operation) {
    if (operation.controller.signal.aborted)
        throw new Error("AI 请求已取消。");
}
//# sourceMappingURL=ai-operation-registry.js.map