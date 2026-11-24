export interface ActiveAiOperation {
    senderId: number;
    connectionId: string;
    controller: AbortController;
}
export declare function registerAiOperation(operations: Map<string, ActiveAiOperation>, requestId: string, senderId: number, connectionId: string): ActiveAiOperation;
export declare function cancelAiOperation(operations: Map<string, ActiveAiOperation>, requestId: string, senderId: number): void;
export declare function handleAiCancellationRequest(operations: Map<string, ActiveAiOperation>, requestId: unknown, senderId: number): void;
export declare function finishAiOperation(operations: Map<string, ActiveAiOperation>, requestId: string, operation: ActiveAiOperation): void;
export declare function throwIfAiOperationCancelled(operation: ActiveAiOperation): void;
//# sourceMappingURL=ai-operation-registry.d.ts.map