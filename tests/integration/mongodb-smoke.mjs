import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cli = path.join(root, "apps", "cli", "dist", "index.js");
const envFile = path.join(root, "docker", ".env");
const databaseRequire = createRequire(path.join(root, "packages", "database", "package.json"));
const { MongoClient } = databaseRequire("mongodb");

function parseEnvFile(file) {
  if (!existsSync(file)) return {};
  return Object.fromEntries(readFileSync(file, "utf8").split(/\r?\n/)
    .map((line) => line.match(/^\s*([^#=]+)=(.*)$/))
    .filter(Boolean)
    .map((match) => [match[1].trim(), match[2].trim().replace(/^(['"])(.*)\1$/, "$2")]));
}

const dockerEnv = parseEnvFile(envFile);
assert.ok(existsSync(cli), "Build the CLI first with `pnpm run build`.");
assert.ok(dockerEnv.MONGODB_ROOT_USER && dockerEnv.MONGODB_ROOT_PASSWORD, "Set MongoDB test credentials in docker/.env.");

const host = "127.0.0.1";
const port = dockerEnv.MONGODB_PORT || "27018";
const database = dockerEnv.MONGODB_DATABASE || "dbstudio_test";
const uri = `mongodb://${encodeURIComponent(dockerEnv.MONGODB_ROOT_USER)}:${encodeURIComponent(dockerEnv.MONGODB_ROOT_PASSWORD)}@${host}:${port}/?authSource=admin`;
const environment = { ...process.env, DBSTUDIO_DATABASE_TYPE: "mongodb", MONGODB_URI: uri, DBSTUDIO_MONGODB_DATABASE: database };
for (const key of ["DBSTUDIO_DATABASE_URL", "DBSTUDIO_MYSQL_URL", "DBSTUDIO_MARIADB_URL", "DATABASE_URL"]) delete environment[key];

const artifactDirectory = path.join(root, ".cache", "mongodb-smoke");
mkdirSync(artifactDirectory, { recursive: true });
const runId = randomBytes(5).toString("hex");
const collection = `dbstudio_${runId}`;
const copyCollection = `${collection}_copy`;
const geoCollection = `${collection}_geo`;
const pointCollection = `${collection}_point`;
const geometryField = "location.geometry";
const inputFile = path.join(artifactDirectory, `${collection}.json`);
const exportFile = path.join(artifactDirectory, `${collection}-export.json`);
const geoInputFile = path.join(artifactDirectory, `${geoCollection}.geojson`);
const geoOutputFile = path.join(artifactDirectory, `${geoCollection}-export.geojson`);
const pointInputFile = path.join(artifactDirectory, `${pointCollection}.geojson`);
const pointOutputFile = path.join(artifactDirectory, `${pointCollection}-export.geojson`);
const collectionNames = [collection, copyCollection, geoCollection, pointCollection];
const artifactPaths = [inputFile, exportFile, geoInputFile, geoOutputFile, pointInputFile, pointOutputFile];
assert.ok(artifactPaths.every((artifact) => !existsSync(artifact)), "Refusing to overwrite a pre-existing MongoDB smoke artifact.");

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

const id1 = "65a000000000000000000001";
const id2 = "65a000000000000000000002";
const id3 = "65a000000000000000000003";
const documents = [
  { _id: { $oid: id1 }, rank: 1, name: "道路一号", note: "第一行\n第二行", location: { type: "Point", coordinates: [121.5, 31.2] } },
  { _id: { $oid: id2 }, rank: 2, name: "道路二号", note: null, location: { type: "Point", coordinates: [121.6, 31.3] } },
  { _id: { $oid: id3 }, rank: 3, name: "道路三号", note: "ready", location: { type: "Point", coordinates: [121.7, 31.4] } },
];
let report;
let collectionsMayExist = false;
let cleanedFileCount = 0;
try {
  writeFileSync(inputFile, `${JSON.stringify(documents, null, 2)}\n`, "utf8");

  const connection = invoke(["connections", "test", "--connection", "environment"], true);
  assert.equal(connection.ok, true, "MongoDB connection test failed.");
  assert.equal(connection.database, database, "Connected to an unexpected default database.");

  collectionsMayExist = true;
  const imported = invoke(["mongo", "import", "--collection", collection, "--file", inputFile], true);
  assert.equal(imported.insertedCount, 3, "MongoDB import count was incorrect.");

  const databases = invoke(["databases", "list"], true);
  assert.ok(databases.includes(database), "Configured database was not listed.");

  const collections = invoke(["mongo", "collections", "--database", database], true);
  assert.ok(collections.includes(collection), "Imported collection was not listed.");

  const found = invoke(["mongo", "find", "--collection", collection,
    "--filter", '{"rank":{"$gte":1}}', "--projection", '{"rank":1,"name":1,"_id":0}',
    "--sort", '{"rank":1}', "--skip", "1", "--limit", "1", "--format", "json"], true);
  assert.equal(found.length, 1, "Find paging returned an unexpected number of documents.");
  assert.deepEqual(found[0], { rank: 2, name: "道路二号" }, "Find filter/projection/sort/skip/limit was incorrect.");

  const aggregated = invoke(["mongo", "aggregate", "--collection", collection,
    "--pipeline", '[{"$match":{"rank":{"$gte":2}}},{"$group":{"_id":null,"count":{"$sum":1}}}]'], true);
  assert.deepEqual(aggregated, [{ _id: null, count: 2 }], "Aggregation result was incorrect.");

  const exported = invoke(["mongo", "export", "--collection", collection, "--output", exportFile, "--format", "json"], true);
  assert.equal(exported.documentCount, 3, "MongoDB export count was incorrect.");
  invoke(["mongo", "import", "--collection", copyCollection, "--file", exportFile], true);
  const roundTrip = invoke(["mongo", "find", "--collection", copyCollection,
    "--filter", `{"_id":{"$oid":"${id2}"}}`, "--format", "json"], true);
  assert.equal(roundTrip.length, 1, "EJSON ObjectId filter did not match the imported document.");
  assert.equal(roundTrip[0]._id.$oid.toLowerCase(), id2, "Extended JSON round trip did not preserve ObjectId.");
  assert.deepEqual(roundTrip[0].location, { type: "Point", coordinates: [121.6, 31.3] }, "GeoJSON geometry was not preserved.");

  const geoFeatures = {
    type: "FeatureCollection",
    features: [
      { type: "Feature", id: "feature-1", geometry: { type: "Point", coordinates: [121.5, 31.2] }, properties: { name: "inside one" } },
      { type: "Feature", id: "feature-2", geometry: { type: "Point", coordinates: [121.6, 31.3] }, properties: { name: "inside two" } },
      { type: "Feature", id: "feature-3", geometry: { type: "Point", coordinates: [121.8, 31.5] }, properties: { name: "outside" } },
    ],
  };
  writeFileSync(geoInputFile, `${JSON.stringify(geoFeatures, null, 2)}\n`, "utf8");
  const geoImported = invoke(["mongo", "geo-import", "--collection", geoCollection, "--file", geoInputFile, "--field", geometryField], true);
  assert.equal(geoImported.insertedCount, 3, "GeoJSON FeatureCollection import count was incorrect.");
  const createdSpatialIndex = invoke(["mongo", "create-2dsphere-index", "--collection", geoCollection, "--field", geometryField], true);
  assert.equal(createdSpatialIndex.type, "2dsphere", "Spatial index creation did not report a 2dsphere index.");
  const indexes = invoke(["mongo", "indexes", "--collection", geoCollection], true);
  assert.ok(indexes.some((index) => index.twoDSphere && index.key[geometryField] === "2dsphere"), "2dsphere index metadata was not listed.");
  const spatialResults = invoke(["mongo", "geo-find", "--collection", geoCollection, "--field", geometryField, "--relation", "within", "--geometry", JSON.stringify({
    type: "Polygon",
    coordinates: [[[121.49, 31.19], [121.65, 31.19], [121.65, 31.35], [121.49, 31.35], [121.49, 31.19]]],
  })], true);
  assert.equal(spatialResults.length, 2, "GeoJSON $geoWithin query returned an unexpected result count.");
  const geoExport = invoke(["mongo", "geo-export", "--collection", geoCollection, "--field", geometryField, "--output", geoOutputFile], true);
  assert.equal(geoExport.featureCount, 3, "GeoJSON FeatureCollection export count was incorrect.");
  const geoRoundTrip = JSON.parse(readFileSync(geoOutputFile, "utf8"));
  assert.equal(geoRoundTrip.type, "FeatureCollection", "GeoJSON export did not create a FeatureCollection.");
  assert.equal(geoRoundTrip.features[1].id, "feature-2", "GeoJSON Feature id was not preserved.");
  assert.deepEqual(geoRoundTrip.features[1].geometry, geoFeatures.features[1].geometry, "GeoJSON Geometry changed during MongoDB round trip.");
  assert.deepEqual(geoRoundTrip.features[1].properties, geoFeatures.features[1].properties, "GeoJSON Feature properties changed during MongoDB round trip.");

  const standaloneGeometry = { type: "Point", coordinates: [121.5, 31.2] };
  writeFileSync(pointInputFile, `${JSON.stringify(standaloneGeometry)}\n`, "utf8");
  const geometryImported = invoke(["mongo", "geo-import", "--collection", pointCollection, "--file", pointInputFile, "--field", geometryField], true);
  assert.equal(geometryImported.insertedCount, 1, "Standalone GeoJSON Geometry import count was incorrect.");
  invoke(["mongo", "create-2dsphere-index", "--collection", pointCollection, "--field", geometryField], true);
  const geometryMatched = invoke(["mongo", "geo-find", "--collection", pointCollection, "--field", geometryField, "--relation", "within", "--geometry", JSON.stringify({
    type: "Polygon",
    coordinates: [[[121.49, 31.19], [121.65, 31.19], [121.65, 31.35], [121.49, 31.35], [121.49, 31.19]]],
  })], true);
  assert.equal(geometryMatched.length, 1, "Standalone Geometry in a nested path was not spatially queryable.");
  invoke(["mongo", "geo-export", "--collection", pointCollection, "--field", geometryField, "--output", pointOutputFile], true);
  const pointRoundTrip = JSON.parse(readFileSync(pointOutputFile, "utf8"));
  assert.deepEqual(pointRoundTrip.features[0].geometry, standaloneGeometry, "Standalone GeoJSON Geometry changed during MongoDB round trip.");

  let invalidFilterRejected = false;
  try {
    invoke(["mongo", "find", "--collection", collection, "--filter", "{"], true);
  } catch {
    invalidFilterRejected = true;
  }
  assert.equal(invalidFilterRejected, true, "Malformed filters should fail with a nonzero exit code.");

  report = {
    results: [{
      engine: "mongodb",
      database,
      serverVersion: connection.serverVersion,
      databasesListed: true,
      collectionsListed: true,
      findFilterProjectionSortAndPaging: true,
      aggregateCount: aggregated[0].count,
      jsonEjsonRoundTrip: { documents: 3, objectIdPreserved: true, geoJsonPreserved: true },
      geoJsonFeatureRoundTrip: { imported: 3, exported: geoExport.featureCount, spatialQueryMatches: spatialResults.length, twoDSphereIndexListed: true },
      standaloneGeometryRoundTrip: { imported: geometryImported.insertedCount, spatialQueryMatches: geometryMatched.length, exported: pointRoundTrip.features.length },
      invalidFilterRejected: true,
      testCollections: [collection, copyCollection, geoCollection, pointCollection],
    }],
  };
} finally {
  try {
    if (collectionsMayExist) {
      const client = new MongoClient(uri, { connectTimeoutMS: 5000, serverSelectionTimeoutMS: 5000 });
      try {
        await client.connect();
        const testDatabase = client.db(database);
        for (const name of collectionNames) {
          try {
            await testDatabase.collection(name).drop();
          } catch (error) {
            if (error?.code !== 26 && error?.codeName !== "NamespaceNotFound") throw error;
          }
        }
        for (const name of collectionNames) {
          const exists = await testDatabase.listCollections({ name }, { nameOnly: true }).hasNext();
          assert.equal(exists, false, `MongoDB smoke collection ${name} was not removed.`);
        }
      } finally {
        await client.close();
      }
    }
  } finally {
    for (const artifact of artifactPaths) {
      if (existsSync(artifact)) {
        unlinkSync(artifact);
        cleanedFileCount += 1;
      }
    }
  }
}

assert.ok(artifactPaths.every((artifact) => !existsSync(artifact)), "MongoDB smoke artifacts were not fully cleaned.");
report.results[0].cleanupVerified = true;
report.results[0].cleanedCollectionCount = collectionNames.length;
report.results[0].cleanedFileCount = cleanedFileCount;
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
