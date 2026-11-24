import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { createChatCompletion } from "../../packages/ai/dist/index.js";
import { readDesktopAiModelSettings } from "../../apps/cli/dist/model-settings.js";

const settings = await readDesktopAiModelSettings().catch(() => undefined);
const chat = settings?.chatModels.find((candidate) => candidate.enabled && candidate.id === settings.defaultChatModelId)
  ?? settings?.chatModels.find((candidate) => candidate.enabled);

if (!chat?.apiKey) {
  process.stderr.write("An enabled Chat model in encrypted desktop settings is required.\n");
  process.exitCode = 2;
} else {
  const endpoint = new URL(chat.baseURL);
  if (endpoint.protocol !== "https:" || endpoint.hostname !== "dashscope.aliyuncs.com") {
    process.stderr.write("This diagnostic is limited to the configured HTTPS DashScope host.\n");
    process.exitCode = 2;
  } else {
    const configuredPath = endpoint.pathname.replace(/\/+$/, "");
    endpoint.pathname = `${configuredPath}/__dbstudio_invalid_region_probe__`;
    const probeUrl = endpoint.toString();
    let failure;

    try {
      await createChatCompletion({ ...chat, baseURL: probeUrl, timeoutMs: 20_000 }, [
        { role: "user", content: "Synthetic endpoint diagnostic. Reply with one word." },
      ], { forceNonStreaming: true });
    } catch (error) {
      failure = error;
    }

    const status = failure instanceof Error ? Number(failure.message.match(/\bHTTP (\d{3})\b/)?.[1] ?? 0) : 0;
    const errorCode = failure && typeof failure === "object" && "code" in failure ? String(failure.code) : "unknown";
    assert.ok(failure instanceof Error, "The intentionally invalid endpoint should fail.");
    assert.equal(errorCode, "provider", "An HTTP endpoint rejection should retain the provider error classification.");
    assert.ok([400, 401, 403, 404, 405].includes(status), "The endpoint should return an HTTP client/configuration status.");
    assert.ok(!failure.message.includes(chat.apiKey), "The provider diagnostic must not expose the configured API key.");
    assert.ok(!/\bsk-[A-Za-z0-9_-]{12,}\b/.test(failure.message), "The provider diagnostic must not expose a token-shaped value.");

    const evidence = {
      date: "2026-11-17",
      scope: "live DashScope invalid-path endpoint diagnostic",
      ok: true,
      host: endpoint.hostname,
      configuredModelType: "Chat",
      errorCode,
      httpStatus: status,
      apiKeyTransmitted: true,
      apiKeyValueLogged: false,
      responseBodyLogged: false,
      payload: "synthetic one-sentence probe only",
      schemaSent: false,
      sourceConfigModified: false,
      endpointOverridePersisted: false,
    };
    await writeFile(".cache/ai-provider-endpoint-error-20261117.json", `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify(evidence)}\n`);
  }
}
