import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runMongoAssistant } from "../../packages/ai/dist/index.js";
import { MongoDocumentAdapter } from "../../packages/database/dist/mongodb.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const envFile = path.join(root, "docker", ".env");
const envText = readFileSync(envFile, "utf8");
const dockerEnv = Object.fromEntries(envText.split(/\r?\n/)
  .map((line) => line.match(/^\s*([^#=]+)=(.*)$/))
  .filter(Boolean)
  .map((match) => [match[1].trim(), match[2].trim().replace(/^(['"])(.*)\1$/, "$2")]));
assert.ok(dockerEnv.MONGODB_ROOT_USER && dockerEnv.MONGODB_ROOT_PASSWORD, "Set isolated MongoDB test credentials in docker/.env.");

const database = dockerEnv.MONGODB_DATABASE || "dbstudio_test";
const port = dockerEnv.MONGODB_PORT || "27018";
const uri = `mongodb://${encodeURIComponent(dockerEnv.MONGODB_ROOT_USER)}:${encodeURIComponent(dockerEnv.MONGODB_ROOT_PASSWORD)}@127.0.0.1:${port}/?authSource=admin`;
const collection = `ai_assistant_${Date.now().toString(36)}`;
const packageRequire = createRequire(path.join(root, "packages/database/package.json"));
const { MongoClient } = packageRequire("mongodb");
const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5_000 });
const adapter = new MongoDocumentAdapter({ uri, database, connectTimeoutMS: 5_000 });
let server;

try {
  await client.connect();
  const db = client.db(database);
  await db.collection(collection).insertMany([
    { rank: 1, city: "Seattle", name: "North" },
    { rank: 2, city: "Seattle", name: "West" },
    { rank: 3, city: "Portland", name: "South" },
  ]);

  server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const envelope = JSON.parse(body);
      const userText = envelope.messages.find((message) => message.role === "user")?.content ?? "{}";
      const input = JSON.parse(userText);
      const result = input.mode === "find"
        ? {
            task: "generate", mode: "find", filter: { rank: { $gte: 2 } },
            projection: { _id: 0, rank: 1, city: 1 }, sort: { rank: -1 },
            explanation: "筛选 rank 不小于 2 的文档，并按 rank 降序返回所需字段。", assumptions: [], warnings: [],
          }
        : {
            task: "generate", mode: "aggregate", pipeline: [
              { $group: { _id: "$city", count: { $sum: 1 } } }, { $sort: { count: -1 } },
            ],
            explanation: "按 city 分组统计文档数，并按计数降序排列。", assumptions: [], warnings: [],
          };
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseURL = `http://127.0.0.1:${address.port}/v1`;
  const model = {
    id: "mongodb-integration-loopback", name: "deterministic local test", provider: "openai-compatible",
    baseURL, model: "test", apiKey: "local-only-test-key", enabled: true, timeoutMs: 5_000,
  };

  const findDraft = await runMongoAssistant(model, {
    task: "generate", request: "列出 rank 至少为 2 的城市和 rank，按 rank 从大到小。",
    context: { database, collection, mode: "find", schemaHint: "rank: number; city: string; name: string" },
  });
  assert.ok(findDraft.filter);
  const found = await adapter.findDocuments(database, collection, {
    filter: findDraft.filter,
    projection: findDraft.projection,
    sort: findDraft.sort,
    limit: 100,
  });
  assert.deepEqual(found.map((item) => item.rank), [3, 2]);
  assert.deepEqual(found.map((item) => item.city), ["Portland", "Seattle"]);

  const aggregateDraft = await runMongoAssistant(model, {
    task: "generate", request: "按 city 分组统计文档数。",
    context: { database, collection, mode: "aggregate", schemaHint: "rank: number; city: string; name: string" },
  });
  assert.ok(aggregateDraft.pipeline);
  const aggregated = await adapter.aggregateDocuments(database, collection, aggregateDraft.pipeline, 100);
  assert.deepEqual(aggregated, [{ _id: "Seattle", count: 2 }, { _id: "Portland", count: 1 }]);

  process.stdout.write(`${JSON.stringify({
    engine: "mongodb",
    database,
    serverVersion: (await adapter.testConnection()).serverVersion,
    provider: "deterministic loopback; no external model call",
    generatedFindDraftExecutedReadOnly: { matched: found.length, ranksDescending: found.map((item) => item.rank) },
    generatedAggregateDraftExecutedReadOnly: { groups: aggregated.length, counts: aggregated.map((item) => item.count) },
    collectionCleaned: true,
  }, null, 2)}\n`);
} finally {
  if (server?.listening) {
    server.close();
    await once(server, "close");
  }
  await client.db(database).collection(collection).drop().catch(() => undefined);
  await adapter.close().catch(() => undefined);
  await client.close().catch(() => undefined);
}
