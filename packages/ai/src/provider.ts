import { lookup } from "node:dns/promises";
import { request as httpRequest, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import type { ChatModelConfig, EmbeddingModelConfig, RerankModelConfig } from "./types.js";

const MAX_PROVIDER_JSON_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_PROVIDER_ERROR_RESPONSE_BYTES = 16 * 1024;

export class AiProviderError extends Error {
  constructor(message: string, readonly code: "configuration" | "network" | "timeout" | "cancelled" | "provider" | "response" = "provider") {
    super(message);
    this.name = "AiProviderError";
  }
}

function privateAddress(address: string): boolean {
  const mapped = address.toLowerCase().match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return privateAddress(mapped[1]!);
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || a! >= 224
      || (a === 169 && b === 254) || (a === 172 && b! >= 16 && b! <= 31)
      || (a === 192 && b === 168) || (a === 100 && b! >= 64 && b! <= 127)
      || (a === 198 && (b === 18 || b === 19));
  }
  const host = address.toLowerCase().split("%")[0]!;
  return host === "::" || host === "::1" || /^(fc|fd|fe[89ab]|ff)/.test(host);
}

function loopback(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1" || host === "::1";
}

function loopbackAddress(address: string): boolean {
  const host = address.toLowerCase().split("%")[0]!;
  if (host === "::1") return true;
  if (isIP(host) !== 4) return false;
  return Number(host.split(".")[0]) === 127;
}

type ModelAddress = { address: string; family: number };
type ResolvedModelBaseUrl = { url: URL; addresses: ModelAddress[] };

async function resolveModelBaseUrl(value: string): Promise<ResolvedModelBaseUrl> {
  let url: URL;
  try { url = new URL(value.trim()); }
  catch { throw new AiProviderError("请输入有效的模型 Base URL。", "configuration"); }
  if (!["https:", "http:"].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) {
    throw new AiProviderError("Base URL 只能使用无凭据、无查询参数的 HTTP(S) 地址。", "configuration");
  }
  if (url.protocol === "http:" && !loopback(url.hostname)) {
    throw new AiProviderError("远程模型服务必须使用 HTTPS；HTTP 仅允许本机模型服务。", "configuration");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  let addresses: ModelAddress[];
  const literalFamily = isIP(hostname);
  try {
    addresses = literalFamily
      ? [{ address: hostname, family: literalFamily }]
      : await lookup(hostname, { all: true, verbatim: true });
  } catch { throw new AiProviderError("无法解析模型服务主机名。", "network"); }
  const localHost = loopback(url.hostname);
  if (!addresses.length || addresses.some((entry) => localHost
    ? !loopbackAddress(entry.address)
    : privateAddress(entry.address))) {
    throw new AiProviderError(localHost
      ? "本机模型地址必须解析到回环网络。"
      : "远程模型地址不能指向本机或私有网络。", "configuration");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return { url, addresses };
}

export async function validateModelBaseUrl(value: string): Promise<URL> {
  return (await resolveModelBaseUrl(value)).url;
}

function endpoint(base: URL, path: string): URL {
  return new URL(base.pathname.replace(/\/+$/, "") + "/" + path.replace(/^\/+/, ""), base.origin + "/");
}

function providerError(status: number, body: string, key: string): string {
  let detail = body.slice(0, 800).replace(/Bearer\s+[^\s"']+/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[redacted]");
  if (key) detail = detail.replaceAll(key, "[redacted]");
  try {
    const value = JSON.parse(detail) as { error?: { message?: unknown }; message?: unknown };
    const message = value.error?.message ?? value.message;
    if (typeof message === "string") detail = message.slice(0, 500).replaceAll(key, "[redacted]");
  } catch { /* A bounded, redacted response may be useful for provider diagnostics. */ }
  return "模型服务返回 HTTP " + status + (detail ? "：" + detail : "");
}

function isUnsupportedJsonObjectMode(status: number, body: string): boolean {
  return status === 400
    && /\b(?:response_format|json_object)\b/i.test(body)
    && /(?:not supported|unsupported|unrecognized|unknown parameter|invalid parameter)/i.test(body);
}

async function readLimitedResponseText(response: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) return { text: "", truncated: false };
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  let truncated = false;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      const remaining = maxBytes - byteLength;
      if (item.value.byteLength > remaining) {
        if (remaining > 0) chunks.push(item.value.slice(0, remaining));
        byteLength = maxBytes;
        truncated = true;
        await reader.cancel();
        break;
      }
      chunks.push(item.value);
      byteLength += item.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder().decode(bytes), truncated };
}

async function readProviderJson<T>(response: Response): Promise<T> {
  const { text, truncated } = await readLimitedResponseText(response, MAX_PROVIDER_JSON_RESPONSE_BYTES);
  if (truncated) throw new AiProviderError("模型服务响应超过 8 MiB 上限。", "response");
  try { return JSON.parse(text) as T; }
  catch { throw new AiProviderError("模型服务返回了无效 JSON。", "response"); }
}

function requestTimeout(timeoutMs: number, parent?: AbortSignal) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException("Model request timed out.", "TimeoutError"));
  }, timeoutMs);
  timer.unref?.();
  const abort = () => controller.abort(parent?.reason);
  parent?.addEventListener("abort", abort, { once: true });
  if (parent?.aborted) abort();
  return {
    signal: controller.signal,
    dispose: () => { clearTimeout(timer); parent?.removeEventListener("abort", abort); },
    timedOut: () => timedOut,
  };
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AiProviderError("模型请求已取消。", "cancelled");
}

function rethrowRequestFailure(error: unknown, signal: AbortSignal | undefined, timeout: ReturnType<typeof requestTimeout>): never {
  if (signal?.aborted) throw new AiProviderError("模型请求已取消。", "cancelled");
  if (timeout.timedOut()) throw new AiProviderError("模型请求超时。", "timeout");
  throw error;
}

function pinnedLookup(addresses: ModelAddress[]): NonNullable<RequestOptions["lookup"]> {
  const resolver = (
    _hostname: string,
    options: number | { all?: boolean },
    callback: (error: NodeJS.ErrnoException | null, address: string | ModelAddress[], family?: number) => void,
  ) => {
    if (typeof options === "object" && options?.all) callback(null, addresses);
    else callback(null, addresses[0]!.address, addresses[0]!.family);
  };
  return resolver as unknown as NonNullable<RequestOptions["lookup"]>;
}

function postModelRequest(url: URL, addresses: ModelAddress[], body: string, apiKey: string, signal: AbortSignal): Promise<Response> {
  return new Promise((resolve, reject) => {
    const requestOptions = {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
        ...(apiKey ? { authorization: "Bearer " + apiKey } : {}),
      },
      signal,
      lookup: pinnedLookup(addresses),
      autoSelectFamily: addresses.length > 1,
    } as RequestOptions;
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    const request = send(url, requestOptions, (incoming) => {
      const status = incoming.statusCode ?? 502;
      if (status < 200 || status > 599) {
        incoming.destroy();
        reject(new Error("模型服务返回了无效 HTTP 状态码。"));
        return;
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (value === undefined) continue;
        for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
      }
      const responseBody = [204, 205, 304].includes(status)
        ? null
        : Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
      try {
        resolve(new Response(responseBody, { status, statusText: incoming.statusMessage, headers }));
      } catch (error) {
        incoming.destroy();
        reject(error);
      }
    });
    request.once("error", reject);
    request.end(body);
  });
}

async function postJson<T>(url: URL, addresses: ModelAddress[], body: unknown, apiKey: string, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  const timeout = requestTimeout(timeoutMs, signal);
  try {
    let response: Response;
    try {
      response = await postModelRequest(url, addresses, JSON.stringify(body), apiKey, timeout.signal);
    } catch (error) {
      if (signal?.aborted) throw new AiProviderError("模型请求已取消。", "cancelled");
      if (timeout.timedOut()) throw new AiProviderError("模型请求超时。", "timeout");
      throw new AiProviderError("无法连接模型服务：" + (error instanceof Error ? error.message.slice(0, 180) : "网络错误"), "network");
    }
    try {
      if (!response.ok) {
        const { text, truncated } = await readLimitedResponseText(response, MAX_PROVIDER_ERROR_RESPONSE_BYTES);
        const detail = providerError(response.status, text, apiKey);
        throw new AiProviderError(truncated ? detail + "（错误正文超过 16 KiB，已截断）" : detail, "provider");
      }
      return await readProviderJson<T>(response);
    } catch (error) {
      rethrowRequestFailure(error, signal, timeout);
    }
  } finally { timeout.dispose(); }
}

function textContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((part) => part && typeof part === "object" && "text" in part && typeof part.text === "string" ? part.text : "").join("");
}

export async function createChatCompletion(
  config: ChatModelConfig,
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  options: { signal?: AbortSignal; onDelta?: (value: string) => void; forceNonStreaming?: boolean; jsonMode?: boolean; disableThinking?: boolean } = {},
): Promise<string> {
  if (!config.model.trim()) throw new AiProviderError("模型 ID 不能为空。", "configuration");
  if (config.apiKey.length > 4096) throw new AiProviderError("API Key 长度超过限制。", "configuration");
  const resolvedBase = await resolveModelBaseUrl(config.baseURL);
  const base = resolvedBase.url;
  const streaming = Boolean(config.streaming && options.onDelta && !options.forceNonStreaming);
  const requestBody: Record<string, unknown> = {
    model: config.model.trim(),
    messages,
    temperature: Math.min(2, Math.max(0, config.temperature ?? 0.2)),
    max_tokens: Math.min(16_384, Math.max(64, config.maxOutputTokens ?? 2_048)),
    stream: streaming,
  };
  if (options.jsonMode) requestBody.response_format = { type: "json_object" };
  if (options.disableThinking) {
    const host = new URL(base).hostname.toLowerCase();
    const isDashScope = host === "dashscope.aliyuncs.com" || host.endsWith(".maas.aliyuncs.com");
    const isQwenThinkingModel = /^qwen3(?:\.\d+)?-/i.test(config.model.trim());
    if (isDashScope && isQwenThinkingModel) requestBody.enable_thinking = false;
  }
  const body = JSON.stringify(requestBody);
  const timeout = requestTimeout(config.timeoutMs ?? 60_000, options.signal);
  try {
    let response: Response;
    try {
      response = await postModelRequest(endpoint(base, "chat/completions"), resolvedBase.addresses, body, config.apiKey, timeout.signal);
    } catch (error) {
      if (options.signal?.aborted) throw new AiProviderError("模型请求已取消。", "cancelled");
      if (timeout.timedOut()) throw new AiProviderError("模型请求超时。", "timeout");
      throw new AiProviderError("无法连接模型服务：" + (error instanceof Error ? error.message.slice(0, 180) : "网络错误"), "network");
    }
    if (!response.ok) {
      let text: string;
      let truncated: boolean;
      try {
        ({ text, truncated } = await readLimitedResponseText(response, MAX_PROVIDER_ERROR_RESPONSE_BYTES));
      } catch (error) {
        rethrowRequestFailure(error, options.signal, timeout);
      }
      if (options.jsonMode && isUnsupportedJsonObjectMode(response.status, text)) {
        return await createChatCompletion(config, messages, { ...options, jsonMode: false });
      }
      const detail = providerError(response.status, text, config.apiKey);
      throw new AiProviderError(truncated ? detail + "（错误正文超过 16 KiB，已截断）" : detail, "provider");
    }
    if (!streaming) {
      let result: { choices?: Array<{ message?: { content?: unknown } }> };
      try {
        result = await readProviderJson<{ choices?: Array<{ message?: { content?: unknown } }> }>(response);
      } catch (error) {
        rethrowRequestFailure(error, options.signal, timeout);
      }
      const content = textContent(result.choices?.[0]?.message?.content);
      if (!content) throw new AiProviderError("模型服务响应中没有文本内容。", "response");
      return content;
    }
    if (!response.body) throw new AiProviderError("模型服务未提供可读取的流式响应。", "response");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let collected = "";
    let receivedBytes = 0;
    try {
      while (true) {
        const item = await reader.read();
        throwIfCancelled(options.signal);
        if (item.done) break;
        receivedBytes += item.value.byteLength;
        if (receivedBytes > MAX_PROVIDER_JSON_RESPONSE_BYTES) {
          throw new AiProviderError("模型流式响应超过 8 MiB 上限。", "response");
        }
        buffer += decoder.decode(item.value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          let event: { choices?: Array<{ delta?: { content?: unknown } }> };
          try {
            event = JSON.parse(data) as typeof event;
          } catch { /* Ignore malformed intermediate SSE frames. */ continue; }
          const delta = textContent(event.choices?.[0]?.delta?.content);
          if (delta) {
            collected += delta;
            options.onDelta?.(delta);
            throwIfCancelled(options.signal);
          }
        }
      }
      buffer += decoder.decode();
      const last = buffer.split(/\r?\n/).find((line) => line.startsWith("data:"))?.slice(5).trim();
      if (last && last !== "[DONE]") {
        let event: { choices?: Array<{ delta?: { content?: unknown } }> } | undefined;
        try {
          event = JSON.parse(last) as { choices?: Array<{ delta?: { content?: unknown } }> };
        } catch { /* Ignore an incomplete final SSE frame. */ }
        if (event) {
          const delta = textContent(event.choices?.[0]?.delta?.content);
          if (delta) {
            collected += delta;
            options.onDelta?.(delta);
            throwIfCancelled(options.signal);
          }
        }
      }
    } catch (error) {
      if (options.signal?.aborted) throw new AiProviderError("模型请求已取消。", "cancelled");
      if (timeout.timedOut()) throw new AiProviderError("模型请求超时。", "timeout");
      throw error;
    } finally { await reader.cancel().catch(() => undefined); }
    throwIfCancelled(options.signal);
    if (!collected) throw new AiProviderError("模型流式响应中没有文本内容。", "response");
    return collected;
  } finally { timeout.dispose(); }
}

export async function testChatModel(config: ChatModelConfig, signal?: AbortSignal): Promise<void> {
  const reply = await createChatCompletion(config, [
    { role: "system", content: "Reply with a short confirmation only." },
    { role: "user", content: "Reply with the single word OK." },
  ], { signal, forceNonStreaming: true });
  if (!/\bok\b/i.test(reply)) throw new AiProviderError("模型已连接，但测试响应格式不符合预期。", "response");
}

export async function createEmbedding(config: EmbeddingModelConfig, input: string | string[], signal?: AbortSignal): Promise<number[][]> {
  const items = Array.isArray(input) ? input : [input];
  if (!items.length || items.length > Math.min(10, config.batchSize ?? 10) || items.some((item) => !item.trim() || item.length > 40_000)) {
    throw new AiProviderError("Embedding 输入须为 1 到 10 条非空短文本。", "configuration");
  }
  const resolvedBase = await resolveModelBaseUrl(config.baseURL);
  const base = resolvedBase.url;
  const result = await postJson<{ data?: Array<{ embedding?: unknown; index?: number }> }>(
    endpoint(base, "embeddings"),
    resolvedBase.addresses,
    { model: config.model, input: items, ...(config.dimensions ? { dimensions: config.dimensions } : {}), encoding_format: "float" },
    config.apiKey,
    config.timeoutMs ?? 60_000,
    signal,
  );
  if (!result || typeof result !== "object" || Array.isArray(result)
    || !Array.isArray(result.data) || result.data.some((row) => !row || typeof row !== "object" || Array.isArray(row))) {
    throw new AiProviderError("Embedding 响应数量或向量格式无效。", "response");
  }
  const rows = result.data;
  const indices = rows.map((row) => row.index);
  if (rows.length !== items.length
    || indices.some((index) => !Number.isInteger(index) || index! < 0 || index! >= items.length)
    || new Set(indices).size !== items.length
    || rows.some((row) => !Array.isArray(row.embedding) || !row.embedding.length || row.embedding.some((value) => typeof value !== "number" || !Number.isFinite(value)))) {
    throw new AiProviderError("Embedding 响应数量或向量格式无效。", "response");
  }
  const vectors = [...rows]
    .sort((left, right) => left.index! - right.index!)
    .map((row) => row.embedding as number[]);
  const dimensions = vectors[0]!.length;
  if (vectors.some((vector) => vector.length !== dimensions) || (config.dimensions && dimensions !== config.dimensions)) {
    throw new AiProviderError("Embedding 返回维度与配置不一致；需重新测试并重建 Schema 索引。", "response");
  }
  return vectors;
}

export async function rerank(config: RerankModelConfig, query: string, documents: string[], signal?: AbortSignal): Promise<Array<{ index: number; relevanceScore: number }>> {
  if (!query.trim() || !documents.length || documents.length > 100) throw new AiProviderError("Rerank 需要查询文本和 1 到 100 条候选文本。", "configuration");
  const resolvedBase = await resolveModelBaseUrl(config.baseURL);
  const base = resolvedBase.url;
  const url = new URL("/api/v1/services/rerank/text-rerank/text-rerank", base.origin);
  const result = await postJson<{ output?: { results?: Array<{ index?: number; relevance_score?: number }> } }>(
    url,
    resolvedBase.addresses,
    { model: config.model, input: { query, documents }, parameters: { return_documents: false, top_n: documents.length } },
    config.apiKey,
    config.timeoutMs ?? 60_000,
    signal,
  );
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new AiProviderError("Rerank 响应排序结果无效。", "response");
  }
  const rows = result.output?.results ?? [];
  if (!rows.length || rows.some((row) => !row || typeof row !== "object" || Array.isArray(row)
    || !Number.isInteger(row.index) || row.index! < 0 || row.index! >= documents.length
    || typeof row.relevance_score !== "number" || !Number.isFinite(row.relevance_score))
    || new Set(rows.map((row) => row.index)).size !== rows.length) {
    throw new AiProviderError("Rerank 响应排序结果无效。", "response");
  }
  return rows.map((row) => ({ index: row.index!, relevanceScore: row.relevance_score! }));
}

export async function testEmbeddingModel(config: EmbeddingModelConfig, signal?: AbortSignal): Promise<number> {
  return (await createEmbedding(config, "DB Studio schema connection check", signal))[0]!.length;
}

export async function testRerankModel(config: RerankModelConfig, signal?: AbortSignal): Promise<void> {
  const result = await rerank(config, "database schema", ["database tables and columns", "weather forecast"], signal);
  if (!result.length || result[0]!.index !== 0) throw new AiProviderError("Rerank 已连接，但测试响应排序不符合预期。", "response");
}
