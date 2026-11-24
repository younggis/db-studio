import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createChatCompletion } from "../../packages/ai/dist/index.js";
import { readDesktopAiModelSettings } from "../../apps/cli/dist/model-settings.js";

const reportPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.cache/ai-provider-cancel-last.json");
function saveReport(report) {
  mkdirSync(path.dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}

const settings = await readDesktopAiModelSettings().catch(() => undefined);
const chat = settings?.chatModels.find((model) => model.id === settings.defaultChatModelId && model.enabled)
  ?? settings?.chatModels.find((model) => model.enabled);

if (!chat) {
  process.stderr.write("No enabled Chat model was available in encrypted desktop settings.\n");
  saveReport({ generatedAt: new Date().toISOString(), status: "failed", errorCode: "chat-model-unavailable" });
  process.exitCode = 2;
} else {
  const controller = new AbortController();
  const firstDeltaTimeoutMs = Number(process.env.DBSTUDIO_AI_CANCEL_START_TIMEOUT_MS ?? "60000");
  assert.ok(Number.isInteger(firstDeltaTimeoutMs) && firstDeltaTimeoutMs >= 1_000 && firstDeltaTimeoutMs <= 180_000,
    "DBSTUDIO_AI_CANCEL_START_TIMEOUT_MS must be an integer from 1000 to 180000.");
  const timeoutMs = firstDeltaTimeoutMs + 15_000;
  let deltaCount = 0;
  let firstDeltaLatencyMs = null;
  const startedAt = Date.now();
  let abortReason = "first-delta";
  const abortIfNoDelta = setTimeout(() => {
    abortReason = "stream-start-timeout";
    controller.abort(new DOMException("Synthetic provider cancellation smoke timed out waiting for a delta.", "AbortError"));
  }, firstDeltaTimeoutMs);

  try {
    const request = createChatCompletion({ ...chat, streaming: true, timeoutMs, maxOutputTokens: 128, temperature: 0 }, [
      { role: "system", content: "Reply only with harmless ordinary English nouns. Do not include facts, personal information, code, or commentary." },
      { role: "user", content: "List 40 distinct ordinary nouns, one per line. This is synthetic cancellation test content." },
    ], {
      signal: controller.signal,
      disableThinking: true,
      onDelta: () => {
        deltaCount += 1;
        if (abortReason === "first-delta") {
          firstDeltaLatencyMs = Date.now() - startedAt;
          clearTimeout(abortIfNoDelta);
          controller.abort(new DOMException("Synthetic client cancellation after first streamed delta.", "AbortError"));
        }
      },
    });

    await assert.rejects(request, (error) => error && typeof error === "object" && "code" in error && error.code === "cancelled");
    assert.ok(deltaCount > 0, "The live provider must stream at least one delta before cancellation.");
    assert.equal(abortReason, "first-delta", "The provider must reach the streaming path before the safety timeout.");
    const report = saveReport({
      generatedAt: new Date().toISOString(),
      status: "passed",
      ok: true,
      modelId: chat.id,
      streaming: true,
      firstDeltaReceived: true,
      clientRequestCancelled: true,
      deltaCount,
      firstDeltaLatencyMs,
      firstDeltaTimeoutMs,
      responseContentLogged: false,
      schemaSent: false,
    });
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } catch (error) {
    const errorCode = abortReason === "stream-start-timeout" && deltaCount === 0
      ? "no-first-delta"
      : error && typeof error === "object" && "code" in error ? String(error.code) : "assertion-or-request";
    const report = saveReport({ generatedAt: new Date().toISOString(), status: "failed", ok: false, modelId: chat.id, errorCode, abortReason, deltaCount, firstDeltaLatencyMs, firstDeltaTimeoutMs, responseContentLogged: false, schemaSent: false });
    process.stderr.write(`${JSON.stringify(report)}\n`);
    process.exitCode = 1;
  } finally {
    clearTimeout(abortIfNoDelta);
  }
}
