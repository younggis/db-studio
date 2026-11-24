import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const dateParts = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).formatToParts(new Date());
const dateFields = Object.fromEntries(dateParts.map(({ type, value }) => [type, value]));
const date = `${dateFields.year}-${dateFields.month}-${dateFields.day}`;
const runId = randomBytes(6).toString("hex");
const cacheDir = path.resolve(".cache");
const runDir = path.join(cacheDir, `ai-cli-sql-assistant-${runId}`);
const databasePath = path.join(runDir, "synthetic.sqlite");
const repairSqlPath = path.join(runDir, "repair.sql");
const repairErrorPath = path.join(runDir, "repair-error.txt");
const explainSqlPath = path.join(runDir, "explain.sql");
const cliPath = path.resolve("apps/cli/dist/index.js");
const evidencePath = path.join(cacheDir, `ai-cli-sql-assistant-${date}-${runId}.json`);
const results = [];
let stage = "setup";
let failureClass;
let syntheticSqlProbeExecuted = false;
let verificationQueriesExecuted = false;

function assertOutput(command, expectedKind, expectedTokens = []) {
  const childEnv = { ...process.env };
  childEnv.DBSTUDIO_DATABASE_TYPE = "sqlite";
  childEnv.DBSTUDIO_SQLITE_PATH = databasePath;
  for (const key of [
    "MODEL_OPENAI_BASE_URL",
    "MODEL_OPENAI_API_KEY",
    "MODEL_OPENAI_MODEL",
    "DBSTUDIO_AI_BASE_URL",
    "DBSTUDIO_AI_API_KEY",
    "DBSTUDIO_AI_MODEL",
  ]) {
    delete childEnv[key];
  }

  const child = spawnSync(process.execPath, [cliPath, ...command.args], {
    cwd: process.cwd(),
    env: childEnv,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    timeout: 300_000,
    windowsHide: true,
  });
  assert.equal(child.error, undefined, `${command.name} CLI process could not start`);
  assert.equal(child.status, 0, `${command.name} CLI command failed`);

  let response;
  try {
    response = JSON.parse(child.stdout.trim());
  } catch {
    throw new Error(`${command.name} CLI output was not valid JSON`);
  }

  assert.notEqual(response.validation?.valid, false, `${command.name} SQL validation failed`);
  const result = response.result ?? {};
  let content;
  if (expectedKind === "sql") {
    assert.equal(response.validation?.valid, true, `${command.name} did not return a successful validation result`);
    content = result.sql;
    assert.equal(typeof content, "string", `${command.name} did not return a SQL draft`);
    assert.match(content, /customers/i, `${command.name} SQL draft does not use the selected table`);
    for (const token of expectedTokens) {
      assert.match(content, new RegExp(token, "i"), `${command.name} SQL draft is missing an expected field or operation`);
    }
    if (command.name === "repair") {
      assert.doesNotMatch(content, /unknown_column/i, "repair SQL still references the invalid column");
    }
  } else if (expectedKind === "explanation") {
    content = result.explanation;
    assert.equal(typeof content, "string", `${command.name} did not return an explanation`);
    assert.ok(content.trim().length > 20, `${command.name} explanation is unexpectedly short`);
  }

  if (expectedKind === "clarification") {
    assert.equal(result.task, "generate", "The ambiguous relationship request should remain a generation task.");
    assert.equal(result.sql, "", "The assistant should not guess a join relation when the user forbids assumptions.");
    assert.equal(response.validation, undefined, "No SQL should be sent to SQL validation when clarification is required.");
    const clarificationText = [
      result.explanation,
      ...(result.assumptions ?? []),
      ...(result.warnings ?? []),
    ].join(" ");
    assert.match(clarificationText, /purchaser_customer_id|recipient_customer_id|relationship|relation|foreign.?key|ambiguous|clarif|which column/i);
    content = clarificationText;
  }

  return {
    command: command.name,
    exitCode: child.status,
    validationStatus: response.validation === undefined
      ? "not-applicable"
      : response.validation.valid === true ? "passed" : "failed",
    outputKind: expectedKind,
    outputLength: content.length,
    ...(expectedKind === "clarification" ? { clarificationVerified: true, sqlReturned: false } : {}),
  };
}

function writeEvidence(status, temporaryFilesCleaned) {
  const evidence = {
    date,
    status,
    integration: "standalone CLI with the encrypted desktop Chat model profile",
    database: "temporary SQLite file containing schema only; zero business/test rows",
    commands: results,
    schemaSent: "synthetic main.customers and main.orders metadata only",
    generatedSqlExecuted: false,
    syntheticSqlProbeExecuted,
    verificationQueriesExecuted,
    sourceRowsRead: 0,
    databaseCredentialsOrConnectionUriSent: false,
    providerApiKeySentAsAuthorization: true,
    providerApiKeyValueRecorded: false,
    fullModelResponsesRecorded: false,
    temporaryFilesCleaned,
    ...(failureClass ? { failureClass, failureStage: stage } : {}),
  };
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  return evidence;
}

mkdirSync(cacheDir, { recursive: true });
mkdirSync(runDir, { recursive: false });

try {
  assert.ok(existsSync(cliPath), "Build the CLI before running this integration");
  stage = "create-synthetic-schema";
  const database = new DatabaseSync(databasePath);
  database.exec(`CREATE TABLE customers (
    customer_id INTEGER PRIMARY KEY,
    city TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);
  database.exec("CREATE TABLE orders (order_id INTEGER PRIMARY KEY, purchaser_customer_id INTEGER NOT NULL, recipient_customer_id INTEGER NOT NULL, amount_cents INTEGER NOT NULL)");
  stage = "capture-real-synthetic-sqlite-error";
  const invalidSql = "SELECT city, unknown_column FROM customers;";
  let capturedError;
  try {
    database.prepare(invalidSql).get();
  } catch (error) {
    capturedError = error;
  }
  assert.ok(capturedError instanceof Error, "The synthetic invalid SQL should produce a SQLite error");
  assert.match(capturedError.message, /unknown_column/);
  syntheticSqlProbeExecuted = true;
  database.close();
  writeFileSync(repairSqlPath, invalidSql + "\n", "utf8");
  writeFileSync(repairErrorPath, "SQLite error: " + capturedError.message + "\n", "utf8");
  writeFileSync(explainSqlPath, "SELECT city, COUNT(*) AS customer_count FROM customers GROUP BY city ORDER BY customer_count DESC LIMIT 10;\n", "utf8");

  stage = "generate";
  results.push(assertOutput({
    name: "generate",
    args: [
      "ai", "sql", "generate",
      "--connection", "environment",
      "--request", "Count customers in each city and order the largest groups first.",
      "--schema", "main",
      "--table", "main.customers",
      "--include-schema",
      "--format", "json",
    ],
  }, "sql", ["city", "count"]));

  stage = "repair";
  results.push(assertOutput({
    name: "repair",
    args: [
      "ai", "sql", "repair",
      "--connection", "environment",
      "--file", repairSqlPath,
      "--error-file", repairErrorPath,
      "--request", "Remove only the invalid unknown_column expression and keep the valid city column.",
      "--schema", "main",
      "--table", "main.customers",
      "--include-schema",
      "--format", "json",
    ],
  }, "sql", ["city"]));

  stage = "explain";
  results.push(assertOutput({
    name: "explain",
    args: [
      "ai", "sql", "explain",
      "--connection", "environment",
      "--file", explainSqlPath,
      "--request", "Explain the grouping and ordering briefly.",
      "--schema", "main",
      "--table", "main.customers",
      "--include-schema",
      "--format", "json",
    ],
  }, "explanation"));

  stage = "ambiguous-relationship";
  results.push(assertOutput({
    name: "ambiguous-relationship",
    args: [
      "ai", "sql", "generate",
      "--connection", "environment",
      "--request",
      "Count each customer's orders and include their city. Do not assume that purchaser_customer_id or recipient_customer_id identifies the customer's own orders; no foreign keys are declared. If the relationship cannot be determined, return no SQL and ask me which column to use.",
      "--schema", "main",
      "--table", "main.customers",
      "--table", "main.orders",
      "--include-schema",
      "--format", "json",
    ],
  }, "clarification"));

  stage = "verify-no-generated-sql-was-executed";
  const verification = new DatabaseSync(databasePath, { readOnly: true });
  const tableCount = verification.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table'").get().count;
  const rowCount = verification.prepare("SELECT COUNT(*) AS count FROM customers").get().count;
  const orderCount = verification.prepare("SELECT COUNT(*) AS count FROM orders").get().count;
  verification.close();
  verificationQueriesExecuted = true;
  assert.equal(tableCount, 2, "AI commands changed the synthetic database schema");
  assert.equal(rowCount, 0, "AI commands executed or inserted data into the synthetic table");
  assert.equal(orderCount, 0, "AI commands executed or inserted data into the synthetic orders table");
} catch (error) {
  failureClass = error instanceof Error ? error.name : "UnknownError";
  process.exitCode = 1;
} finally {
  const normalizedCache = path.resolve(cacheDir);
  const normalizedRun = path.resolve(runDir);
  if (path.dirname(normalizedRun) !== normalizedCache || !path.basename(normalizedRun).startsWith("ai-cli-sql-assistant-")) {
    throw new Error("Refusing to clean a path outside this run's cache directory");
  }
  rmSync(normalizedRun, { recursive: true, force: true });
  const evidence = writeEvidence(process.exitCode === 1 ? "failed" : "passed", !existsSync(normalizedRun));
  process.stdout.write(`${JSON.stringify({ ok: evidence.status === "passed", evidencePath, ...evidence }, null, 2)}\n`);
}
