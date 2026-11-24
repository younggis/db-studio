import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cli = path.join(root, "apps", "cli", "dist", "index.js");
const envFile = path.join(root, "docker", ".env");

function parseEnvFile(file) {
  if (!existsSync(file)) return {};
  return Object.fromEntries(readFileSync(file, "utf8").split(/\r?\n/)
    .map((line) => line.match(/^\s*([^#=]+)=(.*)$/))
    .filter(Boolean)
    .map((match) => [match[1].trim(), match[2].trim().replace(/^(['"])(.*)\1$/, "$2")]));
}

const dockerEnv = parseEnvFile(envFile);
assert.ok(existsSync(cli), "Build the CLI first with `pnpm run build`.");
assert.ok(dockerEnv.SQLSERVER_SA_PASSWORD, "Set SQLSERVER_SA_PASSWORD in docker/.env.");

const database = "dbstudio_test";
const host = "127.0.0.1";
const port = dockerEnv.SQLSERVER_PORT || "21433";
const environment = {
  ...process.env,
  DBSTUDIO_DATABASE_TYPE: "sqlserver",
  SQLSERVER_HOST: host,
  SQLSERVER_PORT: port,
  SQLSERVER_DATABASE: "master",
  SQLSERVER_USER: "sa",
  SQLSERVER_PASSWORD: dockerEnv.SQLSERVER_SA_PASSWORD,
  SQLSERVER_ENCRYPT: "true",
  SQLSERVER_TRUST_SERVER_CERTIFICATE: "true",
  SQLSERVER_CONNECT_TIMEOUT: "15000",
  SQLSERVER_REQUEST_TIMEOUT: "30000",
};
for (const key of ["DBSTUDIO_DATABASE_URL", "DATABASE_URL", "DBSTUDIO_SQLSERVER_URL", "SQLSERVER_URL"]) delete environment[key];

const artifactDirectory = path.join(root, ".cache", "sqlserver-smoke");
mkdirSync(artifactDirectory, { recursive: true });
const runId = randomBytes(4).toString("hex");
const table = `dbsi_sql_${runId}`;
const csvTable = `${table}_csv`;
const jsonTable = `${table}_json`;
const xlsxTable = `${table}_xlsx`;
const rollbackTable = `${table}_rollback`;
const view = `${table}_view`;
const quote = (identifier) => `[${identifier.replaceAll("]", "]]" )}]`;
const csvFile = path.join(artifactDirectory, `${table}.csv`);
const jsonFile = path.join(artifactDirectory, `${table}.json`);
const xlsxFile = path.join(artifactDirectory, `${table}.xlsx`);
const rollbackFile = path.join(artifactDirectory, `${table}-rollback.csv`);
const artifactPaths = [csvFile, jsonFile, xlsxFile, rollbackFile];
assert.ok(artifactPaths.every((artifact) => !existsSync(artifact)), "Refusing to overwrite a pre-existing SQL Server smoke artifact.");

function invoke(args, parseJson = false) {
  try {
    const output = execFileSync(process.execPath, [cli, ...args], {
      cwd: root,
      env: environment,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    }).trim();
    return parseJson ? JSON.parse(output) : output;
  } catch (error) {
    const details = [error.stdout, error.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`dbstudio ${args.slice(0, 2).join(" ")} failed${details ? `:\n${details}` : "."}`);
  }
}

const connection = invoke(["connections", "test", "--connection", "environment"], true);
assert.equal(connection.ok, true, "SQL Server connection test failed.");
assert.equal(connection.database, "master", "Connected to an unexpected bootstrap database.");

const databases = invoke(["databases", "list"], true);
if (!databases.includes(database)) {
  invoke(["query", "run", "--sql", `CREATE DATABASE ${quote(database)}`, "--format", "json"], true);
}
environment.SQLSERVER_DATABASE = database;
const tableSql = `${quote("dbo")}.${quote(table)}`;
const csvTableSql = `${quote("dbo")}.${quote(csvTable)}`;
const jsonTableSql = `${quote("dbo")}.${quote(jsonTable)}`;
const xlsxTableSql = `${quote("dbo")}.${quote(xlsxTable)}`;
const rollbackTableSql = `${quote("dbo")}.${quote(rollbackTable)}`;
const viewSql = `${quote("dbo")}.${quote(view)}`;
const report = { engine: "sqlserver", database, serverVersion: connection.serverVersion };

function createTable(target) {
  invoke(["query", "run", "--sql",
    `CREATE TABLE ${target} ([id] int NOT NULL PRIMARY KEY, [label] nvarchar(120) NOT NULL, [note] nvarchar(max) NULL)`,
    "--format", "json"], true);
}

try {
  createTable(tableSql);
  invoke(["query", "run", "--sql", `INSERT INTO ${tableSql} ([id], [label], [note]) VALUES (@p1, @p2, @p3)`,
    "--params", JSON.stringify([1, "SQL Server-中文", "round-trip"]), "--format", "json"], true);
  invoke(["query", "run", "--sql", `INSERT INTO ${tableSql} ([id], [label], [note]) VALUES (@p1, @p2, NULL)`,
    "--params", JSON.stringify([2, "SQL Server-空值"]), "--format", "json"], true);

  const selected = invoke(["query", "run", "--sql", `SELECT [label], [note] FROM ${tableSql} WHERE [id] = @p1`,
    "--params", "[1]", "--format", "json"], true);
  assert.equal(selected.rowCount, 1, "SQL Server parameterized query returned an unexpected row count.");
  assert.deepEqual(selected.rows[0], { label: "SQL Server-中文", note: "round-trip" });

  invoke(["query", "run", "--sql", `CREATE VIEW ${viewSql} AS SELECT [id], [label] FROM ${tableSql}`, "--format", "json"], true);
  const objects = invoke(["tables", "list", "--schema", "dbo"], true);
  assert.ok(objects.some((item) => item.name === table && item.type === "table"), "SQL Server table was not listed.");
  assert.ok(objects.some((item) => item.name === view && item.type === "view"), "SQL Server view was not listed.");

  const columns = invoke(["tables", "columns", "--table", table, "--schema", "dbo"], true);
  const idColumn = columns.find((column) => column.name === "id");
  const labelColumn = columns.find((column) => column.name === "label");
  assert.ok(idColumn?.primaryKey, "SQL Server primary-key metadata was not reported.");
  assert.ok(labelColumn && !labelColumn.nullable, "SQL Server nullability metadata was not reported.");
  assert.ok(idColumn.ordinalPosition < labelColumn.ordinalPosition, "SQL Server field order was not reported.");

  const exportedCsv = invoke(["data", "export", "--table", table, "--schema", "dbo", "--output", csvFile, "--format", "csv"], true);
  const exportedJson = invoke(["data", "export", "--table", table, "--schema", "dbo", "--output", jsonFile, "--format", "json"], true);
  const exportedXlsx = invoke(["data", "export", "--table", table, "--schema", "dbo", "--output", xlsxFile, "--format", "xlsx"], true);
  assert.equal(exportedCsv.rowCount, 2);
  assert.equal(exportedJson.rowCount, 2);
  assert.equal(exportedXlsx.rowCount, 2);
  assert.ok(readFileSync(csvFile, "utf8").includes("\\N"), "SQL Server CSV export did not preserve SQL NULL.");
  for (const target of [csvTableSql, jsonTableSql, xlsxTableSql, rollbackTableSql]) createTable(target);

  const importedCsv = invoke(["data", "import", "--table", csvTable, "--schema", "dbo", "--input", csvFile, "--format", "csv"], true);
  const importedJson = invoke(["data", "import", "--table", jsonTable, "--schema", "dbo", "--input", jsonFile, "--format", "json"], true);
  const importedXlsx = invoke(["data", "import", "--table", xlsxTable, "--schema", "dbo", "--input", xlsxFile, "--format", "xlsx"], true);
  assert.equal(importedCsv.insertedRows, 2);
  assert.equal(importedJson.insertedRows, 2);
  assert.equal(importedXlsx.insertedRows, 2);
  for (const target of [csvTableSql, jsonTableSql, xlsxTableSql]) {
    const roundTrip = invoke(["query", "run", "--sql", `SELECT [label], [note] FROM ${target} ORDER BY [id]`, "--format", "json"], true);
    assert.deepEqual(roundTrip.rows, [
      { label: "SQL Server-中文", note: "round-trip" },
      { label: "SQL Server-空值", note: null },
    ]);
  }

  const invalidRows = ["id,label,note", ...Array.from({ length: 501 }, (_, index) => `${index + 1},row-${index + 1},`), "1,duplicate,"];
  writeFileSync(rollbackFile, `${invalidRows.join("\n")}\n`, "utf8");
  let duplicateRejected = false;
  try {
    invoke(["data", "import", "--table", rollbackTable, "--schema", "dbo", "--input", rollbackFile, "--format", "csv"], true);
  } catch { duplicateRejected = true; }
  assert.equal(duplicateRejected, true, "SQL Server duplicate primary keys should reject the import.");
  const rollbackCount = invoke(["query", "run", "--sql", `SELECT COUNT(*) AS [count] FROM ${rollbackTableSql}`, "--format", "json"], true);
  assert.equal(rollbackCount.rows[0].count, 0, "A failed multi-batch SQL Server import must roll back all rows.");
  report.tablesAndViewsListed = true;
  report.columnsInspected = columns.length;
  report.parameterizedQuery = selected.rows[0];
  report.tableDataTransfer = { csvExportAndImport: 2, jsonExportAndImport: 2, xlsxExportAndImport: 2, nullPreserved: true, multiBatchRollback: true };
} finally {
  try { invoke(["query", "run", "--sql", `DROP VIEW IF EXISTS ${viewSql}`, "--format", "json"], true); }
  catch { /* Preserve the original failure if SQL Server is unavailable during cleanup. */ }
  for (const target of [csvTableSql, jsonTableSql, xlsxTableSql, rollbackTableSql, tableSql]) {
    try { invoke(["query", "run", "--sql", `DROP TABLE IF EXISTS ${target}`, "--format", "json"], true); }
    catch { /* Preserve the original failure if SQL Server is unavailable during cleanup. */ }
  }
  for (const artifact of artifactPaths) {
    if (existsSync(artifact)) unlinkSync(artifact);
  }
}

process.stdout.write(`${JSON.stringify({ results: [report] }, null, 2)}\n`);
