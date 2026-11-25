import { describe, expect, it } from "vitest";
import { normalizeAdvisoryList } from "./advisory-list.js";

describe("advisory list normalisation", () => {
  it("accepts a single string (older model behaviour)", () => {
    expect(normalizeAdvisoryList("结果限制为 1 行")).toEqual(["结果限制为 1 行"]);
    expect(normalizeAdvisoryList("")).toEqual([]);
  });

  it("normalises objects with message/text/reason fields returned by the model", () => {
    expect(normalizeAdvisoryList([{ message: "注意单位" }, { text: "检查 SRID" }, { reason: "截断" }]))
      .toEqual(["注意单位", "检查 SRID", "截断"]);
    expect(normalizeAdvisoryList({ warning: "需要复核" })).toEqual(["需要复核"]);
  });

  it("converts numbers/booleans and skips empty or nested junk", () => {
    expect(normalizeAdvisoryList([1, true, null, "", {}, [1, 2]])).toEqual(["1", "true", "{}"]);
  });

  it("caps item count and string length so a draft is never rejected", () => {
    const many = Array.from({ length: 50 }, (_, i) => `w${i}`);
    expect(normalizeAdvisoryList(many)).toHaveLength(30);
    const long = "x".repeat(1000);
    expect(normalizeAdvisoryList(long)[0]).toHaveLength(300);
    expect(normalizeAdvisoryList(["a".repeat(50)], { maxChars: 10 })).toEqual(["aaaaaaaaaa"]);
  });

  it("handles undefined/null without throwing", () => {
    expect(normalizeAdvisoryList(undefined)).toEqual([]);
    expect(normalizeAdvisoryList(null)).toEqual([]);
  });
});
