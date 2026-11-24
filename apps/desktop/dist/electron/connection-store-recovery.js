// RECONSTRUCTED from dist/electron/connection-store-recovery.js (tsc output of the lost source).
// @ts-nocheck -- temporary: original type annotations were not preserved in the build output.
import { copyFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
export class ConnectionStoreUnreadableError extends Error {
    constructor(message, options) {
        super(message, options);
        this.name = "ConnectionStoreUnreadableError";
    }
}
export function assertConnectionStoreShape(value) {
    if (!Array.isArray(value) || value.some((entry) => !entry || typeof entry !== "object" || Array.isArray(entry))) {
        throw new ConnectionStoreUnreadableError("连接配置解密后不是有效的连接列表。");
    }
}
export async function backupAndResetUnreadableConnectionStore(filePath, readStore, initializeStore, now = new Date()) {
    try {
        await readStore();
        throw new Error("连接配置当前可读取，请重试刷新；没有执行恢复。");
    }
    catch (error) {
        if (!(error instanceof ConnectionStoreUnreadableError))
            throw error;
    }
    const stamp = now.toISOString().replaceAll(":", "-").replaceAll(".", "-");
    let backupPath = "";
    for (let suffix = 0; suffix < 100; suffix += 1) {
        const suffixText = suffix === 0 ? "" : `-${suffix}`;
        const candidate = `${filePath}.unreadable-${stamp}${suffixText}.bak`;
        try {
            await copyFile(filePath, candidate, constants.COPYFILE_EXCL);
            backupPath = candidate;
            break;
        }
        catch (error) {
            if (error.code !== "EEXIST")
                throw error;
        }
    }
    if (!backupPath)
        throw new Error("无法为连接配置创建不覆盖现有文件的备份。");
    try {
        await initializeStore();
    }
    catch (error) {
        throw new Error(`新连接库初始化失败；原加密文件仍保留，备份副本位于 ${backupPath}。${error instanceof Error ? ` ${error.message}` : ""}`, { cause: error });
    }
    return backupPath;
}
//# sourceMappingURL=connection-store-recovery.js.map
//# sourceMappingURL=connection-store-recovery.js.map