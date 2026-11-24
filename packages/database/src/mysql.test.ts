import { describe, expect, it, vi } from "vitest";
import { MariaDbAdapter, MySqlAdapter, mariaDbConfigFromEnvironment, mysqlConfigFromEnvironment } from "./mysql.js";

describe("MariaDbAdapter.getTableColumns", () => {
  it("reports JSON aliases as JSON when MariaDB exposes a JSON_VALID check", async () => {
    const adapter = new MariaDbAdapter({ host: "127.0.0.1", port: 3306, user: "tester", database: "sample" });
    const query = vi.spyOn(adapter, "query")
      .mockResolvedValueOnce({
        columns: ["name", "data_type", "nullable", "default_value", "primary_key", "ordinal_position"],
        rows: [
          { name: "id", data_type: "int(11)", nullable: false, default_value: null, primary_key: true, ordinal_position: 1 },
          { name: "payload", data_type: "longtext", nullable: true, default_value: null, primary_key: false, ordinal_position: 2 },
          { name: "notes", data_type: "longtext", nullable: true, default_value: null, primary_key: false, ordinal_position: 3 },
        ],
        rowCount: 3,
        command: "SELECT",
      })
      .mockResolvedValueOnce({
        columns: ["check_clause"],
        rows: [{ check_clause: "json_valid(`payload`)" }],
        rowCount: 1,
        command: "SELECT",
      });

    await expect(adapter.getTableColumns("features")).resolves.toMatchObject([
      { name: "id", dataType: "int(11)" },
      { name: "payload", dataType: "JSON" },
      { name: "notes", dataType: "longtext" },
    ]);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenNthCalledWith(2, expect.stringContaining("information_schema.CHECK_CONSTRAINTS"), ["sample", "features"]);
  });

  it("keeps ordinary LONGTEXT columns unchanged when no JSON_VALID check matches", async () => {
    const adapter = new MariaDbAdapter({ host: "127.0.0.1", port: 3306, user: "tester", database: "sample" });
    vi.spyOn(adapter, "query")
      .mockResolvedValueOnce({
        columns: ["name", "data_type", "nullable", "default_value", "primary_key", "ordinal_position"],
        rows: [{ name: "payload", data_type: "longtext", nullable: true, default_value: null, primary_key: false, ordinal_position: 1 }],
        rowCount: 1,
        command: "SELECT",
      })
      .mockResolvedValueOnce({
        columns: ["check_clause"],
        rows: [{ check_clause: "json_valid(`other_payload`)" }],
        rowCount: 1,
        command: "SELECT",
      });

    await expect(adapter.getTableColumns("features")).resolves.toMatchObject([
      { name: "payload", dataType: "longtext" },
    ]);
  });
});

describe("MySQL-family spatial row inserts", () => {
  it("constructs MySQL geometries from parameterized WKB and SRID with explicit axis order", async () => {
    const adapter = new MySqlAdapter({ host: "127.0.0.1", port: 3306, user: "tester", database: "sample" });
    const wkb = Buffer.from("0101000000000000000000f03f0000000000000040", "hex");
    const connection = {
      beginTransaction: vi.fn().mockResolvedValue(undefined),
      execute: vi.fn().mockResolvedValue([{ affectedRows: 2 }, []]),
      commit: vi.fn().mockResolvedValue(undefined),
      rollback: vi.fn().mockResolvedValue(undefined),
    };
    vi.spyOn(adapter as unknown as { getConnection: () => Promise<unknown> }, "getConnection")
      .mockResolvedValue(connection);

    await expect(adapter.insertRows("target", ["id", "shape"], [
      [1, { kind: "db-studio-spatial-wkb", spatialType: "geometry", wkb, srid: 4326 }],
      [2, null],
    ])).resolves.toBe(2);

    expect(connection.execute).toHaveBeenCalledWith(
      "INSERT INTO `sample`.`target` (`id`, `shape`) VALUES (?, ST_GeomFromWKB(?, ?, 'axis-order=long-lat')), (?, ?)",
      [1, wkb, 4326, 2, null],
    );
    expect(connection.commit).toHaveBeenCalledOnce();
    expect(connection.rollback).not.toHaveBeenCalled();
  });

  it("uses MariaDB's two-argument WKB constructor", async () => {
    const adapter = new MariaDbAdapter({ host: "127.0.0.1", port: 3306, user: "tester", database: "sample" });
    const wkb = Buffer.from("0101000000000000000000f03f0000000000000040", "hex");
    const connection = {
      beginTransaction: vi.fn().mockResolvedValue(undefined),
      execute: vi.fn().mockResolvedValue([{ affectedRows: 1 }, []]),
      commit: vi.fn().mockResolvedValue(undefined),
      rollback: vi.fn().mockResolvedValue(undefined),
    };
    vi.spyOn(adapter as unknown as { getConnection: () => Promise<unknown> }, "getConnection")
      .mockResolvedValue(connection);

    await expect(adapter.insertRows("target", ["id", "shape"], [
      [1, { kind: "db-studio-spatial-wkb", spatialType: "geometry", wkb, srid: 3857 }],
    ])).resolves.toBe(1);

    expect(connection.execute).toHaveBeenCalledWith(
      "INSERT INTO `sample`.`target` (`id`, `shape`) VALUES (?, ST_GeomFromWKB(?, ?))",
      [1, wkb, 3857],
    );
    expect(connection.commit).toHaveBeenCalledOnce();
    expect(connection.rollback).not.toHaveBeenCalled();
  });
});

describe("mysqlConfigFromEnvironment", () => {
  it("parses a MySQL URL without exposing its password", () => {
    expect(
      mysqlConfigFromEnvironment({
        DBSTUDIO_DATABASE_URL: "mysql://gis%20user:s3cret@db.example:3307/spatial%20data",
      }),
    ).toEqual({
      host: "db.example",
      port: 3307,
      user: "gis user",
      password: "s3cret",
      database: "spatial data",
    });
  });

  it("uses explicit MySQL environment values and safe local defaults", () => {
    expect(
      mysqlConfigFromEnvironment({ MYSQL_USER: "reader", MYSQL_DATABASE: "sample" }),
    ).toEqual({
      host: "127.0.0.1",
      port: 3306,
      user: "reader",
      password: undefined,
      database: "sample",
      connectTimeout: 10_000,
    });
  });

  it("rejects non-MySQL URLs and invalid ports", () => {
    expect(() => mysqlConfigFromEnvironment({ DBSTUDIO_DATABASE_URL: "postgres://localhost/db" }))
      .toThrow("mysql: protocol");
    expect(() => mysqlConfigFromEnvironment({ MYSQL_USER: "reader", MYSQL_PORT: "70000" }))
      .toThrow("MYSQL_PORT");
  });
});

describe("mariaDbConfigFromEnvironment", () => {
  it("maps MariaDB-specific variables and URL schemes onto the shared wire adapter", () => {
    expect(
      mariaDbConfigFromEnvironment({
        DBSTUDIO_MARIADB_URL: "mariadb://reader:secret@localhost:3308/spatial",
        MARIADB_USER: "ignored-by-url",
      }),
    ).toEqual({
      host: "localhost",
      port: 3308,
      user: "reader",
      password: "secret",
      database: "spatial",
    });
    expect(
      mariaDbConfigFromEnvironment({ MARIADB_USER: "reader", MARIADB_DATABASE: "sample" }),
    ).toMatchObject({ host: "127.0.0.1", port: 3306, user: "reader", database: "sample" });
  });
});
