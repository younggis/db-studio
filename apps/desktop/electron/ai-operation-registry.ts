// Reconstructed and refactored (phase 2.1): AI operations now use the shared
// OperationRegistry so cancellation, sender scoping and lifecycle are unified
// with GIS and table-transfer operations.
import { OperationRegistry, type OperationHandle } from "@db-studio/core";

export function registerAiOperation(
  operations: OperationRegistry,
  requestId: string,
  senderId: number,
  connectionId: string,
): OperationHandle {
  return operations.start({
    id: requestId,
    type: "ai-chat",
    senderId,
    connectionId,
  });
}

export function cancelAiOperation(operations: OperationRegistry, requestId: string, senderId: number): boolean {
  return operations.cancel(requestId, senderId);
}

export function handleAiCancellationRequest(operations: OperationRegistry, requestId: unknown, senderId: number): void {
  if (typeof requestId !== "string") return;
  cancelAiOperation(operations, requestId, senderId);
}

export function finishAiOperation(operations: OperationRegistry, requestId: string, operation: OperationHandle): boolean {
  return operations.finish(requestId, operation);
}

export function throwIfAiOperationCancelled(operation: OperationHandle): void {
  if (operation.controller.signal.aborted) throw new Error("AI 请求已取消。");
}
