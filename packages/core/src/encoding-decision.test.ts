import { describe, expect, it } from "vitest";
import { createDecisionLedger, needsUserDecision, type EncodingCandidate } from "./encoding-decision.js";

const candidate = (overrides: Partial<EncodingCandidate> = {}): EncodingCandidate => ({
  file: "F:/data/roads.tab", layer: "roads", source: "heuristic",
  declared: null, detected: "GBK", confidence: 0.72, previewSample: ["成都", "青城山"],
  ...overrides,
});

describe("encoding decision ledger", () => {
  it("requires user decisions for weak heuristics but not declared metadata", () => {
    expect(needsUserDecision(candidate())).toBe(true);
    expect(needsUserDecision(candidate({ confidence: 0.95 }))).toBe(false);
    expect(needsUserDecision(candidate({ source: "format" }))).toBe(false);
    expect(needsUserDecision(candidate({ source: "user" }))).toBe(false);
  });

  it("records and replaces decisions per file+layer", () => {
    const ledger = createDecisionLedger();
    ledger.upsert({ file: candidate().file, layer: "roads", chosenEncoding: "GBK", decidedAt: "2026-11-25T00:00:00Z", basis: "user-confirmed" });
    ledger.upsert({ file: candidate().file, layer: "roads", chosenEncoding: "CP936", decidedAt: "2026-11-25T00:01:00Z", basis: "user-confirmed" });
    expect(ledger.decisions).toHaveLength(1);
    expect(ledger.find(candidate().file, "roads")?.chosenEncoding).toBe("CP936");
    expect(ledger.find(candidate().file, "other")).toBeUndefined();
  });

  it("serialises decisions as stable JSON for audit", () => {
    const ledger = createDecisionLedger([{ file: "a.tab", chosenEncoding: "CP936", decidedAt: "t", basis: "skipped", note: "no sample" }]);
    const parsed = JSON.parse(ledger.toJSON());
    expect(parsed[0]).toMatchObject({ file: "a.tab", chosenEncoding: "CP936", basis: "skipped" });
  });
});
