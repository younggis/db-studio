import { describe, expect, it } from "vitest";
import { appendQueryHistory, clearQueryHistory, createEmptyQueryHistorySnapshot, MAX_QUERY_HISTORY_ENTRIES, MAX_QUERY_SQL_LENGTH, normalizeQueryHistorySnapshot, removeQueryFavorite, upsertQueryFavorite, MAX_QUERY_FAVORITES, } from "./query-history.js";
function historyRecord(id, connectionId = "pg-test") {
    return {
        id,
        connectionId,
        connectionName: "PostGIS 测试",
        engine: "postgres",
        sql: "select id from sample",
        executedAt: "2026-11-05T00:00:00.000Z",
        durationMs: 12,
        outcome: "success",
        rowCount: 2,
        command: "SELECT",
    };
}
function favorite(id) {
    return {
        id,
        title: `查询 ${id}`,
        connectionId: "pg-test",
        connectionName: "PostGIS 测试",
        engine: "postgres",
        sql: "select id from sample",
        createdAt: "2026-11-05T00:00:00.000Z",
        updatedAt: "2026-11-05T00:00:00.000Z",
    };
}
describe("query history", () => {
    it("stores only execution metadata and never result rows", () => {
        const result = appendQueryHistory(createEmptyQueryHistorySnapshot(), historyRecord("one"));
        expect(result.history[0]).toEqual(historyRecord("one"));
        expect(JSON.stringify(result)).not.toContain("rows");
    });
    it("bounds saved history and rejects SQL too large to store", () => {
        let snapshot = createEmptyQueryHistorySnapshot();
        for (let index = 0; index < MAX_QUERY_HISTORY_ENTRIES + 5; index += 1) {
            snapshot = appendQueryHistory(snapshot, historyRecord(String(index)));
        }
        expect(snapshot.history).toHaveLength(MAX_QUERY_HISTORY_ENTRIES);
        expect(snapshot.history[0].id).toBe(String(MAX_QUERY_HISTORY_ENTRIES + 4));
        expect(() => appendQueryHistory(snapshot, { ...historyRecord("large"), sql: "x".repeat(MAX_QUERY_SQL_LENGTH + 1) })).toThrow(/SQL/);
    });
    it("clears one connection without removing other history or favorites", () => {
        let snapshot = appendQueryHistory(createEmptyQueryHistorySnapshot(), historyRecord("one", "pg-test"));
        snapshot = appendQueryHistory(snapshot, historyRecord("two", "mysql-test"));
        snapshot = upsertQueryFavorite(snapshot, favorite("fav"));
        const cleared = clearQueryHistory(snapshot, "pg-test");
        expect(cleared.history.map((item) => item.connectionId)).toEqual(["mysql-test"]);
        expect(cleared.favorites).toHaveLength(1);
    });
    it("upserts and removes favorites within the storage cap", () => {
        let snapshot = createEmptyQueryHistorySnapshot();
        snapshot = upsertQueryFavorite(snapshot, favorite("same"));
        snapshot = upsertQueryFavorite(snapshot, { ...favorite("same"), title: "更新标题" });
        expect(snapshot.favorites).toHaveLength(1);
        expect(snapshot.favorites[0].title).toBe("更新标题");
        for (let index = 0; index < MAX_QUERY_FAVORITES + 3; index += 1) {
            snapshot = upsertQueryFavorite(snapshot, favorite(`fav-${index}`));
        }
        expect(snapshot.favorites).toHaveLength(MAX_QUERY_FAVORITES);
        expect(removeQueryFavorite(snapshot, `fav-${MAX_QUERY_FAVORITES + 2}`).favorites).toHaveLength(MAX_QUERY_FAVORITES - 1);
    });
    it("drops malformed individual rows when normalizing the encrypted store", () => {
        const snapshot = normalizeQueryHistorySnapshot({ version: 1, history: [historyRecord("valid"), { sql: "invalid" }], favorites: [favorite("ok")] });
        expect(snapshot.history.map((item) => item.id)).toEqual(["valid"]);
        expect(snapshot.favorites.map((item) => item.id)).toEqual(["ok"]);
    });
});
//# sourceMappingURL=query-history.test.js.map