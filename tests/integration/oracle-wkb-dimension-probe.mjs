import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OracleAdapter, normalizeWkbForOracleSdo, oracleConfigFromEnvironment } from "../../packages/database/dist/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const evidenceDirectory = path.join(root, ".cache", "gis-roundtrip");
mkdirSync(evidenceDirectory, { recursive: true });

function parseEnvFile(file) {
  if (!existsSync(file)) return {};
  return Object.fromEntries(readFileSync(file, "utf8").split(/\r?\n/)
    .map((line) => line.match(/^\s*([^#=]+)=(.*)$/))
    .filter(Boolean)
    .map((match) => [match[1].trim(), match[2].trim().replace(/^("|')(.*)\1$/, "$2")]));
}

function pointWkb(typeCode, ordinates) {
  const buffer = Buffer.alloc(5 + ordinates.length * 8);
  buffer.writeUInt8(1, 0);
  buffer.writeUInt32LE(typeCode, 1);
  ordinates.forEach((value, index) => buffer.writeDoubleLE(value, 5 + index * 8));
  return buffer;
}

function lineStringWkb(typeCode, points) {
  const stride = points[0]?.length;
  if (!Number.isSafeInteger(stride) || stride < 2 || points.some((point) => point.length !== stride)) {
    throw new Error("LineString coordinates must use one consistent dimension.");
  }
  const buffer = Buffer.alloc(9 + points.length * stride * 8);
  buffer.writeUInt8(1, 0);
  buffer.writeUInt32LE(typeCode, 1);
  buffer.writeUInt32LE(points.length, 5);
  points.flat().forEach((value, index) => buffer.writeDoubleLE(value, 9 + index * 8));
  return buffer;
}

function polygonWkb(typeCode, rings) {
  const stride = rings[0]?.[0]?.length;
  if (!Number.isSafeInteger(stride) || stride < 2 || rings.some((ring) => ring.some((point) => point.length !== stride))) {
    throw new Error("Polygon coordinates must use one consistent dimension.");
  }
  const pointCount = rings.reduce((total, ring) => total + ring.length, 0);
  const buffer = Buffer.alloc(9 + rings.length * 4 + pointCount * stride * 8);
  buffer.writeUInt8(1, 0);
  buffer.writeUInt32LE(typeCode, 1);
  buffer.writeUInt32LE(rings.length, 5);
  let offset = 9;
  for (const ring of rings) {
    buffer.writeUInt32LE(ring.length, offset);
    offset += 4;
    for (const point of ring) {
      for (const value of point) {
        buffer.writeDoubleLE(value, offset);
        offset += 8;
      }
    }
  }
  return buffer;
}

const environment = {
  ...parseEnvFile(path.join(root, "docker", ".env")),
  ...process.env,
  ORACLE_USER: process.env.DBSTUDIO_TRANSFER_ORACLE_USER || process.env.ORACLE_USER || "SYSTEM",
  ORACLE_PASSWORD: process.env.DBSTUDIO_TRANSFER_ORACLE_PASSWORD
    || process.env.ORACLE_PASSWORD
    || parseEnvFile(path.join(root, "docker", ".env")).ORACLE_PASSWORD,
  ORACLE_CONNECT_STRING: process.env.DBSTUDIO_TRANSFER_ORACLE_CONNECT_STRING
    || process.env.ORACLE_CONNECT_STRING
    || `//${process.env.DBSTUDIO_TRANSFER_ORACLE_HOST || "127.0.0.1"}:${process.env.DBSTUDIO_TRANSFER_ORACLE_PORT || "21521"}/${process.env.DBSTUDIO_TRANSFER_ORACLE_SERVICE || "FREEPDB1"}`,
};
assert.ok(environment.ORACLE_PASSWORD, "Oracle test password must be configured in docker/.env or the test environment.");

const cases = [
  { name: "xy", encoding: "OGC WKB", typeCode: 1, ordinates: [104, 30], expectedGtype: 2001 },
  { name: "xyz-iso-wkb", encoding: "ISO WKB", typeCode: 1001, ordinates: [104, 30, 5], expectedGtype: 3001 },
  { name: "xym-iso-wkb", encoding: "ISO WKB", typeCode: 2001, ordinates: [104, 30, 7], expectedGtype: 3301 },
  { name: "xyzm-iso-wkb", encoding: "ISO WKB", typeCode: 3001, ordinates: [104, 30, 5, 7], expectedGtype: 4401 },
  { name: "xyz-iso-normalized", encoding: "ISO WKB normalized to EWKB", typeCode: 1001, ordinates: [104, 30, 5], expectedGtype: 3001, normalizeForOracle: true },
  { name: "xym-iso-normalized", encoding: "ISO WKB normalized to EWKB", typeCode: 2001, ordinates: [104, 30, 7], expectedGtype: 3301, normalizeForOracle: true },
  { name: "xyzm-iso-normalized", encoding: "ISO WKB normalized to EWKB", typeCode: 3001, ordinates: [104, 30, 5, 7], expectedGtype: 4401, normalizeForOracle: true },
  { name: "xyz-ewkb", encoding: "EWKB Z flag", typeCode: 0x80000001, ordinates: [104, 30, 5], expectedGtype: 3001 },
  { name: "xym-ewkb", encoding: "EWKB M flag", typeCode: 0x40000001, ordinates: [104, 30, 7], expectedGtype: 3301 },
  { name: "xyzm-ewkb", encoding: "EWKB ZM flags", typeCode: 0xc0000001, ordinates: [104, 30, 5, 7], expectedGtype: 4401 },
  {
    name: "xyz-ewkb-linestring",
    encoding: "EWKB Z flag",
    typeCode: 0x80000002,
    createWkb: () => lineStringWkb(0x80000002, [[104, 30, 5], [105, 31, 6]]),
    expectedGtype: 3002,
  },
  {
    name: "xyz-iso-normalized-linestring",
    encoding: "ISO WKB XYZ normalized to EWKB",
    typeCode: 1002,
    createWkb: () => lineStringWkb(1002, [[104, 30, 5], [105, 31, 6]]),
    expectedGtype: 3002,
    normalizeForOracle: true,
  },
  {
    name: "xym-ewkb-polygon",
    encoding: "EWKB M flag",
    typeCode: 0x40000003,
    createWkb: () => polygonWkb(0x40000003, [[[104, 30, 7], [105, 30, 8], [105, 31, 9], [104, 30, 7]]]),
    expectedGtype: 3303,
  },
  {
    name: "xym-iso-normalized-polygon",
    encoding: "ISO WKB XYM normalized to EWKB",
    typeCode: 2003,
    createWkb: () => polygonWkb(2003, [[[104, 30, 7], [105, 30, 8], [105, 31, 9], [104, 30, 7]]]),
    expectedGtype: 3303,
    normalizeForOracle: true,
  },
  {
    name: "xyzm-ewkb-linestring",
    encoding: "EWKB ZM flags",
    typeCode: 0xc0000002,
    createWkb: () => lineStringWkb(0xc0000002, [[104, 30, 5, 7], [105, 31, 6, 8]]),
    expectedGtype: 4402,
  },
  {
    name: "xyzm-iso-normalized-linestring",
    encoding: "ISO WKB XYZM normalized to EWKB",
    typeCode: 3002,
    createWkb: () => lineStringWkb(3002, [[104, 30, 5, 7], [105, 31, 6, 8]]),
    expectedGtype: 4402,
    normalizeForOracle: true,
  },
];
const adapter = new OracleAdapter(oracleConfigFromEnvironment(environment));
const report = {
  date: new Date().toISOString(),
  purpose: "Read-only Oracle SDO_UTIL WKB dimension probe using synthetic point WKB and DUAL.",
  externalDataSent: false,
  databaseObjectsCreated: false,
  results: [],
};

try {
  for (const testCase of cases) {
    const sourceWkb = testCase.createWkb?.() ?? pointWkb(testCase.typeCode, testCase.ordinates);
    const normalized = testCase.normalizeForOracle
      ? normalizeWkbForOracleSdo(sourceWkb, 4326)
      : { wkb: sourceWkb, srid: 4326 };
    const hex = normalized.wkb.toString("hex");
    try {
      const result = await adapter.query(
        `SELECT g.geom.SDO_GTYPE AS gtype, g.geom.SDO_SRID AS srid, `
          + `g.geom.SDO_POINT.X AS point_x, g.geom.SDO_POINT.Y AS point_y, g.geom.SDO_POINT.Z AS point_z, `
          + `v.x AS vertex_x, v.y AS vertex_y, v.z AS vertex_z, v.w AS vertex_w `
          + `FROM (SELECT MDSYS.SDO_UTIL.FROM_WKBGEOMETRY(TO_BLOB(HEXTORAW(:1)), :2) AS geom FROM DUAL) g `
          + `CROSS JOIN TABLE(MDSYS.SDO_UTIL.GETVERTICES(g.geom)) v`,
        [hex, normalized.srid],
      );
      assert.ok(result.rows.length > 0, "Oracle returned no vertices for the synthetic geometry.");
      const row = result.rows[0];
      const gtype = Number(row.GTYPE ?? row.gtype);
      const srid = Number(row.SRID ?? row.srid);
      assert.equal(gtype, testCase.expectedGtype);
      const pointZValue = row.POINT_Z ?? row.point_z;
      const pointZ = pointZValue === null || pointZValue === undefined ? null : Number(pointZValue);
      const vertexOrdinates = result.rows.map((vertex) => ["X", "Y", "Z", "W"].map((axis) => {
        const value = vertex[`VERTEX_${axis}`] ?? vertex[`vertex_${axis.toLowerCase()}`];
        return value === null || value === undefined ? null : Number(value);
      }));
      report.results.push({
        name: testCase.name,
        encoding: testCase.encoding,
        inputTypeCode: testCase.typeCode,
        expectedGtype: testCase.expectedGtype,
        normalizedToEwkb: Boolean(testCase.normalizeForOracle),
        gtype,
        srid,
        pointX: Number(row.POINT_X ?? row.point_x),
        pointY: Number(row.POINT_Y ?? row.point_y),
        pointZ,
        vertexCount: vertexOrdinates.length,
        vertexOrdinates,
        accepted: true,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      report.results.push({
        name: testCase.name,
        encoding: testCase.encoding,
        inputTypeCode: testCase.typeCode,
        expectedGtype: testCase.expectedGtype,
        normalizedToEwkb: Boolean(testCase.normalizeForOracle),
        accepted: false,
        databaseCode: /\b(?:ORA|NJS|DPI)-\d{4,5}\b/.exec(message)?.[0] ?? null,
        message: message.split(/\r?\n/, 1)[0].slice(0, 300),
      });
    }
  }
} catch (error) {
  report.status = "failed";
  const message = error instanceof Error ? error.message : String(error);
  const safeMessage = message
    .replaceAll(environment.ORACLE_PASSWORD, "[redacted]")
    .replaceAll(environment.ORACLE_CONNECT_STRING, "[connect-string]")
    .replaceAll(environment.ORACLE_USER, "[user]");
  report.error = {
    code: error && typeof error === "object" && "code" in error ? String(error.code) : null,
    errorNumber: error && typeof error === "object" && "errorNum" in error ? Number(error.errorNum) : null,
    databaseCode: /\b(?:ORA|NJS|DPI)-\d{4,5}\b/.exec(safeMessage)?.[0] ?? null,
    message: safeMessage.split(/\r?\n/, 1)[0].slice(0, 600),
  };
  await writeReport();
  throw new Error("Oracle WKB dimension probe failed; inspect the local Oracle test service and runner output.");
} finally {
  await adapter.close();
}

report.status = "completed";
function writeReport() {
  return writeFile(path.join(evidenceDirectory, "oracle-wkb-dimension-probe-20261122.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
}
await writeReport();
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
