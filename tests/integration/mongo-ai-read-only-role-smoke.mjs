import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { MongoDocumentService } from "../../packages/core/dist/index.js";

const databaseRequire = createRequire(new URL("../../packages/database/package.json", import.meta.url));
const { MongoClient } = databaseRequire("mongodb");

function readDockerEnv() {
  const text = readFileSync(new URL("../../docker/.env", import.meta.url), "utf8");
  return Object.fromEntries(text.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match || line.trimStart().startsWith("#")) return [];
    let value = match[2].trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "");
    }
    return [[match[1], value]];
  }));
}

const dockerEnv = readDockerEnv();
const host = process.env.MONGODB_HOST || dockerEnv.MONGODB_HOST || "127.0.0.1";
const port = Number(process.env.MONGODB_PORT || dockerEnv.MONGODB_PORT || "27018");
const database = process.env.MONGODB_DATABASE || dockerEnv.MONGODB_DATABASE || "dbstudio_test";
const adminUser = process.env.MONGODB_ROOT_USER || dockerEnv.MONGODB_ROOT_USER;
const adminPassword = process.env.MONGODB_ROOT_PASSWORD || dockerEnv.MONGODB_ROOT_PASSWORD;
assert.equal(host, "127.0.0.1", "MongoDB must use the authorized local test service.");
assert.equal(port, 27018, "MongoDB must use its project test port.");
assert.equal(database, "dbstudio_test", "MongoDB must use the project test database.");
assert.ok(adminUser && adminPassword, "Set the MongoDB root account in docker/.env.");

const suffix = randomBytes(8).toString("hex");
const role = `dbs_ai_ro_role_${suffix}`;
const user = `dbs_ai_ro_${suffix}`;
const allowedCollection = `ai_ro_allow_${suffix}`;
const deniedCollection = `ai_ro_private_${suffix}`;
const password = randomBytes(24).toString("base64url");
const adminUri = `mongodb://${encodeURIComponent(adminUser)}:${encodeURIComponent(adminPassword)}@${host}:${port}/?authSource=admin`;
const adminClient = new MongoClient(adminUri, { serverSelectionTimeoutMS: 8_000 });
const adminDb = adminClient.db(database);
let roleCreated = false;
let userCreated = false;
let allowedCreated = false;
let deniedCreated = false;
let stage = "preflight";
let failure;
let cleanupFailure;

function sanitizedFailure(errorStage, error) {
  return {
    stage: errorStage,
    errorName: error instanceof Error ? error.name : "UnknownError",
    databaseErrorCode: error?.code,
  };
}

async function expectUnauthorized(label, action) {
  try {
    await action();
  } catch (error) {
    assert.equal(error?.code, 13, `${label} must fail with MongoDB Unauthorized (code 13).`);
    return;
  }
  assert.fail(`${label} unexpectedly succeeded for the limited MongoDB role.`);
}

try {
  await adminClient.connect();
  await adminDb.command({ ping: 1 });

  stage = "create-collections";
  await adminDb.createCollection(allowedCollection);
  allowedCreated = true;
  await adminDb.createCollection(deniedCollection);
  deniedCreated = true;
  await adminDb.collection(allowedCollection).insertOne({ _id: "allowed-sentinel", marker: "allowed-sentinel" });
  await adminDb.collection(deniedCollection).insertOne({ _id: "private-sentinel", marker: "private-sentinel" });

  stage = "create-role";
  await adminDb.command({
    createRole: role,
    privileges: [{ resource: { db: database, collection: allowedCollection }, actions: ["find"] }],
    roles: [],
  });
  roleCreated = true;
  stage = "create-user";
  await adminDb.command({ createUser: user, pwd: password, roles: [{ role, db: database }] });
  userCreated = true;

  const readerUri = `mongodb://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${database}?authSource=${database}`;
  const reader = MongoDocumentService.fromConfig({ uri: readerUri, database, connectTimeoutMS: 8_000 });
  stage = "allowed-read";
  const visible = await reader.findDocuments(database, allowedCollection, { projection: { _id: 1, marker: 1 } });
  assert.deepEqual(visible, [{ _id: "allowed-sentinel", marker: "allowed-sentinel" }]);

  stage = "denied-read";
  await expectUnauthorized("Reading an ungranted collection", () => reader.findDocuments(database, deniedCollection));
  stage = "denied-insert";
  await expectUnauthorized("CoreService document import", () => reader.importDocuments(database, allowedCollection, [
    { _id: "must-not-insert", marker: "must-not-write" },
  ]));

  const restrictedClient = new MongoClient(readerUri, { serverSelectionTimeoutMS: 8_000 });
  try {
    await restrictedClient.connect();
    const restrictedCollection = restrictedClient.db(database).collection(allowedCollection);
    stage = "denied-update";
    await expectUnauthorized("UPDATE", () => restrictedCollection.updateOne(
      { _id: "allowed-sentinel" },
      { $set: { marker: "must-not-write" } },
    ));
    stage = "denied-delete";
    await expectUnauthorized("DELETE", () => restrictedCollection.deleteOne({ _id: "allowed-sentinel" }));
    stage = "denied-create-collection";
    await expectUnauthorized("CREATE COLLECTION", () => restrictedClient.db(database).createCollection(`must_not_create_${suffix}`));
  } finally {
    await restrictedClient.close();
  }

  stage = "unchanged-state";
  const visibleState = await adminDb.collection(allowedCollection).findOne({ _id: "allowed-sentinel" });
  const privateState = await adminDb.collection(deniedCollection).findOne({ _id: "private-sentinel" });
  assert.equal(visibleState?.marker, "allowed-sentinel");
  assert.equal(privateState?.marker, "private-sentinel");
} catch (error) {
  failure = sanitizedFailure(stage, error);
} finally {
  if (userCreated) {
    try { await adminDb.command({ dropUser: user }); }
    catch (error) { cleanupFailure ??= sanitizedFailure("drop-user", error); }
  }
  if (roleCreated) {
    try { await adminDb.command({ dropRole: role }); }
    catch (error) { cleanupFailure ??= sanitizedFailure("drop-role", error); }
  }
  if (allowedCreated) {
    try {
      const collection = adminDb.collection(allowedCollection);
      await collection.deleteMany({});
      await collection.insertOne({ _id: "allowed-sentinel", marker: "allowed-sentinel" });
      await collection.drop();
    } catch (error) { cleanupFailure ??= sanitizedFailure("drop-allowed-collection", error); }
  }
  if (deniedCreated) {
    try {
      const collection = adminDb.collection(deniedCollection);
      await collection.deleteMany({});
      await collection.insertOne({ _id: "private-sentinel", marker: "private-sentinel" });
      await collection.drop();
    } catch (error) { cleanupFailure ??= sanitizedFailure("drop-denied-collection", error); }
  }
  try {
    const remainingUsers = await adminDb.command({ usersInfo: user });
    if (remainingUsers.users?.length !== 0) cleanupFailure ??= { stage: "verify-user-removed" };
    const remainingRoles = await adminDb.command({ rolesInfo: role });
    if (remainingRoles.roles?.length !== 0) cleanupFailure ??= { stage: "verify-role-removed" };
    const remainingCollections = await adminDb.listCollections({ name: { $in: [allowedCollection, deniedCollection] } }).toArray();
    if (remainingCollections.length !== 0) cleanupFailure ??= { stage: "verify-collections-removed" };
  } catch (error) {
    cleanupFailure ??= sanitizedFailure("cleanup-verify", error);
  }
  await adminClient.close().catch((error) => { cleanupFailure ??= sanitizedFailure("close-admin", error); });
}

if (failure || cleanupFailure) {
  process.stdout.write(`${JSON.stringify({ ok: false, scenario: "mongo-ai-least-privilege-boundary", failure, cleanupFailure, secretsLogged: false })}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`${JSON.stringify({
    ok: true,
    scenario: "mongo-ai-least-privilege-boundary",
    database: "project-isolated dbstudio_test",
    allowed: ["find on one synthetic collection"],
    denied: ["find on an ungranted collection", "document import", "UPDATE", "DELETE", "CREATE COLLECTION"],
    fixturesUnchanged: true,
    fixturesRemoved: true,
    temporaryRoleAndUserRemoved: true,
    passwordLogged: false,
  })}\n`);
}
