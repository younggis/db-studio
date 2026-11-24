import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cli = path.join(root, "apps", "cli", "dist", "index.js");
const envPath = path.join(root, "docker", ".env");

function parseEnvFile(file) {
  if (!existsSync(file)) return {};
  return Object.fromEntries(readFileSync(file, "utf8").split(/\r?\n/)
    .map((line) => line.match(/^\s*([^#=]+)=(.*)$/))
    .filter(Boolean)
    .map((match) => [match[1].trim(), match[2].trim().replace(/^(['"])(.*)\1$/, "$2")]));
}

const dockerEnv = parseEnvFile(envPath);
assert.ok(existsSync(cli), "Build the CLI first with `pnpm run build`.");
assert.ok(dockerEnv.ORACLE_PASSWORD, "Set ORACLE_PASSWORD in docker/.env after authorizing the Oracle Free test container.");

const environment = {
  ...process.env,
  DBSTUDIO_DATABASE_TYPE: "oracle",
  ORACLE_HOST: "127.0.0.1",
  ORACLE_PORT: dockerEnv.ORACLE_PORT || "21521",
  ORACLE_SERVICE_NAME: dockerEnv.ORACLE_SERVICE_NAME || "FREEPDB1",
  ORACLE_USER: dockerEnv.ORACLE_USER || "SYSTEM",
  ORACLE_PASSWORD: dockerEnv.ORACLE_PASSWORD,
  ORACLE_CONNECT_TIMEOUT: "15",
  ORACLE_CALL_TIMEOUT: "30000",
};
for (const key of ["DBSTUDIO_DATABASE_URL", "DATABASE_URL", "DBSTUDIO_ORACLE_CONNECT_STRING", "ORACLE_CONNECT_STRING"]) {
  delete environment[key];
}

const artifactDirectory = path.join(root, ".cache", "oracle-smoke");
mkdirSync(artifactDirectory, { recursive: true });
const runId = randomBytes(4).toString("hex").toUpperCase();
const source = `DBSI_ORA_${runId}`;
const csvTarget = `${source}_CSV`;
const jsonTarget = `${source}_JSON`;
const xlsxTarget = `${source}_XLSX`;
const view = `${source}_VIEW`;
const quote = (identifier) => `"${identifier.replaceAll('"', '""')}"`;
const csvFile = path.join(artifactDirectory, `${source}.csv`);
const jsonFile = path.join(artifactDirectory, `${source}.json`);
const xlsxFile = path.join(artifactDirectory, `${source}.xlsx`);
const artifactPaths = [csvFile, jsonFile, xlsxFile];
assert.ok(artifactPaths.every((artifact) => !existsSync(artifact)), "Refusing to overwrite a pre-existing Oracle smoke artifact.");

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

function createTable(name) {
  invoke(["query", "run", "--sql",
    `CREATE TABLE ${quote(name)} (ID NUMBER(10) NOT NULL PRIMARY KEY, LABEL NVARCHAR2(120) NOT NULL, NOTE NVARCHAR2(120))`,
    "--format", "json"], true);
}

const report = { engine: "oracle", service: environment.ORACLE_SERVICE_NAME };
try {
  const connection = invoke(["connections", "test"], true);
  assert.equal(connection.ok, true, "Oracle connection test failed.");
  assert.ok(connection.serverVersion, "Oracle server version was not returned.");
  const databases = invoke(["databases", "list"], true);
  assert.ok(databases.length > 0, "Oracle database name was not returned.");
  const schemas = invoke(["schemas", "list"], true);
  assert.ok(schemas.includes(environment.ORACLE_USER.toUpperCase()), "Oracle did not list the connected schema.");

  createTable(source);
  for (const target of [csvTarget, jsonTarget, xlsxTarget]) createTable(target);
  invoke(["query", "run", "--sql", `INSERT INTO ${quote(source)} (ID, LABEL, NOTE) VALUES (:1, :2, :3)`,
    "--params", JSON.stringify([1, "Oracle-中文", "round-trip"]), "--format", "json"], true);
  invoke(["query", "run", "--sql", `INSERT INTO ${quote(source)} (ID, LABEL, NOTE) VALUES (:1, :2, NULL)`,
    "--params", JSON.stringify([2, "Oracle-空值"]), "--format", "json"], true);

  const selected = invoke(["query", "run", "--sql", `SELECT LABEL, NOTE FROM ${quote(source)} WHERE ID = :1`,
    "--params", "[1]", "--format", "json"], true);
  assert.deepEqual(selected.rows, [{ LABEL: "Oracle-中文", NOTE: "round-trip" }]);
  const objects = invoke(["tables", "list", "--schema", environment.ORACLE_USER], true);
  assert.ok(objects.some((item) => item.name === source && item.type === "table"));
  invoke(["query", "run", "--sql", `CREATE VIEW ${quote(view)} AS SELECT ID, LABEL FROM ${quote(source)}`, "--format", "json"], true);
  assert.ok(invoke(["tables", "list", "--schema", environment.ORACLE_USER], true).some((item) => item.name === view && item.type === "view"));
  const columns = invoke(["tables", "columns", "--table", source, "--schema", environment.ORACLE_USER], true);
  assert.ok(columns.find((column) => column.name === "ID")?.primaryKey, "Oracle primary key metadata was not reported.");

  const exports = [
    ["csv", csvFile], ["json", jsonFile], ["xlsx", xlsxFile],
  ].map(([format, file]) => invoke(["data", "export", "--table", source, "--schema", environment.ORACLE_USER,
    "--output", file, "--format", format], true));
  assert.ok(exports.every((result) => result.rowCount === 2));
  const imports = [
    ["csv", csvFile, csvTarget], ["json", jsonFile, jsonTarget], ["xlsx", xlsxFile, xlsxTarget],
  ].map(([format, file, target]) => invoke(["data", "import", "--table", target, "--schema", environment.ORACLE_USER,
    "--input", file, "--format", format], true));
  assert.ok(imports.every((result) => result.insertedRows === 2));
  for (const target of [csvTarget, jsonTarget, xlsxTarget]) {
    const roundTrip = invoke(["query", "run", "--sql", `SELECT LABEL, NOTE FROM ${quote(target)} ORDER BY ID`, "--format", "json"], true);
    assert.deepEqual(roundTrip.rows, [
      { LABEL: "Oracle-中文", NOTE: "round-trip" },
      { LABEL: "Oracle-空值", NOTE: null },
    ]);
  }

  report.database = connection.database;
  report.serverVersion = connection.serverVersion;
  report.schemas = schemas.length;
  report.objectsAndColumnsListed = true;
  report.parameterizedQuery = selected.rows[0];
  report.tableDataTransfer = { csv: 2, json: 2, xlsx: 2, nullPreserved: true };
} finally {
  try { invoke(["query", "run", "--sql", `DROP VIEW ${quote(view)}`, "--format", "json"], true); }
  catch { /* Preserve the original failure if Oracle is unavailable during cleanup. */ }
  for (const table of [csvTarget, jsonTarget, xlsxTarget, source]) {
    try { invoke(["query", "run", "--sql", `DROP TABLE ${quote(table)}`, "--format", "json"], true); }
    catch { /* Preserve the original failure if Oracle is unavailable during cleanup. */ }
  }
  for (const artifact of artifactPaths) {
    if (existsSync(artifact)) unlinkSync(artifact);
  }
}

process.stdout.write(`${JSON.stringify({ results: [report] }, null, 2)}\n`);
