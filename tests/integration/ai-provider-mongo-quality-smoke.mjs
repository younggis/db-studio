import assert from "node:assert/strict";
import { runMongoAssistant, validateMongoAssistantResult } from "../../packages/ai/dist/index.js";
import { readDesktopAiModelSettings } from "../../apps/cli/dist/model-settings.js";

const settings = await readDesktopAiModelSettings().catch(() => undefined);
const chat = settings?.chatModels.find((model) => model.id === settings.defaultChatModelId && model.enabled)
  ?? settings?.chatModels.find((model) => model.enabled);

if (!chat) {
  process.stderr.write("An enabled Chat model is required in encrypted desktop settings.\n");
  process.exitCode = 2;
} else {
  const timeoutMs = 45_000;
  const baseContext = {
    database: "ai_provider_mongo_smoke",
    collection: "ai_mongo_smoke_orders",
    schemaHint: "Fields: status (string), score (number), region (string), createdAt (date). Synthetic schema only.",
  };
  const cases = [];

  try {
    const find = await runMongoAssistant({ ...chat, timeoutMs }, {
      task: "generate",
      request: "查询 status 为 active 的文档，只投影 score 和 region，并按 score 从高到低排序。",
      context: { ...baseContext, mode: "find" },
    });
    assert.deepEqual(validateMongoAssistantResult(find), [], "Find output must pass the MongoDB safety validator.");
    assert.equal(find.mode, "find");
    assert.equal(find.filter?.status, "active", "Find output must filter the requested status.");
    assert.equal(find.sort?.score, -1, "Find output must sort scores descending.");
    assert.ok(find.projection?.score === 1 && find.projection?.region === 1,
      "Find output must project only the requested fields (apart from optional _id handling).");
    cases.push({ name: "find-filter-projection-sort", ok: true, safetyIssues: 0 });

    const aggregate = await runMongoAssistant({ ...chat, timeoutMs }, {
      task: "generate",
      request: "只统计 status 为 active 的订单，按 region 分组计数，并按数量从高到低排列。",
      context: { ...baseContext, mode: "aggregate" },
    });
    assert.deepEqual(validateMongoAssistantResult(aggregate), [], "Aggregate output must pass the stage/operator safety validator.");
    assert.equal(aggregate.mode, "aggregate");
    assert.ok(aggregate.pipeline?.some((stage) => stage.$match?.status === "active"),
      "Aggregate output must filter active records.");
    assert.ok(aggregate.pipeline?.some((stage) => stage.$group?._id === "$region"
      && stage.$group?.count?.$sum === 1), "Aggregate output must count records by region.");
    assert.ok(aggregate.pipeline?.some((stage) => stage.$sort?.count === -1),
      "Aggregate output must sort group counts descending.");
    cases.push({ name: "aggregate-match-group-sort", ok: true, safetyIssues: 0 });

    process.stdout.write(`${JSON.stringify({
      ok: true,
      provider: chat.provider,
      model: chat.model,
      cases,
      schemaSent: "synthetic fields only",
      responseContentLogged: false,
      queryExecuted: false,
    })}\n`);
  } catch (error) {
    const kind = error && typeof error === "object" && "kind" in error ? String(error.kind) : "quality";
    let message = String(error instanceof Error ? error.message : "request failed");
    if (chat.apiKey) message = message.replaceAll(chat.apiKey, "[redacted]");
    message = message.replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[redacted]").slice(0, 240);
    process.stderr.write(`${JSON.stringify({
      ok: false,
      provider: chat.provider,
      model: chat.model,
      cases,
      errorKind: kind,
      message,
      schemaSent: "synthetic fields only",
      responseContentLogged: false,
      queryExecuted: false,
    })}\n`);
    process.exitCode = 1;
  }
}
