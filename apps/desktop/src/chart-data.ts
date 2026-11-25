// Pure chart data preparation for the BI panel. No React or DOM dependency.
export type ChartType = "bar" | "line" | "area" | "pie" | "scatter";
export type Aggregation = "none" | "sum" | "count" | "avg";

export interface ChartSeries {
  name: string;
  values: number[];
  color: string;
}

export interface ChartData {
  labels: string[];
  series: ChartSeries[];
}

const COLORS = ["#0f766e", "#2563eb", "#d97706", "#7c3aed", "#be123c", "#0891b2", "#65a30d", "#c026d3"];

export function numeric(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function prepareChartData(
  rows: Array<Record<string, unknown>>,
  xField: string,
  yFields: string[],
  aggregation: Aggregation = "none",
): ChartData {
  const groups = new Map<string, Array<Record<string, unknown>>>();
  for (const row of rows) {
    const key = String(row[xField] ?? "(空)");
    const bucket = groups.get(key) ?? [];
    bucket.push(row);
    groups.set(key, bucket);
  }
  const labels = [...groups.keys()].slice(0, 200);
  const series: ChartSeries[] = yFields.map((field, index) => ({
    name: field,
    color: COLORS[index % COLORS.length]!,
    values: labels.map((label) => {
      const bucket = groups.get(label) ?? [];
      const values = bucket.map((row) => numeric(row[field])).filter((value): value is number => value !== null);
      if (aggregation === "count") return bucket.length;
      if (values.length === 0) return 0;
      if (aggregation === "sum") return values.reduce((total, value) => total + value, 0);
      if (aggregation === "avg") return values.reduce((total, value) => total + value, 0) / values.length;
      return values[0] ?? 0;
    }),
  }));
  return { labels, series };
}
