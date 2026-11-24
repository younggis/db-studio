import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { Writable } from "node:stream";
import { CoreService } from "../../packages/core/dist/index.js";
import { isQueryStreamCell } from "../../packages/shared/dist/index.js";
import { writeQueryResultNdjsonStream } from "../../apps/cli/dist/format.js";

const dockerEnv = Object.fromEntries(readFileSync(new URL("../../docker/.env", import.meta.url), "utf8")
  .split(/\r?\n/)
  .flatMap((line) => {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match || line.trimStart().startsWith("#")) return [];
    let value = match[2].trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, "");
    return [[match[1], value]];
  }));

function required(name, fallback) {
  const value = process.env[name] || dockerEnv[name] || fallback;
  assert.ok(value, `Set ${name} in docker/.env before running this integration.`);
  return value;
}

const user = required("DBSTUDIO_ORACLE_USER", "SYSTEM").toUpperCase();
const password = required("ORACLE_PASSWORD");
const port = Number(required("ORACLE_PORT", "21521"));
const serviceName = required("DBSTUDIO_ORACLE_SERVICE", "FREEPDB1");
assert.ok(Number.isSafeInteger(port) && port > 0 && port <= 65_535, "ORACLE_PORT must be a valid TCP port.");
const oracle = CoreService.fromOracleConfig({
  user,
  password,
  connectString: `//127.0.0.1:${port}/${serviceName}`,
  connectTimeout: 15,
  callTimeout: 60_000,
});
const table = `DB_QS_LOB_${randomBytes(5).toString("hex").toUpperCase()}`;
const expectedText = `流式 CLOB "quoted" \\ path\n${"空间数据😀数据库".repeat(80_000)}`;
const expectedBytes = randomBytes(768 * 1024 + 17);
let created = false;
let primaryError;
let iterator;

try {
  await oracle.query(`CREATE TABLE "${user}"."${table}" (
    "id" NUMBER(10) NOT NULL PRIMARY KEY,
    "description" CLOB,
    "payload" BLOB
  )`);
  created = true;
  await oracle.importRows(table, {
    columns: ["id", "description", "payload"],
    rows: [{ id: 1, description: expectedText, payload: expectedBytes }],
  }, user);
  const storedLength = await oracle.query(`SELECT DBMS_LOB.GETLENGTH("description") AS text_length FROM "${user}"."${table}" WHERE "id" = 1`);
  assert.equal(Number(storedLength.rows[0]?.text_length ?? storedLength.rows[0]?.TEXT_LENGTH), expectedText.length, "Oracle stores the full synthetic CLOB fixture.");

  iterator = oracle.queryStream(
    `SELECT "id", "description", "payload" FROM "${user}"."${table}" ORDER BY "id"`,
    [],
    { batchSize: 1 },
  )[Symbol.asyncIterator]();
  const batch = await iterator.next();
  assert.equal(batch.done, false);
  assert.equal(batch.value.rows.length, 1);
  const row = batch.value.rows[0];
  assert.equal(isQueryStreamCell(row.description), true, "CLOB stays a stream before formatting.");
  assert.equal(isQueryStreamCell(row.payload), true, "BLOB stays a stream before formatting.");
  assert.equal(row.description.encoding, "utf8");
  assert.equal(row.payload.encoding, "buffer");

  const outputChunks = [];
  const output = new Writable({
    highWaterMark: 256,
    write(chunk, _encoding, callback) {
      outputChunks.push(Buffer.from(chunk));
      setTimeout(callback, 1);
    },
  });
  await writeQueryResultNdjsonStream((async function* () { yield batch.value; })(), output);
  await new Promise((resolve, reject) => output.end((error) => error ? reject(error) : resolve()));
  const serialized = Buffer.concat(outputChunks).toString("utf8").trimEnd();
  const result = JSON.parse(serialized);
  assert.equal(result.id, 1);
  const expectedTextHash = createHash("sha256").update(expectedText).digest("hex");
  const actualTextHash = createHash("sha256").update(result.description).digest("hex");
  assert.equal(result.description.length, expectedText.length, `CLOB character count mismatch: expected ${expectedText.length}, got ${result.description.length}.`);
  if (actualTextHash !== expectedTextHash) {
    let firstDifference = 0;
    while (firstDifference < expectedText.length && expectedText[firstDifference] === result.description[firstDifference]) firstDifference += 1;
    process.stderr.write(JSON.stringify({
      clobDiagnostic: true,
      firstDifference,
      expectedCodePoint: expectedText.codePointAt(firstDifference)?.toString(16) ?? null,
      actualCodePoint: result.description.codePointAt(firstDifference)?.toString(16) ?? null,
      expectedHash: expectedTextHash,
      actualHash: actualTextHash,
    }) + "\n");
  }
  assert.equal(actualTextHash, expectedTextHash, "CLOB content and JSON escaping survive streaming.");
  assert.deepEqual(result.payload, { type: "Buffer", data: [...expectedBytes] }, "BLOB keeps the established Buffer JSON representation.");

  const rest = await iterator.next();
  assert.equal(rest.done, true);
  process.stdout.write(JSON.stringify({
    status: "passed",
    engine: "Oracle",
    clobCharacters: expectedText.length,
    blobBytes: expectedBytes.length,
    slowOutputBackpressure: true,
    returnedAsStreamsBeforeFormatting: true,
    clobContentVerified: true,
    blobHashVerified: createHash("sha256").update(Buffer.from(result.payload.data)).digest("hex") === createHash("sha256").update(expectedBytes).digest("hex"),
    jsonLineParsed: true,
  }) + "\n");
} catch (error) {
  primaryError = error;
  process.stderr.write(JSON.stringify({ status: "failed", name: error?.name ?? "Error", message: String(error?.message ?? error).slice(0, 500) }) + "\n");
  process.exitCode = 1;
} finally {
  if (iterator?.return) await iterator.return().catch(() => undefined);
  if (created) {
    try {
      await oracle.query(`DROP TABLE "${user}"."${table}" PURGE`);
      const check = await oracle.query("SELECT COUNT(*) AS count FROM user_tables WHERE table_name = :1", [table]);
      if (!primaryError) assert.equal(Number(check.rows[0]?.count ?? check.rows[0]?.COUNT), 0, "LOB query stream fixture should be removed.");
    } catch (error) {
      if (!primaryError) {
        process.stderr.write(JSON.stringify({ cleanup: "failed", message: String(error?.message ?? error).slice(0, 250) }) + "\n");
        process.exitCode = 1;
      }
    }
  }
}
