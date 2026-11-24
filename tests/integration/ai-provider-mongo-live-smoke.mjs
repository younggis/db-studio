import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { runMongoAssistant, validateMongoAssistantResult } from "../../packages/ai/dist/index.js";
import { readDesktopAiModelSettings } from "../../apps/cli/dist/model-settings.js";
import { MongoDocumentAdapter } from "../../packages/database/dist/mongodb.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const envText = readFileSync(path.join(root, "docker", ".env"), "utf8");
const dockerEnv = Object.fromEntries(envText.split(/\r?\n/)
  .map((line) => line.match(/^\s*([^#=]+)=(.*)$/))
  .filter(Boolean)
  .map((match) => [match[1].trim(), match[2].trim().replace(/^(['"])(.*)\1$/, "$2")]));
assert.ok(dockerEnv.MONGODB_ROOT_USER && dockerEnv.MONGODB_ROOT_PASSWORD,
  "Set isolated MongoDB test credentials in docker/.env.");

const settings = await readDesktopAiModelSettings().catch(() => undefined);
const chat = settings?.chatModels.find((model) => model.id === settings.defaultChatModelId && model.enabled)
  ?? settings?.chatModels.find((model) => model.enabled);
if (!chat) {
  process.stderr.write("An enabled Chat model is required in encrypted desktop settings.\n");
  process.exitCode = 2;
} else {
  const database = dockerEnv.MONGODB_DATABASE || "dbstudio_test";
  const port = dockerEnv.MONGODB_PORT || "27018";
  const uri = `mongodb://${encodeURIComponent(dockerEnv.MONGODB_ROOT_USER)}:${encodeURIComponent(dockerEnv.MONGODB_ROOT_PASSWORD)}@127.0.0.1:${port}/?authSource=admin`;
  const collection = `ai_provider_live_${randomBytes(6).toString("hex")}`;
  const packageRequire = createRequire(path.join(root, "packages/database/package.json"));
  const { MongoClient } = packageRequire("mongodb");
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5_000 });
  const adapter = new MongoDocumentAdapter({ uri, database, connectTimeoutMS: 5_000 });
  const secrets = [chat.apiKey, dockerEnv.MONGODB_ROOT_PASSWORD].filter(Boolean);

  try {
    await client.connect();
    await client.db(database).collection(collection).insertMany([
      { status: "active", score: 9, region: "West" },
      { status: "active", score: 5, region: "West" },
      { status: "active", score: 7, region: "East" },
      { status: "inactive", score: 10, region: "East" },
    ]);

    const schemaHint = "Synthetic fields only: status (string), score (number), region (string).";
    const find = await runMongoAssistant({ ...chat, timeoutMs: 45_000 }, {
      task: "generate",
      request: "查询 status 为 active 的文档，只投影 score 和 region，并按 score 从高到低排序。",
      context: { database, collection, mode: "find", schemaHint },
    });
    assert.deepEqual(validateMongoAssistantResult(find), []);
    assert.equal(find.filter?.status, "active");
    assert.equal(find.sort?.score, -1);
    assert.ok(find.projection?.score === 1 && find.projection?.region === 1);
    const rows = await adapter.findDocuments(database, collection, {
      filter: find.filter,
      projection: find.projection,
      sort: find.sort,
      limit: 10,
    });
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map((row) => row.score), [9, 7, 5]);
    assert.deepEqual(rows.map((row) => row.region), ["West", "East", "West"]);

    const aggregate = await runMongoAssistant({ ...chat, timeoutMs: 45_000 }, {
      task: "generate",
      request: "只统计 status 为 active 的文档，按 region 分组计数，并按数量从高到低排列。",
      context: { database, collection, mode: "aggregate", schemaHint },
    });
    assert.deepEqual(validateMongoAssistantResult(aggregate), []);
    assert.ok(aggregate.pipeline?.some((stage) => stage.$match?.status === "active"));
    const grouped = await adapter.aggregateDocuments(database, collection, aggregate.pipeline, 10);
    assert.equal(grouped.length, 2);
    assert.deepEqual(Object.fromEntries(grouped.map((row) => [row._id, row.count])), { West: 2, East: 1 });

    await client.db(database).collection(collection).drop();
    assert.equal(await client.db(database).listCollections({ name: collection }).hasNext(), false,
      "The temporary AI acceptance collection must be removed before reporting success.");

    process.stdout.write(`${JSON.stringify({
      ok: true,
      engine: "mongodb",
      serverVersion: (await adapter.testConnection()).serverVersion,
      provider: chat.provider,
      model: chat.model,
      liveReadOnlyQueries: {
        find: { matchedDocuments: rows.length, descendingScores: rows.map((row) => row.score) },
        aggregate: { groups: grouped.length, groupCounts: grouped.map((row) => row.count) },
      },
      syntheticSchemaSent: true,
      businessRowsSentToModel: false,
      modelResponseLogged: false,
      generatedQueriesWereReadOnly: true,
      collectionCleaned: true,
    })}\n`);
  } catch (error) {
    let message = String(error instanceof Error ? error.message : "MongoDB AI live integration failed");
    for (const secret of secrets) message = message.replaceAll(secret, "[redacted]");
    message = message.replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[redacted]").slice(0, 240);
    process.stderr.write(`${JSON.stringify({
      ok: false,
      engine: "mongodb",
      provider: chat.provider,
      model: chat.model,
      error: message,
      syntheticSchemaSent: true,
      businessRowsSentToModel: false,
      modelResponseLogged: false,
      collectionCleaned: false,
    })}\n`);
    process.exitCode = 1;
  } finally {
    await client.db(database).collection(collection).drop().catch(() => undefined);
    await adapter.close().catch(() => undefined);
    await client.close().catch(() => undefined);
  }
}
