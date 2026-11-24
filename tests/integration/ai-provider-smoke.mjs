import assert from "node:assert/strict";
import { runSqlAssistant, createEmbedding, rerank } from "../../packages/ai/dist/index.js";
import { readDesktopAiModelSettings } from "../../apps/cli/dist/model-settings.js";

const settings = await readDesktopAiModelSettings().catch(() => undefined);
const environmentChatKey = process.env.MODEL_OPENAI_API_KEY || process.env.DASHSCOPE_API_KEY;
const configuredChat = settings?.chatModels.find((item) => item.id === settings.defaultChatModelId && item.enabled)
  ?? settings?.chatModels.find((item) => item.enabled);
const chat = configuredChat ?? (environmentChatKey ? {
  id: "provider-smoke", name: "provider smoke", provider: "openai-compatible", enabled: true,
  baseURL: process.env.MODEL_OPENAI_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1",
  model: process.env.MODEL_OPENAI_MODEL || "qwen3.6-flash", apiKey: environmentChatKey,
} : undefined);
const embedding = settings?.embedding?.enabled ? settings.embedding : environmentChatKey ? {
  provider: "dashscope", baseURL: process.env.MODEL_EMBEDDING_BASE_URL || process.env.MODEL_OPENAI_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1",
  model: process.env.MODEL_EMBEDDING_MODEL || "text-embedding-v4",
  apiKey: process.env.MODEL_EMBEDDING_API_KEY || environmentChatKey, enabled: true,
} : undefined;
const rerankConfig = settings?.rerank?.enabled ? settings.rerank : environmentChatKey ? {
  provider: "dashscope", baseURL: process.env.MODEL_RERANK_BASE_URL || process.env.MODEL_OPENAI_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1",
  model: process.env.MODEL_RERANK_MODEL || "gte-rerank-v2",
  apiKey: process.env.MODEL_RERANK_API_KEY || environmentChatKey, enabled: true,
} : undefined;
const secrets = [chat?.apiKey, embedding?.apiKey, rerankConfig?.apiKey].filter((value) => typeof value === "string" && value);
if (!chat || !embedding || !rerankConfig) {
  process.stderr.write("Chat, Embedding, and Rerank must be configured in encrypted desktop settings or process environment.\n");
  process.exitCode = 2;
} else {
  const timeoutMs = 45_000;
  let stage = "chat-generation";
  try {
    const response = await runSqlAssistant(chat, {
      task: "generate",
      request: "列出每条记录的 label 和 id，按 id 升序。只查询 public.ai_smoke_places。",
      context: {
        engine: "postgres", serverVersion: "16", database: "ai_provider_smoke", schema: "public",
        tables: [{ schema: "public", name: "ai_smoke_places", type: "table", columns: [
          { name: "id", dataType: "integer", nullable: false, primaryKey: true },
          { name: "label", dataType: "text", nullable: false, primaryKey: false },
        ] }],
      },
    });
    assert.equal(response.result.task, "generate");
    assert.ok(response.result.sql, "The configured Chat model should return a SQL draft.");
    assert.equal(response.validation?.valid, true, "The generated SQL must pass the read-only/schema validator.");
    assert.ok(response.result.referencedObjects?.some((value) => value.toLowerCase().includes("ai_smoke_places"))
      || /\bai_smoke_places\b/i.test(response.result.sql), "The generated draft must reference the synthetic test table.");

    stage = "chat-repair";
    const repaired = await runSqlAssistant(chat, {
      task: "repair",
      request: "修正 PostgreSQL 方言错误，保留只返回一条 id 记录的意图。",
      context: {
        engine: "postgres", serverVersion: "16", database: "synthetic", schema: "public",
        tables: [{ schema: "public", name: "ai_smoke_places", type: "table", columns: [
          { name: "id", dataType: "integer", nullable: false, primaryKey: true },
          { name: "label", dataType: "text", nullable: false, primaryKey: false },
        ] }],
        selectedSql: "SELECT TOP 1 id FROM public.ai_smoke_places",
        error: { code: "42601", message: 'syntax error at or near "1"' },
      },
    });
    assert.equal(repaired.result.task, "repair");
    assert.ok(repaired.result.sql, "The configured Chat model should return a repaired SQL draft.");
    assert.equal(repaired.validation?.valid, true, "The repaired SQL must pass the read-only/schema validator.");
    assert.ok(/\bid\b/i.test(repaired.result.sql) && /\bai_smoke_places\b/i.test(repaired.result.sql));
    assert.ok(!/\bTOP\b/i.test(repaired.result.sql), "The repaired PostgreSQL query must not retain SQL Server TOP syntax.");

    stage = "chat-optimization-contract";
    const optimized = await runSqlAssistant({ ...chat, timeoutMs }, {
      task: "optimize",
      request: "检查该查询并给出保守的静态优化建议。没有执行计划时不得断言更快。",
      context: {
        engine: "postgres", serverVersion: "16", database: "synthetic", schema: "public",
        tables: [{ schema: "public", name: "ai_smoke_places", type: "table", columns: [
          { name: "id", dataType: "integer", nullable: false, primaryKey: true },
          { name: "label", dataType: "text", nullable: false, primaryKey: false },
        ] }],
        selectedSql: "SELECT id FROM public.ai_smoke_places WHERE id > 0",
      },
    });
    assert.equal(optimized.result.task, "optimize");
    assert.ok(optimized.result.explanation.trim(), "The configured Chat model should return an optimization explanation.");
    assert.equal(optimized.result.sql, undefined, "Static optimization must not expose a SQL draft field.");
    assert.equal(optimized.validation, undefined, "Static optimization must not trigger SQL draft validation.");

    stage = "embedding";
    const vectors = await createEmbedding({ ...embedding, timeoutMs }, "synthetic schema provider smoke");
    assert.equal(vectors.length, 1);
    assert.ok(vectors[0].length > 0);

    stage = "rerank";
    const ranking = await rerank({ ...rerankConfig, timeoutMs }, "database schema and table columns", [
      "public.ai_smoke_places is a synthetic table with id and label columns",
      "A weather forecast describes tomorrow's temperature and rainfall",
    ]);
    assert.equal(ranking[0]?.index, 0, "The synthetic schema document should rank above an unrelated document.");

    process.stdout.write(`${JSON.stringify({
      chat: { ok: true, task: response.result.task, validatedReadOnly: response.validation.valid },
      chatRepair: { ok: true, task: repaired.result.task, validatedReadOnly: repaired.validation.valid },
      chatOptimizationContract: { ok: true, hasSqlField: false, hasValidation: false },
      embedding: { ok: true, dimensions: vectors[0].length },
      rerank: { ok: true, documents: 2, firstResultIndex: ranking[0].index },
      schemaSent: "synthetic only",
    })}\n`);
  } catch (error) {
    const kind = error && typeof error === "object" && "kind" in error ? String(error.kind) : "request";
    let message = String(error instanceof Error ? error.message : "request failed");
    for (const secret of secrets) message = message.replaceAll(secret, "[redacted]");
    message = message.replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[redacted]").slice(0, 240);
    process.stderr.write(`${JSON.stringify({ stage, ok: false, errorKind: kind, message })}\n`);
    process.exitCode = 1;
  }
}
