export declare class ConnectionStoreUnreadableError extends Error {
    constructor(message: any, options: any);
}
export declare function assertConnectionStoreShape(value: any): void;
export declare function backupAndResetUnreadableConnectionStore(filePath: any, readStore: any, initializeStore: any, now?: Date): Promise<string>;
//# sourceMappingURL=connection-store-recovery.d.ts.map