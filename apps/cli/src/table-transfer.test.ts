import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CoreService } from "@db-studio/core";
import { addConnectionProfile } from "./connections.js";
import { createProgram } from "./index.js";

const environmentKeys = ["DBSTUDIO_CONFIG_HOME", "DBSTUDIO_DATABASE_TYPE", "DBSTUDIO_SQLITE_PATH"] as const;
const originalEnvironment = new Map(environmentKeys.map((key) => [key, process.env[key]]));
let directory: string | undefined;

afterEach(async () => {
  for (const key of environmentKeys) {
    const value = originalEnvironment.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
  vi.restoreAllMocks();
});

describe("dbstudio table transfer", () => {
  it("transfers a paged subset between named SQLite connections using explicit column mappings", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "db-studio-cli-table-transfer-"));
    const sourcePath = path.join(directory, "source.sqlite");
    const targetPath = path.join(directory, "target.sqlite");
    process.env.DBSTUDIO_CONFIG_HOME = directory;
    delete process.env.DBSTUDIO_DATABASE_TYPE;
    delete process.env.DBSTUDIO_SQLITE_PATH;
    await addConnectionProfile({ name: "source", engine: "sqlite", path: sourcePath });
    await addConnectionProfile({ name: "target", engine: "sqlite", path: targetPath });

    const source = CoreService.fromSqliteConfig({ path: sourcePath });
    const target = CoreService.fromSqliteConfig({ path: targetPath });
    await source.query("CREATE TABLE source_items (id INTEGER PRIMARY KEY, name TEXT, ignored TEXT)");
    await source.query("INSERT INTO source_items (id, name, ignored) VALUES (?, ?, ?), (?, ?, ?), (?, ?, ?)", [
      1, "成都", "skip-a", 2, "兰州", "skip-b", 3, "重庆", "skip-c",
    ]);
    await target.query("CREATE TABLE target_items (id INTEGER PRIMARY KEY, full_name TEXT NOT NULL)");
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await createProgram().parseAsync([
      "tables", "transfer",
      "--source-connection", "source",
      "--target-connection", "target",
      "--source-table", "source_items",
      "--target-table", "target_items",
      "--page-size", "1",
      "--map", "id=id",
      "--map", "name=full_name",
    ], { from: "user" });

    expect(await target.exportTable("target_items")).toMatchObject({
      rows: [
        { id: 1, full_name: "成都" },
        { id: 2, full_name: "兰州" },
        { id: 3, full_name: "重庆" },
      ],
    });
    expect(output.mock.calls.map(([chunk]) => String(chunk)).join("")).toContain('"sourceRows": 3');
    expect(output.mock.calls.map(([chunk]) => String(chunk)).join("")).toContain('"insertedRows": 3');
  });

  it("rejects malformed or duplicate source-column mappings before connecting", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "db-studio-cli-table-transfer-args-"));
    process.env.DBSTUDIO_CONFIG_HOME = directory;
    await addConnectionProfile({ name: "source", engine: "sqlite", path: path.join(directory, "source.sqlite") });
    await addConnectionProfile({ name: "target", engine: "sqlite", path: path.join(directory, "target.sqlite") });
    const prefix = [
      "tables", "transfer",
      "--source-connection", "source",
      "--target-connection", "target",
      "--source-table", "source_items",
      "--target-table", "target_items",
    ];

    await expect(createProgram().parseAsync([...prefix, "--map", "source"], { from: "user" }))
      .rejects.toThrow("--map must use source=target");
    await expect(createProgram().parseAsync([...prefix, "--map", "name=first", "--map", "name=second"], { from: "user" }))
      .rejects.toThrow("--map is repeated for source column 'name'");
  });

  it("applies database overrides to the selected engine's profile environment", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "db-studio-cli-table-transfer-db-override-"));
    process.env.DBSTUDIO_CONFIG_HOME = directory;
    await addConnectionProfile({
      name: "maria-source", engine: "mariadb", host: "db.local", user: "reader", database: "original",
    });
    await addConnectionProfile({ name: "sqlite-target", engine: "sqlite", path: path.join(directory, "target.sqlite") });
    const environments: NodeJS.ProcessEnv[] = [];
    const service = {
      transferTableRows: vi.fn().mockResolvedValue({ sourceRows: 0, insertedRows: 0, columns: ["id"] }),
    } as unknown as CoreService;
    vi.spyOn(CoreService, "fromEnvironment").mockImplementation((environment = process.env) => {
      environments.push({ ...environment });
      return service;
    });
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await createProgram().parseAsync([
      "tables", "transfer",
      "--source-connection", "maria-source",
      "--source-database", "reporting",
      "--target-connection", "sqlite-target",
      "--source-table", "source_items",
      "--target-table", "target_items",
    ], { from: "user" });

    expect(environments[0]).toMatchObject({
      DBSTUDIO_DATABASE_TYPE: "mariadb",
      MARIADB_DATABASE: "reporting",
      MARIADB_HOST: "db.local",
    });
    expect(environments[0]?.MYSQL_DATABASE).toBeUndefined();
  });
});
