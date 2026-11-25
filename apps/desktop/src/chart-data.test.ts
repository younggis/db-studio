import { describe, expect, it } from "vitest";
import { prepareChartData } from "./chart-data";

const rows = [
  { city: "成都", sales: 10, cost: 4 },
  { city: "成都", sales: 20, cost: 6 },
  { city: "绵阳", sales: 15, cost: 3 },
  { city: "重庆", sales: "25", cost: "5" },
];

describe("chart data preparation", () => {
  it("groups by x field and coerces numeric strings", () => {
    const data = prepareChartData(rows, "city", ["sales"]);
    expect(data.labels).toEqual(["成都", "绵阳", "重庆"]);
    expect(data.series[0]?.values).toEqual([10, 15, 25]);
  });

  it("supports sum, count and avg aggregations", () => {
    expect(prepareChartData(rows, "city", ["sales"], "sum").series[0]?.values).toEqual([30, 15, 25]);
    expect(prepareChartData(rows, "city", ["sales"], "count").series[0]?.values).toEqual([2, 1, 1]);
    expect(prepareChartData(rows, "city", ["sales"], "avg").series[0]?.values).toEqual([15, 15, 25]);
  });

  it("supports multiple series with distinct colours", () => {
    const data = prepareChartData(rows, "city", ["sales", "cost"]);
    expect(data.series).toHaveLength(2);
    expect(data.series[0]?.color).not.toBe(data.series[1]?.color);
    expect(data.series[1]?.values).toEqual([4, 3, 5]);
  });

  it("handles empty rows and missing fields", () => {
    expect(prepareChartData([], "city", ["sales"])).toEqual({ labels: [], series: [{ name: "sales", color: expect.any(String), values: [] }] });
    expect(prepareChartData(rows, "missing", ["sales"]).labels).toEqual(["(空)"]);
  });
});
