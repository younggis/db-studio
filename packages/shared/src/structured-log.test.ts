import { describe, expect, it } from "vitest";
import { StructuredLogger, redactLogData, type LogRecord } from "./structured-log.js";

describe("structured log redaction", () => {
  it("redacts secret-like keys at any depth", () => {
    const result = redactLogData({
      apiKey: "sk-123",
      nested: { password: "hunter2", safe: "ok" },
      items: [{ privateKey: "PEM", name: "x" }],
    });
    expect(result).toEqual({
      apiKey: "[redacted]",
      nested: { password: "[redacted]", safe: "ok" },
      items: [{ privateKey: "[redacted]", name: "x" }],
    });
  });

  it("redacts long hex payloads (WKB) and truncates oversized free text", () => {
    const wkb = "0x" + "ab".repeat(80);
    const result = redactLogData({ geometry: wkb, note: "x".repeat(5000) });
    expect(result.geometry).toBe("[redacted-binary]");
    expect(String(result.note)).toContain("[truncated]");
    expect(String(result.note).length).toBeLessThan(4200);
  });

  it("emits stable JSON records and honours the minimum level", () => {
    const lines: string[] = [];
    const logger = new StructuredLogger({
      now: () => new Date("2026-11-24T00:00:00.000Z"),
      emit: (line) => lines.push(line),
      minLevel: "warn",
    });
    logger.info("ignored", { detail: "not emitted" });
    const record = logger.error("gis:import:failed", {
      operationId: "op-1", connectionId: "conn-1", durationMs: 120,
      detail: "invalid geometry", data: { apiKey: "secret", layer: "roads" },
    });
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!) as LogRecord;
    expect(parsed).toMatchObject({
      timestamp: "2026-11-24T00:00:00.000Z", level: "error", event: "gis:import:failed",
      operationId: "op-1", connectionId: "conn-1", durationMs: 120,
    });
    expect(parsed.data).toEqual({ apiKey: "[redacted]", layer: "roads" });
    expect(record.data).toEqual(parsed.data);
  });

  it("serialises operation reports as indented JSON", () => {
    const logger = new StructuredLogger({ emit: () => undefined });
    expect(logger.report({ operation: "import", status: "completed", featureCount: 2 }))
      .toContain('\n  "operation": "import"');
  });
});
