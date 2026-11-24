export declare function registerAiOperation(operations: any, requestId: any, senderId: any, connectionId: any): {
    senderId: any;
    connectionId: any;
    controller: AbortController;
};
export declare function cancelAiOperation(operations: any, requestId: any, senderId: any): void;
export declare function handleAiCancellationRequest(operations: any, requestId: any, senderId: any): void;
export declare function finishAiOperation(operations: any, requestId: any, operation: any): void;
export declare function throwIfAiOperationCancelled(operation: any): void;
//# sourceMappingURL=ai-operation-registry.d.ts.map