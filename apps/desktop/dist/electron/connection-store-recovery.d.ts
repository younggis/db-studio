export declare class ConnectionStoreUnreadableError extends Error {
    constructor(message: string, options?: ErrorOptions);
}
export declare function assertConnectionStoreShape(value: unknown): asserts value is Record<string, unknown>[];
export declare function backupAndResetUnreadableConnectionStore(filePath: string, readStore: () => Promise<unknown>, initializeStore: () => Promise<void>, now?: Date): Promise<string>;
//# sourceMappingURL=connection-store-recovery.d.ts.map