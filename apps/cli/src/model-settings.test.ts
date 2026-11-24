import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readDesktopAiModelSettings } from "./model-settings.js";

const settingsHeader = Buffer.from("DBSTUDIO\0AI-MODELS\0V1\0DPAPI\0", "utf8");
const directories: string[] = [];

async function testDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "dbstudio-cli-ai-settings-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("readDesktopAiModelSettings", () => {
  it("returns undefined when no desktop settings file exists", async () => {
    expect(await readDesktopAiModelSettings(await testDirectory())).toBeUndefined();
  });

  it("does not try to decrypt Electron safe-storage files in the CLI", async () => {
    const directory = await testDirectory();
    await writeFile(path.join(directory, "ai-models.enc"), Buffer.from("DBSTUDIO\0AI-MODELS\0V1\0SAFE-STORAGE\0", "utf8"));
    await expect(readDesktopAiModelSettings(directory)).rejects.toThrow("Electron safe storage");
  });

  it.skipIf(process.platform !== "win32")("reads Windows-encrypted settings for CLI model use", async () => {
    const directory = await testDirectory();
    const payload = JSON.stringify({
      enabled: true,
      defaultChatModelId: "test-model",
      chatModels: [{
        id: "test-model", name: "Synthetic model", provider: "openai-compatible",
        baseURL: "https://example.invalid/v1", model: "synthetic-model", apiKey: "synthetic-test-key",
        temperature: 0.2, maxOutputTokens: 128, timeoutMs: 1000, streaming: false, enabled: true,
      }],
    });
    const encrypted = await protectWithWindowsDpapi(Buffer.from(payload, "utf8"));
    await writeFile(path.join(directory, "ai-models.enc"), Buffer.concat([settingsHeader, encrypted]));

    const settings = await readDesktopAiModelSettings(directory);
    expect(settings?.defaultChatModelId).toBe("test-model");
    expect(settings?.chatModels[0]?.apiKey).toBe("synthetic-test-key");
    expect((await readFile(path.join(directory, "ai-models.enc"))).includes(Buffer.from("synthetic-test-key"))).toBe(false);
  }, 20_000);

  it.skipIf(process.platform !== "win32")("uses Electron's package-derived default userData path", async () => {
    const appData = await testDirectory();
    const userData = path.join(appData, "@db-studio", "desktop");
    const previousAppData = process.env.APPDATA;
    const previousOverride = process.env.DBSTUDIO_USER_DATA_DIR;
    await mkdir(userData, { recursive: true });
    const payload = JSON.stringify({
      enabled: true,
      defaultChatModelId: "default-path-model",
      chatModels: [{
        id: "default-path-model", name: "Synthetic model", provider: "openai-compatible",
        baseURL: "https://example.invalid/v1", model: "synthetic-model", apiKey: "synthetic-test-key", enabled: true,
      }],
    });
    await writeFile(path.join(userData, "ai-models.enc"), Buffer.concat([
      settingsHeader,
      await protectWithWindowsDpapi(Buffer.from(payload, "utf8")),
    ]));
    process.env.APPDATA = appData;
    delete process.env.DBSTUDIO_USER_DATA_DIR;
    try {
      const settings = await readDesktopAiModelSettings();
      expect(settings?.defaultChatModelId).toBe("default-path-model");
    } finally {
      if (previousAppData === undefined) delete process.env.APPDATA;
      else process.env.APPDATA = previousAppData;
      if (previousOverride === undefined) delete process.env.DBSTUDIO_USER_DATA_DIR;
      else process.env.DBSTUDIO_USER_DATA_DIR = previousOverride;
    }
  }, 20_000);
});

function protectWithWindowsDpapi(value: Buffer): Promise<Buffer> {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.Security",
    "$encoded = [Console]::In.ReadToEnd().Trim()",
    "$bytes = [Convert]::FromBase64String($encoded)",
    "$result = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)",
    "[Console]::Out.Write([Convert]::ToBase64String($result))",
  ].join("; ");
  const encodedScript = Buffer.from(script, "utf16le").toString("base64");
  const powershell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedScript], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "ignore"],
    });
    const output: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) {
        reject(new Error("Unable to create the synthetic DPAPI fixture."));
        return;
      }
      resolve(Buffer.from(Buffer.concat(output).toString("ascii").trim(), "base64"));
    });
    child.stdin.end(value.toString("base64"), "utf8");
  });
}
