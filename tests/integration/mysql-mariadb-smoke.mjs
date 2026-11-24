import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cli = path.join(root, "apps", "cli", "dist", "index.js");
const localEnvPath = path.join(root, "docker", ".env");

function parseEnvFile(file) {
  if (!existsSync(file)) return {};
  return Object.fromEntries(readFileSync(file, "utf8").split(/\r?\n/)
    .map((line) => line.match(/^\s*([^#=]+)=(.*)$/))
    .filter(Boolean)
    .map((match) => [match[1].trim(), match[2].trim().replace(/^(["'])(.*)\1$/, "$2")]));
}

const dockerEnv = parseEnvFile(localEnvPath);
assert.ok(existsSync(cli), "Build the CLI first with `pnpm run build`.");
const artifactDirectory = path.join(root, ".cache", "table-data-smoke");
mkdirSync(artifactDirectory, { recursive: true });

const runId = randomBytes(4).toString("hex");
const configurations = [
  { engine: "mysql", prefix: "MYSQL" },
  { engine: "mariadb", prefix: "MARIADB" },
];
const reports = [];

function invoke(environment, args, parseJson = false) {
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
    throw new Error(`dbstudio ${args[0]} ${args[1]} failed${details ? `:\n${details}` : "."}`);
  }
}

for (const { engine, prefix } of configurations) {
  const host = dockerEnv[`${prefix}_HOST`] || "127.0.0.1";
  const port = dockerEnv[`${prefix}_PORT`] || (engine === "mysql" ? "23306" : "23307");
  const database = dockerEnv[`${prefix}_DATABASE`] || "dbstudio_test";
  const environment = {
    ...process.env,
    DBSTUDIO_DATABASE_TYPE: engine,
    ["MYSQL_HOST"]: host,
    ["MYSQL_PORT"]: port,
    ["MYSQL_DATABASE"]: database,
    ["MYSQL_USER"]: dockerEnv[`${prefix}_USER`],
    ["MYSQL_PASSWORD"]: dockerEnv[`${prefix}_PASSWORD`],
    ["MARIADB_HOST"]: host,
    ["MARIADB_PORT"]: port,
    ["MARIADB_DATABASE"]: database,
    ["MARIADB_USER"]: dockerEnv[`${prefix}_USER`],
    ["MARIADB_PASSWORD"]: dockerEnv[`${prefix}_PASSWORD`],
    MYSQL_CONNECT_TIMEOUT: "5000",
  };
  delete environment.DBSTUDIO_DATABASE_URL;
  delete environment.DBSTUDIO_MYSQL_URL;
  delete environment.DBSTUDIO_MARIADB_URL;
  delete environment.DATABASE_URL;

  for (const key of [`${prefix}_USER`, `${prefix}_PASSWORD`]) {
    assert.ok(dockerEnv[key], `Set ${key} in docker/.env.`);
  }

  const connection = invoke(environment, ["connections", "test", "--connection", "environment"], true);
  assert.equal(connection.ok, true, `${engine}: connection test failed.`);
  assert.equal(connection.database, database, `${engine}: connected to an unexpected database.`);

  const databases = invoke(environment, ["databases", "list"], true);
  assert.ok(databases.includes(database), `${engine}: configured database was not listed.`);

  const table = `dbsi_${engine}_${runId}`;
  const csvTable = `${table}_csv`;
  const jsonTable = `${table}_json`;
  const xlsxTable = `${table}_xlsx`;
  const rollbackTable = `${table}_rollback`;
  const view = `${table}_view`;
  const quote = (identifier) => `\`${identifier.replaceAll("`", "``")}\``;
  const tableSql = quote(table);
  const csvTableSql = quote(csvTable);
  const jsonTableSql = quote(jsonTable);
  const xlsxTableSql = quote(xlsxTable);
  const rollbackTableSql = quote(rollbackTable);
  const viewSql = quote(view);
  const csvFile = path.join(artifactDirectory, `${table}.csv`);
  const jsonFile = path.join(artifactDirectory, `${table}.json`);
  const xlsxFile = path.join(artifactDirectory, `${table}.xlsx`);
  const rollbackFile = path.join(artifactDirectory, `${table}-rollback.csv`);
    const artifactPaths = [csvFile, jsonFile, xlsxFile, rollbackFile];
    assert.ok(artifactPaths.every((artifact) => !existsSync(artifact)), `${engine}: refusing to overwrite a pre-existing smoke artifact.`);
  const report = { engine, database, serverVersion: connection.serverVersion };

  try {
    invoke(environment, ["query", "run", "--sql",
      `CREATE TABLE ${tableSql} (id INTEGER NOT NULL AUTO_INCREMENT PRIMARY KEY, label VARCHAR(120) NOT NULL, note TEXT NULL)`,
      "--format", "json"], true);
    invoke(environment, ["query", "run", "--sql",
      `INSERT INTO ${tableSql} (label, note) VALUES (?, ?)`,
      "--params", JSON.stringify([`${engine}-中文`, "round-trip"]), "--format", "json"], true);
    invoke(environment, ["query", "run", "--sql",
      `INSERT INTO ${tableSql} (label, note) VALUES (?, NULL)`,
      "--params", JSON.stringify([`${engine}-空值`]), "--format", "json"], true);
    const selected = invoke(environment, ["query", "run", "--sql",
      `SELECT label, note FROM ${tableSql} WHERE label = ?`,
      "--params", JSON.stringify([`${engine}-中文`]), "--format", "json"], true);
    assert.equal(selected.rowCount, 1, `${engine}: parameterized query returned an unexpected row count.`);
    assert.deepEqual(selected.rows[0], { label: `${engine}-中文`, note: "round-trip" });

    invoke(environment, ["query", "run", "--sql",
      `CREATE VIEW ${viewSql} AS SELECT id, label FROM ${tableSql}`, "--format", "json"], true);
    const objects = invoke(environment, ["tables", "list", "--schema", database], true);
    assert.ok(objects.some((item) => item.name === table && item.type === "table"), `${engine}: table was not listed.`);
    assert.ok(objects.some((item) => item.name === view && item.type === "view"), `${engine}: view was not listed.`);

    const columns = invoke(environment, ["tables", "columns", "--table", table, "--schema", database], true);
    const idColumn = columns.find((column) => column.name === "id");
    const labelColumn = columns.find((column) => column.name === "label");
    assert.ok(idColumn?.primaryKey, `${engine}: primary key metadata was not reported.`);
    assert.ok(labelColumn && !labelColumn.nullable, `${engine}: nullability metadata was not reported.`);
    assert.ok(idColumn.ordinalPosition < labelColumn.ordinalPosition, `${engine}: field order was not reported.`);

    const exportedCsv = invoke(environment, ["data", "export", "--table", table, "--schema", database,
      "--output", csvFile, "--format", "csv"], true);
    const exportedJson = invoke(environment, ["data", "export", "--table", table, "--schema", database,
      "--output", jsonFile, "--format", "json"], true);
    const exportedXlsx = invoke(environment, ["data", "export", "--table", table, "--schema", database,
      "--output", xlsxFile, "--format", "xlsx"], true);
    assert.equal(exportedCsv.rowCount, 2, `${engine}: CSV export row count was incorrect.`);
    assert.equal(exportedJson.rowCount, 2, `${engine}: JSON export row count was incorrect.`);
    assert.equal(exportedXlsx.rowCount, 2, `${engine}: XLSX export row count was incorrect.`);
    assert.ok(readFileSync(csvFile, "utf8").includes("\\N"), `${engine}: CSV export did not preserve SQL NULL.`);
    const jsonExport = JSON.parse(readFileSync(jsonFile, "utf8"));
    assert.equal(jsonExport.rows.length, 2, `${engine}: JSON output did not contain both rows.`);

    for (const target of [csvTableSql, jsonTableSql, xlsxTableSql, rollbackTableSql]) {
      invoke(environment, ["query", "run", "--sql",
        `CREATE TABLE ${target} (id INTEGER NOT NULL PRIMARY KEY, label VARCHAR(120) NOT NULL, note TEXT NULL)`,
        "--format", "json"], true);
    }
    const importedCsv = invoke(environment, ["data", "import", "--table", csvTable, "--schema", database,
      "--input", csvFile, "--format", "csv"], true);
    const importedJson = invoke(environment, ["data", "import", "--table", jsonTable, "--schema", database,
      "--input", jsonFile, "--format", "json"], true);
    const importedXlsx = invoke(environment, ["data", "import", "--table", xlsxTable, "--schema", database,
      "--input", xlsxFile, "--format", "xlsx"], true);
    assert.equal(importedCsv.insertedRows, 2, `${engine}: CSV import row count was incorrect.`);
    assert.equal(importedJson.insertedRows, 2, `${engine}: JSON import row count was incorrect.`);
    assert.equal(importedXlsx.insertedRows, 2, `${engine}: XLSX import row count was incorrect.`);
    for (const target of [csvTableSql, jsonTableSql, xlsxTableSql]) {
      const roundTrip = invoke(environment, ["query", "run", "--sql",
        `SELECT label, note FROM ${target} ORDER BY id`, "--format", "json"], true);
      assert.deepEqual(roundTrip.rows, [
        { label: `${engine}-中文`, note: "round-trip" },
        { label: `${engine}-空值`, note: null },
      ], `${engine}: data-file round trip did not preserve values.`);
    }
    const invalidRows = ["id,label,note", ...Array.from({ length: 501 }, (_, index) => `${index + 1},row-${index + 1},`), "1,duplicate,"];
    writeFileSync(rollbackFile, `${invalidRows.join("\n")}\n`, "utf8");
    let duplicateRejected = false;
    try {
      invoke(environment, ["data", "import", "--table", rollbackTable, "--schema", database,
        "--input", rollbackFile, "--format", "csv"], true);
    } catch {
      duplicateRejected = true;
    }
    assert.equal(duplicateRejected, true, `${engine}: duplicate primary keys should reject the import.`);
    const rollbackCount = invoke(environment, ["query", "run", "--sql",
      `SELECT COUNT(*) AS count FROM ${rollbackTableSql}`, "--format", "json"], true);
    assert.equal(Number(rollbackCount.rows[0].count), 0, `${engine}: a failed multi-batch import must roll back all rows.`);
    report.tablesAndViewsListed = true;
    report.columnsInspected = columns.length;
    report.parameterizedQuery = selected.rows[0];
    report.tableDataTransfer = {
      csvExportAndImport: 2,
      jsonExportAndImport: 2,
      xlsxExportAndImport: 2,
      nullPreserved: true,
      multiBatchRollback: true,
    };
  } finally {
    try {
      invoke(environment, ["query", "run", "--sql", `DROP VIEW IF EXISTS ${viewSql}`, "--format", "json"], true);
      invoke(environment, ["query", "run", "--sql", `DROP TABLE IF EXISTS ${csvTableSql}`, "--format", "json"], true);
      invoke(environment, ["query", "run", "--sql", `DROP TABLE IF EXISTS ${jsonTableSql}`, "--format", "json"], true);
      invoke(environment, ["query", "run", "--sql", `DROP TABLE IF EXISTS ${xlsxTableSql}`, "--format", "json"], true);
      invoke(environment, ["query", "run", "--sql", `DROP TABLE IF EXISTS ${rollbackTableSql}`, "--format", "json"], true);
      invoke(environment, ["query", "run", "--sql", `DROP TABLE IF EXISTS ${tableSql}`, "--format", "json"], true);
    } catch {
      // Preserve the original failure if cleanup cannot connect to the test service.
    }
    for (const artifact of artifactPaths) {
      if (existsSync(artifact)) unlinkSync(artifact);
    }
    assert.ok(artifactPaths.every((artifact) => !existsSync(artifact)), `${engine}: smoke artifacts were not fully cleaned.`);
  }
  reports.push(report);
}

process.stdout.write(`${JSON.stringify({ results: reports }, null, 2)}\n`);
