// Dashboard widget persistence (JSON in userData). Pure helpers, no Electron dependency.
import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
export function biStorePath(userDataDir) {
    return path.join(userDataDir, "bi-dashboards.json");
}
export async function loadWidgets(userDataDir) {
    try {
        const content = await readFile(biStorePath(userDataDir), "utf8");
        const parsed = JSON.parse(content);
        if (!Array.isArray(parsed))
            return [];
        return parsed.filter((item) => !!item && typeof item === "object" && typeof item.id === "string"
            && typeof item.sql === "string");
    }
    catch {
        return [];
    }
}
export async function saveWidgets(userDataDir, widgets) {
    await writeFile(biStorePath(userDataDir), JSON.stringify(widgets, null, 2), "utf8");
}
export function validateWidget(input) {
    const title = String(input.title ?? "").trim();
    const sql = String(input.sql ?? "").trim();
    if (!title || title.length > 200)
        throw new Error("图表标题无效。");
    if (!sql || sql.length > 50_000)
        throw new Error("图表 SQL 不能为空。");
    if (!String(input.connectionId ?? "").trim())
        throw new Error("请选择连接。");
    const kinds = ["bar", "line", "area", "pie", "scatter"];
    const aggregations = ["none", "sum", "count", "avg"];
    return {
        id: String(input.id ?? "") || randomUUID(),
        title,
        type: kinds.includes(input.type) ? input.type : "bar",
        connectionId: String(input.connectionId),
        sql,
        xField: String(input.xField ?? "").trim(),
        yFields: (input.yFields ?? []).map(String).filter(Boolean).slice(0, 8),
        aggregation: aggregations.includes(input.aggregation) ? input.aggregation : "none",
        createdAt: String(input.createdAt ?? new Date().toISOString()),
    };
}
//# sourceMappingURL=bi-store.js.map