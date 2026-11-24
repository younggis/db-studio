import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cli = path.join(root, "apps", "cli", "dist", "index.js");
const artifactDirectory = path.join(root, ".cache", "table-data-smoke");
mkdirSync(artifactDirectory, { recursive: true });
assert.ok(existsSync(cli), "Build the CLI first with `pnpm run build`.");

const runId = randomBytes(4).toString("hex");
const dbPath = path.join(artifactDirectory, `sqlite-${runId}.sqlite`);
const csvPath = path.join(artifactDirectory, `sqlite-${runId}.csv`);
const jsonPath = path.join(artifactDirectory, `sqlite-${runId}.json`);
const xlsxPath = path.join(artifactDirectory, `sqlite-${runId}.xlsx`);
const artifactPaths = [dbPath, `${dbPath}-journal`, `${dbPath}-wal`, `${dbPath}-shm`, csvPath, jsonPath, xlsxPath];
assert.ok(artifactPaths.every((artifact) => !existsSync(artifact)), "Refusing to overwrite a pre-existing SQLite smoke artifact.");
const env = { ...process.env, DBSTUDIO_DATABASE_TYPE: "sqlite", DBSTUDIO_SQLITE_PATH: dbPath };
for (const key of ["DBSTUDIO_DATABASE_URL", "DBSTUDIO_MYSQL_URL", "DBSTUDIO_MARIADB_URL", "DATABASE_URL"]) {
  delete env[key];
}

function invoke(args, parseJson = false) {
  try {
    const output = execFileSync(process.execPath, [cli, ...args], {
      cwd: root,
      env,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    }).trim();
    return parseJson ? JSON.parse(output) : output;
  } catch (error) {
    const details = [error.stdout, error.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`dbstudio ${args[0]} ${args[1]} failed${details ? `:\n${details}` : "."}`);
  }
}

const source = `source_${runId}`;
const csvTarget = `csv data ${runId}`;
const jsonTarget = `json data ${runId}`;
const xlsxTarget = `xlsx data ${runId}`;
const quote = (identifier) => `"${identifier.replaceAll('"', '""')}"`;
const rows = [
  { id: 1, "display name": "甲,乙", note: "first line\nsecond line", marker: "\\N" },
  { id: 2, "display name": "乙", note: null, marker: "" },
];

let report;
try {
  invoke(["query", "run", "--sql",
    `CREATE TABLE ${quote(source)} (id INTEGER PRIMARY KEY, "display name" TEXT NOT NULL, note TEXT, marker TEXT)`,
    "--format", "json"], true);
  for (const row of rows) {
    invoke(["query", "run", "--sql",
      `INSERT INTO ${quote(source)} (id, "display name", note, marker) VALUES (?, ?, ?, ?)`,
      "--params", JSON.stringify([row.id, row["display name"], row.note, row.marker]), "--format", "json"], true);
  }

  for (const table of [csvTarget, jsonTarget, xlsxTarget]) {
    invoke(["query", "run", "--sql",
      `CREATE TABLE ${quote(table)} (id INTEGER PRIMARY KEY, "display name" TEXT NOT NULL, note TEXT, marker TEXT)`,
      "--format", "json"], true);
  }
  const csvExport = invoke(["data", "export", "--table", source, "--schema", "main", "--output", csvPath, "--format", "csv"], true);
  const jsonExport = invoke(["data", "export", "--table", source, "--schema", "main", "--output", jsonPath, "--format", "json"], true);
  const xlsxExport = invoke(["data", "export", "--table", source, "--schema", "main", "--output", xlsxPath, "--format", "xlsx"], true);
  assert.equal(csvExport.rowCount, rows.length);
  assert.equal(jsonExport.rowCount, rows.length);
  assert.equal(xlsxExport.rowCount, rows.length);
  assert.match(readFileSync(csvPath, "utf8"), /"\\N"/);

  const csvImport = invoke(["data", "import", "--table", csvTarget, "--schema", "main", "--input", csvPath, "--format", "csv"], true);
  const jsonImport = invoke(["data", "import", "--table", jsonTarget, "--schema", "main", "--input", jsonPath, "--format", "json"], true);
  const xlsxImport = invoke(["data", "import", "--table", xlsxTarget, "--schema", "main", "--input", xlsxPath, "--format", "xlsx"], true);
  assert.equal(csvImport.insertedRows, rows.length);
  assert.equal(jsonImport.insertedRows, rows.length);
  assert.equal(xlsxImport.insertedRows, rows.length);

  for (const table of [csvTarget, jsonTarget, xlsxTarget]) {
    const selected = invoke(["query", "run", "--sql",
      `SELECT id, "display name", note, marker FROM ${quote(table)} ORDER BY id`, "--format", "json"], true);
    assert.deepEqual(selected.rows, rows, `${table}: CSV/JSON transfer changed a value.`);
  }

  report = { engine: "sqlite", serverVersion: invoke(["connections", "test"], true).serverVersion,
    csvRows: csvImport.insertedRows, jsonRows: jsonImport.insertedRows, xlsxRows: xlsxImport.insertedRows,
    nullEmptyAndMarkerPreserved: true };
} finally {
  for (const artifact of artifactPaths) {
    if (existsSync(artifact)) unlinkSync(artifact);
  }
}

assert.ok(artifactPaths.every((artifact) => !existsSync(artifact)), "SQLite smoke artifacts were not fully cleaned.");
process.stdout.write(`${JSON.stringify({ ...report, runId, temporaryArtifactsCleaned: true }, null, 2)}\n`);
