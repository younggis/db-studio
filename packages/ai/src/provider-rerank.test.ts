import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { rerank } from "./provider.js";
import type { RerankModelConfig } from "./types.js";

describe("Rerank provider abstraction", () => {
  let server: Server | undefined;
  let baseURL = "";

  afterEach(async () => {
    if (server?.listening) {
      server.close();
      await once(server, "close");
    }
    server = undefined;
  });

  async function listen(handler: (path: string, body: string, authorization: string | undefined) => string): Promise<void> {
    server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => { body += chunk; });
      request.on("end", () => {
        response.setHeader("content-type", "application/json");
        response.end(handler(request.url ?? "", body, request.headers.authorization));
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("local test server did not bind");
    baseURL = `http://127.0.0.1:${address.port}/v1`;
  }

  it("uses the DashScope service path and nested output.results shape", async () => {
    let seen = "";
    await listen((path, body) => {
      seen = path + " " + body;
      return JSON.stringify({ output: { results: [{ index: 1, relevance_score: 0.9 }, { index: 0, relevance_score: 0.2 }] } });
    });
    const config: RerankModelConfig = {
      provider: "dashscope", baseURL, model: "gte-rerank-v2", apiKey: "secret", enabled: true,
    };
    const result = await rerank(config, "schema", ["tables", "columns"]);
    expect(seen).toContain("/api/v1/services/rerank/text-rerank/text-rerank");
    expect(result).toEqual([{ index: 1, relevanceScore: 0.9 }, { index: 0, relevanceScore: 0.2 }]);
  });

  it("supports a local OpenAI-compatible reranker without an API key", async () => {
    let seen = "";
    let authorization: string | undefined;
    await listen((path, body, auth) => {
      seen = path + " " + body;
      authorization = auth;
      return JSON.stringify({ results: [{ index: 0, relevance_score: 0.95 }, { index: 1, relevance_score: 0.1 }] });
    });
    const config: RerankModelConfig = {
      provider: "openai-compatible", baseURL, model: "local-rerank", apiKey: "", enabled: true,
    };
    const result = await rerank(config, "schema", ["tables", "columns"]);
    expect(seen).toContain("/v1/rerank");
    expect(seen).toContain('"query":"schema"');
    expect(authorization).toBeUndefined();
    expect(result).toEqual([{ index: 0, relevanceScore: 0.95 }, { index: 1, relevanceScore: 0.1 }]);
  });

  it("rejects malformed local rerank responses", async () => {
    await listen(() => JSON.stringify({ results: [{ index: 5, relevance_score: 0.5 }] }));
    const config: RerankModelConfig = {
      provider: "openai-compatible", baseURL, model: "local-rerank", apiKey: "", enabled: true,
    };
    await expect(rerank(config, "schema", ["tables"])).rejects.toThrow(/无效/);
  });
});
