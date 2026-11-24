import { OperationRegistry, type OperationHandle } from "@db-studio/core";
export declare function registerAiOperation(operations: OperationRegistry, requestId: string, senderId: number, connectionId: string): OperationHandle;
export declare function cancelAiOperation(operations: OperationRegistry, requestId: string, senderId: number): boolean;
export declare function handleAiCancellationRequest(operations: OperationRegistry, requestId: unknown, senderId: number): void;
export declare function finishAiOperation(operations: OperationRegistry, requestId: string, operation: OperationHandle): boolean;
export declare function throwIfAiOperationCancelled(operation: OperationHandle): void;
//# sourceMappingURL=ai-operation-registry.d.ts.map