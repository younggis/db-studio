import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteAdapter, type DatabaseAdapter } from "@db-studio/database";
import { CoreService } from "./index.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
  directories.length = 0;
});

async function makeService(prefix: string) {
  const directory = await mkdtemp(join(tmpdir(), `db-studio-${prefix}-`));
  directories.push(directory);
  const path = join(directory, "test.sqlite");
  const adapter = new SqliteAdapter({ path });
  return { path, adapter, service: new CoreService(() => new SqliteAdapter({ path }), {}, false) };
}

describe("CoreService.transferTableRows", () => {
  it("copies a composite-key table in bounded pages and lets destination defaults apply", async () => {
    const source = await makeService("transfer-source");
    const target = await makeService("transfer-target");
    await source.adapter.query("CREATE TABLE items (tenant_id INTEGER NOT NULL, id INTEGER NOT NULL, label TEXT NOT NULL, PRIMARY KEY (tenant_id, id))");
    await source.adapter.query("INSERT INTO items (tenant_id, id, label) VALUES (?, ?, ?)", [1, 1, "one"]);
    await source.adapter.query("INSERT INTO items (tenant_id, id, label) VALUES (?, ?, ?)", [1, 2, "two"]);
    await source.adapter.query("INSERT INTO items (tenant_id, id, label) VALUES (?, ?, ?)", [2, 1, "three"]);
    await target.adapter.query("CREATE TABLE items (tenant_id INTEGER NOT NULL, id INTEGER NOT NULL, label TEXT NOT NULL, copied TEXT NOT NULL DEFAULT 'destination-default', PRIMARY KEY (tenant_id, id))");
    await source.adapter.close();
    await target.adapter.close();

    const result = await source.service.transferTableRows(target.service, {
      sourceTable: "items",
      sourceSchema: "main",
      targetTable: "items",
      targetSchema: "main",
      pageSize: 2,
    });

    const reader = new SqliteAdapter({ path: target.path });
    const rows = await reader.query("SELECT tenant_id, id, label, copied FROM items ORDER BY tenant_id, id");
    await reader.close();
    expect(result).toEqual({ sourceRows: 3, insertedRows: 3, columns: ["tenant_id", "id", "label"] });
    expect(rows.rows).toEqual([
      { tenant_id: 1, id: 1, label: "one", copied: "destination-default" },
      { tenant_id: 1, id: 2, label: "two", copied: "destination-default" },
      { tenant_id: 2, id: 1, label: "three", copied: "destination-default" },
    ]);
  });

  it("maps uniquely matching columns when source and destination case differs", async () => {
    const source = await makeService("transfer-case-source");
    const target = await makeService("transfer-case-target");
    await source.adapter.query('CREATE TABLE items ("id" INTEGER PRIMARY KEY, "label" TEXT NOT NULL)');
    await source.adapter.query('INSERT INTO items ("id", "label") VALUES (?, ?)', [1, "case-map"]);
    await target.adapter.query('CREATE TABLE items ("ID" INTEGER PRIMARY KEY, "LABEL" TEXT NOT NULL)');
    await source.adapter.close();
    await target.adapter.close();

    const result = await source.service.transferTableRows(target.service, {
      sourceTable: "items",
      sourceSchema: "main",
      targetTable: "items",
      targetSchema: "main",
    });
    const reader = new SqliteAdapter({ path: target.path });
    const rows = await reader.query('SELECT "ID", "LABEL" FROM items');
    await reader.close();
    expect(result).toEqual({ sourceRows: 1, insertedRows: 1, columns: ["id", "label"] });
    expect(rows.rows).toEqual([{ ID: 1, LABEL: "case-map" }]);
  });

  it("supports explicit column mappings and does not read skipped source fields", async () => {
    const source = await makeService("transfer-explicit-source");
    const target = await makeService("transfer-explicit-target");
    await source.adapter.query("CREATE TABLE source_items (id INTEGER PRIMARY KEY, display TEXT NOT NULL, legacy_payload BLOB)");
    await source.adapter.query("INSERT INTO source_items (id, display, legacy_payload) VALUES (?, ?, ?)", [1, "mapped", new Uint8Array([0, 255])]);
    await target.adapter.query("CREATE TABLE target_items (record_id INTEGER PRIMARY KEY, label TEXT NOT NULL)");
    await source.adapter.close();
    await target.adapter.close();

    const result = await source.service.transferTableRows(target.service, {
      sourceTable: "source_items",
      sourceSchema: "main",
      targetTable: "target_items",
      targetSchema: "main",
      columnMappings: [
        { sourceColumn: "id", targetColumn: "record_id" },
        { sourceColumn: "display", targetColumn: "label" },
      ],
    });

    const reader = new SqliteAdapter({ path: target.path });
    const rows = await reader.query("SELECT record_id, label FROM target_items");
    await reader.close();
    expect(result).toEqual({ sourceRows: 1, insertedRows: 1, columns: ["id", "display"] });
    expect(rows.rows).toEqual([{ record_id: 1, label: "mapped" }]);
  });

  it("normalizes boolean and JSON values while preserving exact numeric text", async () => {
    const source = await makeService("transfer-convert-source");
    const target = await makeService("transfer-convert-target");
    await source.adapter.query("CREATE TABLE source_values (id INTEGER PRIMARY KEY, count TEXT NOT NULL, active BOOLEAN NOT NULL, payload JSON NOT NULL)");
    await source.adapter.query("INSERT INTO source_values (id, count, active, payload) VALUES (?, ?, ?, ?)", [
      1, "9007199254740993", 1, '{ "ready": true }',
    ]);
    await target.adapter.query("CREATE TABLE target_values (id INTEGER PRIMARY KEY, count INTEGER NOT NULL, active BOOLEAN NOT NULL, payload TEXT NOT NULL)");
    await source.adapter.close();
    await target.adapter.close();

    const result = await source.service.transferTableRows(target.service, {
      sourceTable: "source_values",
      sourceSchema: "main",
      targetTable: "target_values",
      targetSchema: "main",
    });

    const reader = new SqliteAdapter({ path: target.path });
    const rows = await reader.query("SELECT id, CAST(count AS TEXT) AS count, active, payload FROM target_values");
    await reader.close();
    expect(result.insertedRows).toBe(1);
    expect(rows.rows).toEqual([{ id: 1, count: "9007199254740993", active: 1, payload: '{"ready":true}' }]);
  });

  it("reads native JSON as text and preserves null distinctions and exact number tokens", async () => {
    let pageReads = 0;
    let sourceOptions: Parameters<DatabaseAdapter["readTablePage"]>[6];
    let insertedRows: unknown[][] = [];
    const exactJson = "{\"large\":1234567890123456789012345678901234567890,\"fraction\":0.12345678901234567890123456789012345}";
    const sourceAdapter = {
      listTables: async () => [{ schema: "public", name: "source_values", type: "table" }],
      getTableColumns: async () => [
        { name: "id", dataType: "INTEGER", ordinalPosition: 1, primaryKey: true, nullable: false, defaultValue: null },
        { name: "payload", dataType: "JSONB", ordinalPosition: 2, primaryKey: false, nullable: true, defaultValue: null },
      ],
      readTablePage: async (_table: string, _columns: string[], _primaryKeys: string[], _cursor: unknown[] | undefined, _limit: number, _schema?: string, options?: Parameters<DatabaseAdapter["readTablePage"]>[6]) => {
        sourceOptions = options;
        pageReads += 1;
        return {
          columns: ["id", "payload"],
          rows: pageReads === 1
            ? [{ id: 1, payload: "null" }, { id: 2, payload: null }, { id: 3, payload: exactJson }]
            : [],
          rowCount: pageReads === 1 ? 3 : 0,
          command: "SELECT",
        };
      },
      close: async () => undefined,
    } as unknown as DatabaseAdapter;
    const targetAdapter = {
      listTables: async () => [{ schema: "public", name: "target_values", type: "table" }],
      getTableColumns: async () => [
        { name: "id", dataType: "INTEGER", ordinalPosition: 1, primaryKey: true, nullable: false, defaultValue: null },
        { name: "payload", dataType: "JSONB", ordinalPosition: 2, primaryKey: false, nullable: true, defaultValue: null },
      ],
      insertRows: async (_table: string, _columns: string[], rows: unknown[][]) => {
        insertedRows = rows;
        return rows.length;
      },
      close: async () => undefined,
    } as unknown as DatabaseAdapter;
    const source = new CoreService(() => sourceAdapter, {}, true, "postgres");
    const target = new CoreService(() => targetAdapter, {}, true, "postgres");

    const result = await source.transferTableRows(target, {
      sourceTable: "source_values", sourceSchema: "public", targetTable: "target_values", targetSchema: "public",
    });

    expect(sourceOptions?.jsonTextColumns).toEqual(["payload"]);
    expect(result.insertedRows).toBe(3);
    expect(insertedRows).toEqual([[1, "null"], [2, null], [3, exactJson]]);
  });

  it("rejects JSON numbers that MySQL would change while accepting exact numeric round trips", async () => {
    function transfer(payload: string) {
      let pageRead = false;
      let insertedRows: unknown[][] = [];
      const sourceAdapter = {
        listTables: async () => [{ schema: "public", name: "source_values", type: "table" }],
        getTableColumns: async () => [
          { name: "id", dataType: "INTEGER", ordinalPosition: 1, primaryKey: true, nullable: false, defaultValue: null },
          { name: "payload", dataType: "JSONB", ordinalPosition: 2, primaryKey: false, nullable: true, defaultValue: null },
        ],
        readTablePage: async () => {
          if (pageRead) return { columns: ["id", "payload"], rows: [], rowCount: 0, command: "SELECT" };
          pageRead = true;
          return { columns: ["id", "payload"], rows: [{ id: 1, payload }], rowCount: 1, command: "SELECT" };
        },
        close: async () => undefined,
      } as unknown as DatabaseAdapter;
      const targetAdapter = {
        listTables: async () => [{ schema: "test_db", name: "target_values", type: "table" }],
        getTableColumns: async () => [
          { name: "id", dataType: "INTEGER", ordinalPosition: 1, primaryKey: true, nullable: false, defaultValue: null },
          { name: "payload", dataType: "JSON", ordinalPosition: 2, primaryKey: false, nullable: true, defaultValue: null },
        ],
        insertRows: async (_table: string, _columns: string[], rows: unknown[][]) => {
          insertedRows = rows;
          return rows.length;
        },
        close: async () => undefined,
      } as unknown as DatabaseAdapter;
      const source = new CoreService(() => sourceAdapter, {}, true, "postgres");
      const target = new CoreService(() => targetAdapter, {}, true, "mysql");
      const operation = source.transferTableRows(target, {
        sourceTable: "source_values", sourceSchema: "public", targetTable: "target_values", targetSchema: "test_db",
      });
      return { operation, insertedRows: () => insertedRows };
    }

    const exact = '{"text":"123456789012345678901234567890","signedMinimum":-9223372036854775808,"integer":18446744073709551615,"fraction":0.125,"exponent":1e3}';
    const exactTransfer = transfer(exact);
    const exactResult = await exactTransfer.operation;
    expect(exactResult.insertedRows).toBe(1);
    expect(exactTransfer.insertedRows()).toEqual([[1, exact]]);

    const largeIntegerTransfer = transfer('{"large":1234567890123456789012345678901234567890}');
    await expect(largeIntegerTransfer.operation).rejects.toThrow("MySQL JSON would change this number");
    expect(largeIntegerTransfer.insertedRows()).toEqual([]);
    const preciseFractionTransfer = transfer('{"fraction":0.12345678901234567890123456789012345}');
    await expect(preciseFractionTransfer.operation).rejects.toThrow("MySQL JSON would change this number");
    expect(preciseFractionTransfer.insertedRows()).toEqual([]);
    for (const payload of [
      '{"belowSignedMinimum":-9223372036854775809}',
      '{"aboveUnsignedMaximum":18446744073709551616}',
      '{"underflow":1e-324}',
    ]) {
      const rejectedTransfer = transfer(payload);
      await expect(rejectedTransfer.operation).rejects.toThrow("MySQL JSON would change this number");
      expect(rejectedTransfer.insertedRows()).toEqual([]);
    }
  });

  it("rejects duplicate or unknown explicit column mappings before inserting", async () => {
    const source = await makeService("transfer-invalid-map-source");
    const target = await makeService("transfer-invalid-map-target");
    await source.adapter.query("CREATE TABLE source_items (id INTEGER PRIMARY KEY, label TEXT NOT NULL)");
    await source.adapter.query("INSERT INTO source_items (id, label) VALUES (1, 'one')");
    await target.adapter.query("CREATE TABLE target_items (id INTEGER PRIMARY KEY, label TEXT NOT NULL)");
    await source.adapter.close();
    await target.adapter.close();

    await expect(source.service.transferTableRows(target.service, {
      sourceTable: "source_items", targetTable: "target_items",
      columnMappings: [
        { sourceColumn: "id", targetColumn: "id" },
        { sourceColumn: "label", targetColumn: "id" },
      ],
    })).rejects.toThrow("maps multiple source columns");
    await expect(source.service.transferTableRows(target.service, {
      sourceTable: "source_items", targetTable: "target_items",
      columnMappings: [{ sourceColumn: "missing", targetColumn: "label" }],
    })).rejects.toThrow("has no column 'missing'");
  });

  it("rejects views and sources without a primary key before writing", async () => {
    const source = await makeService("transfer-invalid-source");
    const target = await makeService("transfer-invalid-target");
    await source.adapter.query("CREATE TABLE loose (label TEXT NOT NULL)");
    await source.adapter.query("CREATE VIEW loose_view AS SELECT label FROM loose");
    await target.adapter.query("CREATE TABLE loose (label TEXT NOT NULL)");
    await source.adapter.close();
    await target.adapter.close();

    await expect(source.service.transferTableRows(target.service, {
      sourceTable: "loose_view", targetTable: "loose",
    })).rejects.toThrow("base table");
    await expect(source.service.transferTableRows(target.service, {
      sourceTable: "loose", targetTable: "loose",
    })).rejects.toThrow("primary key");
  });

  it("rejects a spatial primary key before reading or writing any page", async () => {
    const column = { name: "shape", dataType: "geometry(Point,3857)", nullable: false, defaultValue: null, primaryKey: true, ordinalPosition: 1 };
    const makeAdapter = () => ({
      listTables: vi.fn().mockResolvedValue([{ name: "items", type: "table" }]),
      getTableColumns: vi.fn().mockResolvedValue([column]),
      readTablePage: vi.fn(),
      insertRows: vi.fn(),
      close: vi.fn(),
    });
    const sourceAdapter = makeAdapter();
    const targetAdapter = makeAdapter();
    const source = new CoreService(() => sourceAdapter as unknown as DatabaseAdapter, {}, false, "postgres");
    const target = new CoreService(() => targetAdapter as unknown as DatabaseAdapter, {}, false, "postgres");
    await expect(source.transferTableRows(target, {
      sourceTable: "items",
      targetTable: "items",
      sourceSchema: "public",
      targetSchema: "public",
    })).rejects.toThrow("Spatial primary-key column 'shape' cannot be used for bounded keyset transfer.");
    expect(sourceAdapter.readTablePage).not.toHaveBeenCalled();
    expect(targetAdapter.insertRows).not.toHaveBeenCalled();
  });

  it("lists Oracle SDO_GEOMETRY among supported geometry engines", async () => {
    const source = await makeService("transfer-unsupported-spatial-source");
    const target = await makeService("transfer-unsupported-spatial-target");
    await source.adapter.query("CREATE TABLE source_items (id INTEGER PRIMARY KEY, shape geometry)");
    await target.adapter.query("CREATE TABLE target_items (id INTEGER PRIMARY KEY, shape geometry)");
    await source.adapter.close();
    await target.adapter.close();

    await expect(source.service.transferTableRows(target.service, {
      sourceTable: "source_items",
      targetTable: "target_items",
      sourceSchema: "main",
      targetSchema: "main",
    })).rejects.toThrow("Geometry row transfer supports PostgreSQL/PostGIS, SQL Server, MySQL, MariaDB, Oracle SDO_GEOMETRY, and SQLite/GeoPackage.");
  });

  it("reports rows already committed when a later destination page fails", async () => {
    const source = await makeService("transfer-partial-source");
    const target = await makeService("transfer-partial-target");
    await source.adapter.query("CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT NOT NULL)");
    await source.adapter.query("INSERT INTO items (id, label) VALUES (?, ?)", [1, "one"]);
    await source.adapter.query("INSERT INTO items (id, label) VALUES (?, ?)", [2, "duplicate"]);
    await target.adapter.query("CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT NOT NULL UNIQUE)");
    await target.adapter.query("INSERT INTO items (id, label) VALUES (?, ?)", [9, "duplicate"]);
    await source.adapter.close();
    await target.adapter.close();

    await expect(source.service.transferTableRows(target.service, {
      sourceTable: "items", targetTable: "items", pageSize: 1,
    })).rejects.toThrow("after 1 rows were committed");

    const reader = new SqliteAdapter({ path: target.path });
    const rows = await reader.query("SELECT id, label FROM items ORDER BY id");
    await reader.close();
    expect(rows.rows).toEqual([{ id: 1, label: "one" }, { id: 9, label: "duplicate" }]);
  });
});
