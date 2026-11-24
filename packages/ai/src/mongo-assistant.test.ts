import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { runMongoAssistant } from "./mongo-assistant.js";
import type { ChatModelConfig, MongoAssistantRequest } from "./types.js";

const findRequest: MongoAssistantRequest = {
  task: "generate",
  request: "找出西雅图的活跃用户",
  context: { database: "acceptance", collection: "users", mode: "find", schemaHint: "status: string; city: string" },
};

function config(baseURL: string): ChatModelConfig {
  return {
    id: "test", name: "loopback", provider: "openai-compatible", baseURL,
    model: "test", apiKey: "mongo-assistant-test-secret", enabled: true, timeoutMs: 2_000,
  };
}

function completion(content: string): string {
  return JSON.stringify({ choices: [{ message: { content } }] });
}

describe("MongoDB AI assistant", () => {
  let server: Server | undefined;
  let baseURL = "";

  afterEach(async () => {
    if (server?.listening) {
      server.close();
      await once(server, "close");
    }
    server = undefined;
  });

  async function listen(handler: (body: string, authorization?: string) => string): Promise<void> {
    server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => { body += chunk; });
      request.on("end", () => {
        response.setHeader("content-type", "application/json");
        response.end(handler(body, request.headers.authorization));
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("local test server did not bind");
    baseURL = `http://127.0.0.1:${address.port}/v1`;
  }

  it("generates a bounded Find draft from explicitly supplied context without exposing credentials", async () => {
    let submitted = "";
    await listen((body, authorization) => {
      submitted = body;
      expect(authorization).toBe("Bearer mongo-assistant-test-secret");
      return completion(JSON.stringify({
        task: "generate", mode: "find", filter: { city: "Seattle", status: "active" },
        projection: { _id: 0, name: 1 }, sort: { name: 1 }, explanation: "按城市和状态过滤，并只返回姓名。",
        assumptions: [], warnings: [],
      }));
    });

    const result = await runMongoAssistant(config(baseURL), findRequest);
    expect(result.filter).toEqual({ city: "Seattle", status: "active" });
    expect(result.projection).toEqual({ _id: 0, name: 1 });
    expect(result.sort).toEqual({ name: 1 });
    expect(submitted).toContain("$where");
    expect(submitted).not.toContain("mongo-assistant-test-secret");
    const requestBody = JSON.parse(submitted) as {
      response_format?: { type?: string };
      messages: Array<{ role: string; content: string }>;
    };
    expect(requestBody.response_format).toEqual({ type: "json_object" });
    const userMessage = requestBody.messages.find((item) => item.role === "user")?.content ?? "";
    expect(JSON.parse(userMessage)).toMatchObject({ collection: "users", database: "acceptance" });
  });

  it("returns a read-only aggregate pipeline and rejects write or JavaScript stages", async () => {
    let requests = 0;
    const unsafeStages = [
      [{ $out: "results" }],
      [{ $project: { result: { $function: { body: "return true", args: [], lang: "js" } } } }],
      [{ $match: { $where: "this.rank > 1" } }],
    ];
    let stageIndex = 0;
    await listen(() => {
      requests += 1;
      return completion(JSON.stringify({
        task: "generate", mode: "aggregate", pipeline: unsafeStages[stageIndex],
        explanation: "unsafe", assumptions: [], warnings: [],
      }));
    });
    for (stageIndex = 0; stageIndex < unsafeStages.length; stageIndex += 1) {
      await expect(runMongoAssistant(config(baseURL), {
        ...findRequest,
        context: { ...findRequest.context, mode: "aggregate" },
      })).rejects.toThrow("无效或不安全");
    }
    expect(requests).toBe(unsafeStages.length * 2);
  });

  it("reports safe validation reasons after a bounded repair retry without echoing model output", async () => {
    await listen(() => completion(JSON.stringify({
      task: "generate", mode: "aggregate", pipeline: [{ $out: "private_output_marker" }],
      explanation: "draft", assumptions: [], warnings: [],
    })));
    let message = "";
    try {
      await runMongoAssistant(config(baseURL), {
        ...findRequest,
        request: "count records by region",
        context: { ...findRequest.context, mode: "aggregate" },
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/首轮：Pipeline\[0\].*重试：Pipeline\[0\]/);
    expect(message).not.toContain("private_output_marker");
  });

  it("supports explain-only output without returning an applicable query", async () => {
    await listen(() => completion(JSON.stringify({
      task: "explain", mode: "find", explanation: "按城市筛选并按名称排序。", assumptions: [], warnings: [],
    })));
    const result = await runMongoAssistant(config(baseURL), {
      task: "explain", request: "", context: {
        database: "acceptance", collection: "users", mode: "find", query: { filter: "{\"city\":\"Seattle\"}", sort: "{\"name\":1}" },
      },
    });
    expect(result.explanation).toContain("排序");
    expect(result.filter).toBeUndefined();
    expect(result.pipeline).toBeUndefined();
  });

  it("requires a query and database error before repairing", async () => {
    await expect(runMongoAssistant(config(""), {
      task: "repair", request: "", context: { database: "acceptance", collection: "users", mode: "find" },
    })).rejects.toThrow("当前查询内容");
    await expect(runMongoAssistant(config(""), {
      task: "repair", request: "", context: {
        database: "acceptance", collection: "users", mode: "find", query: { filter: "{}" },
      },
    })).rejects.toThrow("错误信息");
  });

  it("repairs a query with the supplied database error without losing the selected collection context", async () => {
    let submitted = "";
    await listen((body) => {
      submitted = body;
      return completion(JSON.stringify({
        task: "repair", mode: "find", filter: { rank: { $gte: 2 } },
        explanation: "使用现有 rank 字段重写过滤条件。", assumptions: [], warnings: [],
      }));
    });
    const result = await runMongoAssistant(config(baseURL), {
      task: "repair", request: "保留按 rank 过滤的意图。", context: {
        database: "acceptance", collection: "users", mode: "find",
        query: { filter: "{\"missingRank\":{\"$gte\":2}}" },
        error: { code: "BadValue", message: "unknown field path missingRank" },
      },
    });
    const envelope = JSON.parse(submitted) as { messages: Array<{ role: string; content: string }> };
    const userMessage = JSON.parse(envelope.messages.find((item) => item.role === "user")?.content ?? "{}") as Record<string, unknown>;
    expect(userMessage).toMatchObject({ database: "acceptance", collection: "users", error: { code: "BadValue" } });
    expect(userMessage.currentQuery).toMatchObject({ filter: "{\"missingRank\":{\"$gte\":2}}" });
    expect(userMessage.error).toMatchObject({ message: "unknown field path missingRank" });
    expect(result.filter).toEqual({ rank: { $gte: 2 } });
  });

  it("rejects unknown query modes and oversized user hints before the provider call", async () => {
    await expect(runMongoAssistant(config(""), {
      ...findRequest,
      context: { ...findRequest.context, mode: "map-reduce" as "find" },
    })).rejects.toThrow("查询模式");
    await expect(runMongoAssistant(config(""), {
      ...findRequest,
      context: { ...findRequest.context, schemaHint: "x".repeat(8_001) },
    })).rejects.toThrow("8,000");
  });
});
