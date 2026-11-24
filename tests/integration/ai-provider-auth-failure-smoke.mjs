import { createChatCompletion, createEmbedding, rerank } from "../../packages/ai/dist/index.js";
import { readDesktopAiModelSettings } from "../../apps/cli/dist/model-settings.js";

const settings = await readDesktopAiModelSettings().catch(() => undefined);
const chat = settings?.chatModels.find((candidate) => candidate.enabled && candidate.id === settings.defaultChatModelId)
  ?? settings?.chatModels.find((candidate) => candidate.enabled);
const embedding = settings?.embedding?.enabled ? settings.embedding : undefined;
const rerankConfig = settings?.rerank?.enabled ? settings.rerank : undefined;

if (!chat || !embedding || !rerankConfig) {
  process.stderr.write("Enabled Chat, Embedding, and Rerank models are required in encrypted desktop settings.\n");
  process.exitCode = 2;
} else {
  const invalidKey = "sk-db-studio-invalid-auth-smoke";
  const timeoutMs = 30_000;

  async function verifyUnauthorized(label, apiKey, request) {
    let error;
    try {
      await request();
    } catch (value) {
      error = value;
    }

    if (!error || typeof error !== "object" || !(error instanceof Error) || !("code" in error) || error.code !== "provider") {
      throw new Error(`${label} did not classify the authentication failure as a provider error.`);
    }
    const status = error.message.match(/\bHTTP (\d{3})\b/)?.[1];
    if (status !== "401" && status !== "403") {
      throw new Error(`${label} did not return an authentication status.`);
    }
    if ((apiKey && error.message.includes(apiKey)) || error.message.includes(invalidKey)) {
      throw new Error(`${label} provider error exposed an API key.`);
    }
    return { ok: true, errorCode: "provider", httpStatus: Number(status), apiKeyRedacted: true };
  }

  async function verifyErrorCode(label, expectedCode, request, forbiddenValues = []) {
    let error;
    try {
      await request();
    } catch (value) {
      error = value;
    }

    if (!error || typeof error !== "object" || !(error instanceof Error) || !("code" in error) || error.code !== expectedCode) {
      throw new Error(`${label} did not return the expected ${expectedCode} error.`);
    }
    if (forbiddenValues.some((value) => value && error.message.includes(value))) {
      throw new Error(`${label} provider error exposed a sensitive value.`);
    }
    return { ok: true, errorCode: expectedCode, sensitiveValuesRedacted: true };
  }

  try {
    const chatResult = await verifyUnauthorized("Chat", chat.apiKey, () => createChatCompletion({
      ...chat, apiKey: invalidKey, timeoutMs,
    }, [{ role: "user", content: "Return one word for this synthetic authentication failure check." }], {
      forceNonStreaming: true,
    }));
    const embeddingResult = await verifyUnauthorized("Embedding", embedding.apiKey, () => createEmbedding({
      ...embedding, apiKey: invalidKey, timeoutMs,
    }, "synthetic embedding authentication failure check"));
    const rerankResult = await verifyUnauthorized("Rerank", rerankConfig.apiKey, () => rerank({
      ...rerankConfig, apiKey: invalidKey, timeoutMs,
    }, "synthetic rerank authentication check", ["synthetic schema description", "unrelated synthetic text"]));
    const invalidUrlResult = await verifyErrorCode("Unresolvable Base URL", "network", () => createChatCompletion({
      ...chat,
      baseURL: "https://db-studio-provider-smoke.invalid/compatible-mode/v1",
      apiKey: "",
      timeoutMs,
    }, [{ role: "user", content: "Synthetic request used to verify Base URL failure handling." }], {
      forceNonStreaming: true,
    }));
    const timeoutResult = await verifyErrorCode("Chat timeout", "timeout", () => createChatCompletion({
      ...chat, apiKey: invalidKey, timeoutMs: 1,
    }, [{ role: "user", content: "Synthetic request used to verify client timeout handling." }], {
      forceNonStreaming: true,
    }), [invalidKey, chat.apiKey]);

    process.stdout.write(`${JSON.stringify({
      ok: true,
      chat: chatResult,
      embedding: embeddingResult,
      rerank: rerankResult,
      unresolvableBaseUrl: invalidUrlResult,
      chatClientTimeout: timeoutResult,
      payload: "synthetic text only",
      realApiKeySent: false,
      responseBodyLogged: false,
    })}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message.slice(0, 180) : "authentication smoke failed",
      responseBodyLogged: false,
    })}\n`);
    process.exitCode = 1;
  }
}
