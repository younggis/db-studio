import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createChatCompletion } from "../../packages/ai/dist/index.js";
import { readDesktopAiModelSettings } from "../../apps/cli/dist/model-settings.js";

const settings = await readDesktopAiModelSettings().catch(() => undefined);
const chat = settings?.chatModels.find((candidate) => candidate.enabled && candidate.id === settings.defaultChatModelId)
  ?? settings?.chatModels.find((candidate) => candidate.enabled);

if (!chat?.apiKey) {
  process.stderr.write("An enabled Chat model in encrypted desktop settings is required.\n");
  process.exitCode = 2;
} else {
  const configuredEndpoint = new URL(chat.baseURL);
  if (configuredEndpoint.protocol !== "https:" || configuredEndpoint.hostname !== "dashscope.aliyuncs.com") {
    process.stderr.write("This diagnostic requires the configured Beijing DashScope HTTPS endpoint.\n");
    process.exitCode = 2;
  } else {
    const probeEndpoint = new URL(configuredEndpoint);
    probeEndpoint.hostname = "dashscope-intl.aliyuncs.com";
    let failure;

    try {
      await createChatCompletion({ ...chat, baseURL: probeEndpoint.toString(), timeoutMs: 20_000 }, [
        { role: "user", content: "Synthetic region mismatch diagnostic. Reply with one word." },
      ], { forceNonStreaming: true });
    } catch (error) {
      failure = error;
    }

    const status = failure instanceof Error ? Number(failure.message.match(/\bHTTP (\d{3})\b/)?.[1] ?? 0) : 0;
    const errorCode = failure && typeof failure === "object" && "code" in failure ? String(failure.code) : "unknown";
    assert.ok(failure instanceof Error, "The region-mismatched endpoint should reject the configured API key.");
    assert.equal(status, 401, "A region-specific API-key rejection should return HTTP 401.");
    assert.equal(errorCode, "provider", "An HTTP authentication rejection should retain the provider error classification.");
    assert.ok(!failure.message.includes(chat.apiKey), "The provider diagnostic must not expose the configured API key.");
    assert.ok(!/\bsk-[A-Za-z0-9_-]{12,}\b/.test(failure.message), "The provider diagnostic must not expose a token-shaped value.");

    const evidence = {
      generatedAt: new Date().toISOString(),
      scope: "live DashScope region-mismatch diagnostic",
      ok: true,
      configuredRegionHost: configuredEndpoint.hostname,
      probeRegionHost: probeEndpoint.hostname,
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
    await mkdir(".cache", { recursive: true });
    await writeFile(".cache/ai-provider-region-mismatch-20261117.json", `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify(evidence)}\n`);
  }
}
