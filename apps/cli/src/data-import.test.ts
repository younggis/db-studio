import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CoreService } from "@db-studio/core";
import { createProgram } from "./index.js";

const originalType = process.env.DBSTUDIO_DATABASE_TYPE;
const originalSqlitePath = process.env.DBSTUDIO_SQLITE_PATH;
let directory: string | undefined;

afterEach(async () => {
  if (originalType === undefined) delete process.env.DBSTUDIO_DATABASE_TYPE;
  else process.env.DBSTUDIO_DATABASE_TYPE = originalType;
  if (originalSqlitePath === undefined) delete process.env.DBSTUDIO_SQLITE_PATH;
  else process.env.DBSTUDIO_SQLITE_PATH = originalSqlitePath;
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
  vi.restoreAllMocks();
});

describe("dbstudio data import", () => {
  it("creates a typed table from JSON with --create-table", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "db-studio-cli-table-import-"));
    const databasePath = path.join(directory, "test.sqlite");
    const inputPath = path.join(directory, "input.json");
    await writeFile(inputPath, JSON.stringify([
      { id: 1, name: "中文", active: true },
      { id: 2, name: "second", active: false },
    ]), "utf8");
    process.env.DBSTUDIO_DATABASE_TYPE = "sqlite";
    process.env.DBSTUDIO_SQLITE_PATH = databasePath;
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await createProgram().parseAsync([
      "data", "import", "--connection", "environment", "--table", "cli_imported",
      "--input", inputPath, "--format", "json", "--create-table",
    ], { from: "user" });

    const service = CoreService.fromSqliteConfig({ path: databasePath });
    const rows = await service.exportTable("cli_imported");
    expect(rows.rows).toEqual([
      { id: 1, name: "中文", active: 1 },
      { id: 2, name: "second", active: 0 },
    ]);
  });
});
