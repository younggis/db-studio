// Dashboard widget persistence (JSON in userData). Pure helpers, no Electron dependency.
import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

export type ChartKind = "bar" | "line" | "area" | "pie" | "scatter";
export type ChartAggregation = "none" | "sum" | "count" | "avg";

export interface BiWidget {
  id: string;
  title: string;
  type: ChartKind;
  connectionId: string;
  sql: string;
  xField: string;
  yFields: string[];
  aggregation: ChartAggregation;
  createdAt: string;
}

export function biStorePath(userDataDir: string): string {
  return path.join(userDataDir, "bi-dashboards.json");
}

export async function loadWidgets(userDataDir: string): Promise<BiWidget[]> {
  try {
    const content = await readFile(biStorePath(userDataDir), "utf8");
    const parsed: unknown = JSON.parse(content);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is BiWidget =>
      !!item && typeof item === "object" && typeof (item as BiWidget).id === "string"
      && typeof (item as BiWidget).sql === "string");
  } catch {
    return [];
  }
}

export async function saveWidgets(userDataDir: string, widgets: BiWidget[]): Promise<void> {
  await writeFile(biStorePath(userDataDir), JSON.stringify(widgets, null, 2), "utf8");
}

export function validateWidget(input: Partial<BiWidget>): BiWidget {
  const title = String(input.title ?? "").trim();
  const sql = String(input.sql ?? "").trim();
  if (!title || title.length > 200) throw new Error("图表标题无效。");
  if (!sql || sql.length > 50_000) throw new Error("图表 SQL 不能为空。");
  if (!String(input.connectionId ?? "").trim()) throw new Error("请选择连接。");
  const kinds: ChartKind[] = ["bar", "line", "area", "pie", "scatter"];
  const aggregations: ChartAggregation[] = ["none", "sum", "count", "avg"];
  return {
    id: String(input.id ?? "") || randomUUID(),
    title,
    type: kinds.includes(input.type as ChartKind) ? input.type as ChartKind : "bar",
    connectionId: String(input.connectionId),
    sql,
    xField: String(input.xField ?? "").trim(),
    yFields: (input.yFields ?? []).map(String).filter(Boolean).slice(0, 8),
    aggregation: aggregations.includes(input.aggregation as ChartAggregation) ? input.aggregation as ChartAggregation : "none",
    createdAt: String(input.createdAt ?? new Date().toISOString()),
  };
}
