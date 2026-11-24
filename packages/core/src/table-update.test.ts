import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteAdapter } from "@db-studio/database";
import { CoreService } from "./index.js";

let directory: string | undefined;

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

async function createService() {
  directory = await mkdtemp(join(tmpdir(), "db-studio-table-update-"));
  const path = join(directory, "test.sqlite");
  const seed = new SqliteAdapter({ path });
  await seed.query("CREATE TABLE items (id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL, label TEXT NOT NULL UNIQUE)");
  await seed.query("INSERT INTO items (id, tenant_id, label) VALUES (?, ?, ?)", [1, 4, "original"]);
  await seed.query("INSERT INTO items (id, tenant_id, label) VALUES (?, ?, ?)", [2, 4, "second"]);
  await seed.query("CREATE VIEW item_view AS SELECT id, tenant_id, label FROM items");
  await seed.query("CREATE TABLE loose (label TEXT NOT NULL)");
  await seed.close();
  return { path, service: new CoreService(() => new SqliteAdapter({ path }), {}, false) };
}

describe("CoreService.updateTableRows", () => {
  it("rechecks live table metadata and commits safe structured changes", async () => {
    const { path, service } = await createService();
    const results = await service.updateTableRows("sqlite", "main", "items", [{
      primaryKeyValues: { id: 1 },
      values: { label: "edited'; DROP TABLE items; --" },
    }]);
    const database = new SqliteAdapter({ path });
    const rows = await database.query("SELECT id, label FROM items ORDER BY id");
    await database.close();

    expect(results[0]?.rowCount).toBe(1);
    expect(rows.rows).toEqual([
      { id: 1, label: "edited'; DROP TABLE items; --" },
      { id: 2, label: "second" },
    ]);
  });

  it("rejects views, missing tables, non-primary-key locators, and unknown fields", async () => {
    const { service } = await createService();
    const change = [{ primaryKeyValues: { id: 1 }, values: { label: "updated" } }];

    await expect(service.updateTableRows("sqlite", "main", "item_view", change))
      .rejects.toThrow("base table");
    await expect(service.updateTableRows("sqlite", "main", "missing", change))
      .rejects.toThrow("base table");
    await expect(service.updateTableRows("sqlite", "main", "loose", [{
      primaryKeyValues: {}, values: { label: "updated" },
    }])).rejects.toThrow("primary key");
    await expect(service.updateTableRows("sqlite", "main", "items", [{
      primaryKeyValues: { id: 1 }, values: { "label; DROP TABLE items": "updated" },
    }])).rejects.toThrow("not editable");
  });
});
