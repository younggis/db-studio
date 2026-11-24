import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
const settingsHeader = Buffer.from("DBSTUDIO\0AI-MODELS\0V1\0", "utf8");
const dpapiHeader = Buffer.concat([settingsHeader, Buffer.from("DPAPI\0", "ascii")]);
const safeStorageHeader = Buffer.concat([settingsHeader, Buffer.from("SAFE-STORAGE\0", "ascii")]);
export async function readDesktopAiModelSettings(userDataDir = defaultUserDataDir()) {
    if (!userDataDir)
        return undefined;
    let encrypted;
    try {
        encrypted = await readFile(path.join(userDataDir, "ai-models.enc"));
    }
    catch (error) {
        if (error.code === "ENOENT")
            return undefined;
        throw error;
    }
    if (encrypted.length > 2 * 1024 * 1024)
        throw new Error("Desktop AI model settings exceed the secure storage limit.");
    if (encrypted.subarray(0, dpapiHeader.length).equals(dpapiHeader)) {
        if (process.platform !== "win32")
            throw new Error("Desktop AI model settings use Windows DPAPI and can only be read on Windows.");
    }
    else if (encrypted.subarray(0, safeStorageHeader.length).equals(safeStorageHeader)) {
        throw new Error("Desktop AI model settings use Electron safe storage; configure AI model environment variables for CLI use.");
    }
    else {
        throw new Error("Desktop AI model settings have an unsupported format.");
    }
    const plaintext = await unprotectWithWindowsDpapi(encrypted.subarray(dpapiHeader.length));
    let value;
    try {
        value = JSON.parse(plaintext.toString("utf8"));
    }
    catch {
        throw new Error("Desktop AI model settings contain invalid JSON.");
    }
    if (!Array.isArray(value.chatModels))
        throw new Error("Desktop AI model settings have an invalid format.");
    const chatModels = value.chatModels.filter(isChatModel);
    const embedding = isEmbeddingModel(value.embedding) ? value.embedding : undefined;
    const rerank = isRerankModel(value.rerank) ? value.rerank : undefined;
    return {
        enabled: value.enabled === true,
        chatModels,
        defaultChatModelId: typeof value.defaultChatModelId === "string" ? value.defaultChatModelId : undefined,
        embedding,
        rerank,
    };
}
function defaultUserDataDir() {
    const configured = process.env.DBSTUDIO_USER_DATA_DIR?.trim();
    if (configured)
        return path.resolve(configured);
    if (process.platform !== "win32")
        return undefined;
    const appData = process.env.APPDATA || path.join(homedir(), "AppData", "Roaming");
    // Electron derives userData from this package name unless DBSTUDIO_USER_DATA_DIR overrides it.
    return path.join(appData, "@db-studio", "desktop");
}
function isChatModel(value) {
    if (!value || typeof value !== "object")
        return false;
    const model = value;
    return typeof model.id === "string" && typeof model.name === "string" && typeof model.baseURL === "string"
        && typeof model.model === "string" && typeof model.apiKey === "string";
}
function isEmbeddingModel(value) {
    if (!value || typeof value !== "object")
        return false;
    const model = value;
    return typeof model.baseURL === "string" && typeof model.model === "string" && typeof model.apiKey === "string";
}
function isRerankModel(value) {
    if (!value || typeof value !== "object")
        return false;
    const model = value;
    return typeof model.baseURL === "string" && typeof model.model === "string" && typeof model.apiKey === "string";
}
function unprotectWithWindowsDpapi(value) {
    if (process.platform !== "win32")
        return Promise.reject(new Error("Windows DPAPI is only available on Windows."));
    const script = [
        "$ErrorActionPreference = 'Stop'",
        "Add-Type -AssemblyName System.Security",
        "$encoded = [Console]::In.ReadToEnd().Trim()",
        "$bytes = [Convert]::FromBase64String($encoded)",
        "$result = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)",
        "[Console]::Out.Write([Convert]::ToBase64String($result))",
    ].join("; ");
    const encodedScript = Buffer.from(script, "utf16le").toString("base64");
    const powershell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    return new Promise((resolve, reject) => {
        const child = spawn(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedScript], {
            windowsHide: true,
            stdio: ["pipe", "pipe", "ignore"],
        });
        const output = [];
        let outputLength = 0;
        let settled = false;
        let timer;
        const fail = (error) => {
            if (settled)
                return;
            settled = true;
            if (timer)
                clearTimeout(timer);
            child.kill();
            reject(error);
        };
        child.stdout.on("data", (chunk) => {
            outputLength += chunk.length;
            if (outputLength > 4 * 1024 * 1024) {
                fail(new Error("Windows secure storage returned an oversized result."));
                return;
            }
            output.push(chunk);
        });
        child.once("error", () => fail(new Error("Could not start Windows secure storage.")));
        child.once("close", (code) => {
            if (settled)
                return;
            settled = true;
            if (timer)
                clearTimeout(timer);
            if (code !== 0) {
                reject(new Error("Windows secure storage could not decrypt desktop AI settings."));
                return;
            }
            const encoded = Buffer.concat(output).toString("ascii").trim();
            if (!encoded || encoded.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(encoded)) {
                reject(new Error("Windows secure storage returned invalid data."));
                return;
            }
            const plaintext = Buffer.from(encoded, "base64");
            if (!plaintext.length) {
                reject(new Error("Windows secure storage returned empty data."));
                return;
            }
            resolve(plaintext);
        });
        child.stdin.once("error", () => fail(new Error("Could not send data to Windows secure storage.")));
        child.stdin.end(value.toString("base64"), "utf8");
        timer = setTimeout(() => fail(new Error("Windows secure storage operation timed out.")), 15_000);
        timer.unref();
    });
}
//# sourceMappingURL=model-settings.js.map