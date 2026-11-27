import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import * as childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appendCrsOptions, appendGeometryValidityOptions, buildFieldProjectionSql, buildGeoJsonStringSubtypeSchemaOverride, buildKmlIdAttributeMapping, buildPostgresColumnTypeOverrides, buildPostgresNumericColumnTypeOverrides, companionFileWarnings, formatConversionWarnings, geoJsonJsonSubtypeImportWarning, GdalService, parseGisDriverCreationOptions, parseGisSpatialExtent, normalizeBaseGeometryType } from "./index.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFile: vi.fn(), spawn: vi.fn(actual.spawn) };
});

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  vi.restoreAllMocks();
  vi.clearAllMocks();
});


describe("scanFeatureDimensions early stop", () => {
  it("stops the subprocess once all four dimension signatures are seen", async () => {
    const service = new GdalService({ DBSTUDIO_GDAL_BIN: "unused" });
    const scanner = service as unknown as {
      runOgr2Ogr: (args: string[], options: unknown, env: NodeJS.ProcessEnv, onStdout?: (chunk: string) => void) => Promise<void>;
      scanFeatureDimensions: (prepared: { path: string; env: NodeJS.ProcessEnv; openOptions: string[]; cleanup: () => Promise<void> }, sourceLayer: string, spatialFilter: undefined, operationOptions: Record<string, unknown>) => Promise<{ signatures: Set<string>; targetSuffix: string; mixed: boolean }>;
    };
    let aborted = false;
    vi.spyOn(scanner, "runOgr2Ogr").mockImplementation(async (_args, options, _env, onStdout) => {
      const opts = options as { signal: AbortSignal };
      opts.signal.addEventListener("abort", () => { aborted = true; });
      for (const chunk of [
        'WKT\n"POINT (1 2)"\n"POINT Z (1 2 3)"\n"POINT M (1 2 4)"\n"POINT ZM (1 2 3 4)"\n',
        '"POINT (5 6)"\n'.repeat(100),
      ]) {
        if (opts.signal.aborted) break;
        onStdout?.(chunk);
      }
      if (opts.signal.aborted) throw new Error("cancelled");
    });
    const result = await scanner.scanFeatureDimensions(
      { path: "all-dimensions.geojson", env: {}, openOptions: [], cleanup: async () => undefined },
      "mixed", undefined, {},
    );
    expect(aborted).toBe(true);
    expect(result.signatures.size).toBe(4);
    expect(result.targetSuffix).toBe("ZM");
    expect(result.mixed).toBe(true);
  });
});

describe("GDAL driver creation options", () => {
  it("parses safe repeatable NAME=VALUE entries and rejects duplicates or control characters", () => {
    expect(parseGisDriverCreationOptions(["VERSION=1.2", "DESCRIPTION=Main road = test"])).toEqual([
      { name: "VERSION", value: "1.2" },
      { name: "DESCRIPTION", value: "Main road = test" },
    ]);
    expect(() => parseGisDriverCreationOptions(["SPATIAL_INDEX=NO", "spatial_index=YES"]))
      .toThrow("specified more than once");
    expect(() => parseGisDriverCreationOptions(["BAD-NAME=1"]))
      .toThrow("NAME=VALUE");
    expect(() => parseGisDriverCreationOptions(["DESCRIPTION=bad\nvalue"]))
      .toThrow("control characters");
  });
});

describe("GIS spatial filter parsing", () => {
  it("parses finite source-CRS bounds and rejects malformed or inverted extents", () => {
    expect(parseGisSpatialExtent("-1, 2.5, 3, 4")).toEqual({ minX: -1, minY: 2.5, maxX: 3, maxY: 4 });
    expect(() => parseGisSpatialExtent("1,2,3")).toThrow("four finite coordinates");
    expect(() => parseGisSpatialExtent("1,2,1,4")).toThrow("minimum bounds must be smaller");
  });
});

describe("GDAL virtual ZIP inputs", () => {
  it("preserves /vsizip paths and scopes CPL_ZIP_ENCODING to the inspection process", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "dbstudio-gis-vsizip-test-"));
    temporaryDirectories.push(directory);
    const bin = path.join(directory, "bin");
    await mkdir(bin);
    await writeFile(path.join(bin, "ogrinfo.exe"), "test executable");
    const input = "/vsizip/F:/datasets/线路.zip/成达高铁/成达高铁.TAB";
    let commandEnvironment: NodeJS.ProcessEnv | undefined;
    vi.mocked(childProcess.execFile).mockImplementation(((...args: unknown[]) => {
      const options = args[2] as { env?: NodeJS.ProcessEnv };
      const callback = args[3] as (error: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void;
      commandEnvironment = options.env;
      callback(null, JSON.stringify({
        driverShortName: "MapInfo File",
        layers: [{
          name: "成达高铁",
          featureCount: 140,
          geometryFields: [{ name: "geometry", type: "Line String" }],
          fields: [{ name: "名称", type: "String" }],
        }],
      }), "");
      return {} as never;
    }) as never);

    const service = new GdalService({ DBSTUDIO_GDAL_BIN: bin, PATH: "", CPL_ZIP_ENCODING: "CP437" });
    const result = await service.inspect(input, { zipFilenameEncoding: "UTF-8" });

    expect(result.path).toBe(input);
    expect(result.layers[0]?.featureCount).toBe(140);
    expect(result.encoding.source).toBe("unknown");
    expect(commandEnvironment?.CPL_ZIP_ENCODING).toBe("UTF-8");
  });
});

interface GeometryCommandMockOptions {
  issueCount: number;
  sampleFeatures: Array<Record<string, unknown>>;
  gdalError?: string;
}

async function createGeometryCheckService(extension = ".geojson") {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dbstudio-gis-geometry-check-test-"));
  temporaryDirectories.push(directory);
  const bin = path.join(directory, "bin");
  await mkdir(bin);
  for (const name of ["gdal.exe", "ogrinfo.exe", "ogr2ogr.exe"]) {
    await writeFile(path.join(bin, name), "test executable");
  }
  const input = path.join(directory, `input${extension}`);
  await writeFile(input, JSON.stringify({ type: "FeatureCollection", features: [] }));
  return { directory, input, service: new GdalService({ DBSTUDIO_GDAL_BIN: bin, PATH: "" }) };
}

function mockGeometryCommands(options: GeometryCommandMockOptions) {
  const calls: Array<{ executable: string; args: readonly string[] }> = [];
  vi.mocked(childProcess.execFile).mockImplementation(((...args: unknown[]) => {
    const executable = String(args[0]);
    const commandArgs = args[1] as readonly string[];
    const callback = args[3] as (error: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void;
    calls.push({ executable, args: commandArgs });

    let stdout = "";
    let stderr = "";
    let error: NodeJS.ErrnoException | null = null;
    if (executable.endsWith("ogrinfo.exe")) {
      const inspectedOutput = commandArgs.at(-1)?.endsWith("geometry-issues.gpkg") ?? false;
      stdout = JSON.stringify(inspectedOutput
        ? {
          layers: [{ name: "error_location", featureCount: options.issueCount, geometryFields: [{ type: "Point" }], fields: [{ name: "error", type: "String" }] }],
        }
        : {
          driverShortName: "GeoJSON",
          layers: [{ name: "input", featureCount: 3, geometryFields: [{ type: "Polygon" }], fields: [] }],
        });
    } else if (executable.endsWith("gdal.exe")) {
      if (options.gdalError) {
        error = Object.assign(new Error(options.gdalError), { code: "1" });
        stderr = options.gdalError;
      }
    } else if (executable.endsWith("ogr2ogr.exe")) {
      stdout = commandArgs[1] === "CSV"
        ? "geometry_0_feature_count,geometry_0_null_count,geometry_0_empty_count\n3,1,1\n"
        : JSON.stringify({ type: "FeatureCollection", features: options.sampleFeatures });
    } else {
      error = Object.assign(new Error(`Unexpected executable: ${executable}`), { code: "1" });
    }

    callback(error, stdout, stderr);
    return {} as never;
  }) as never);
  return calls;
}

async function geometryCheckTempDirectories() {
  const entries = await readdir(os.tmpdir(), { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory() && entry.name.startsWith("dbstudio-gis-geometry-check-"))
    .map((entry) => entry.name)
    .sort();
}

async function createMapInfoReadFailureFixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dbstudio-gis-mapinfo-read-failure-"));
  temporaryDirectories.push(directory);
  const bin = path.join(directory, "bin");
  await mkdir(bin);
  for (const name of ["gdal.exe", "ogrinfo.exe", "ogr2ogr.exe"]) {
    await writeFile(path.join(bin, name), "test executable");
  }
  const input = path.join(directory, "sample.tab");
  const sourceText = [
    "!table",
    "!version 300",
    "!charset Neutral",
    "",
    "Definition Table",
    '  Type NATIVE Charset "Neutral"',
    "  Fields 1",
    "    name Char (20);",
    "",
  ].join("\r\n");
  await writeFile(input, sourceText);
  return {
    directory,
    input,
    sourceText,
    service: new GdalService({ DBSTUDIO_GDAL_BIN: bin, PATH: "" }),
  };
}

describe("MapInfo read error guidance", () => {
  it.each([
    [
      "ERROR 1: ReadBytes(): Attempt to read past end of data block.",
      "GDAL could not complete a MapInfo data-block read.",
    ],
    [
      "ERROR 1: Too big nCoordDataSize = 30598648",
      "GDAL rejected the MapInfo coordinate-block size (30598648 bytes).",
    ],
  ])("adds targeted guidance without losing the GDAL error for %s", async (stderr, guidance) => {
    const { input, sourceText, service } = await createMapInfoReadFailureFixture();
    const inspection = JSON.stringify({
      driverShortName: "MapInfo File",
      layers: [{
        name: "sample",
        featureCount: 1,
        geometryFields: [{ name: "geometry", type: "Point" }],
        fields: [{ name: "name", type: "String" }],
      }],
    });
    vi.mocked(childProcess.execFile).mockImplementation(((...args: unknown[]) => {
      const executable = String(args[0]);
      const callback = args[3] as (error: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void;
      if (executable.endsWith("ogrinfo.exe")) {
        callback(null, inspection, "");
      } else {
        callback(Object.assign(new Error("GDAL read failed"), { code: "1" }), "", stderr);
      }
      return {} as never;
    }) as never);

    await expect(service.previewAttributes(input, { sourceLayer: "sample", sourceEncoding: "CP936" }))
      .rejects.toThrow(guidance);
    expect(await readFile(input, "utf8")).toBe(sourceText);
  });

  it("rejects ogrinfo ERROR diagnostics even when the process callback reports success", async () => {
    const { input, sourceText, service } = await createMapInfoReadFailureFixture();
    const inspection = JSON.stringify({
      driverShortName: "MapInfo File",
      layers: [{
        name: "sample",
        featureCount: 0,
        geometryFields: [{ name: "geometry", type: "Line String" }],
        fields: [{ name: "name", type: "String" }],
      }],
    });
    const stderr = "ERROR 1: Too big nCoordDataSize = 30598648";
    vi.mocked(childProcess.execFile).mockImplementation(((...args: unknown[]) => {
      const callback = args[3] as (error: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void;
      callback(null, inspection, stderr);
      return {} as never;
    }) as never);

    await expect(service.previewAttributes(input, { sourceLayer: "sample", sourceEncoding: "UTF-8" }))
      .rejects.toThrow("GDAL rejected the MapInfo coordinate-block size (30598648 bytes).");
    expect(await readFile(input, "utf8")).toBe(sourceText);
  });

  it("adds the same guidance to a conversion report while retaining the raw GDAL sample", async () => {
    const { directory, input, sourceText, service } = await createMapInfoReadFailureFixture();
    const inspection = JSON.stringify({
      driverShortName: "MapInfo File",
      layers: [{
        name: "sample",
        featureCount: 1,
        geometryFields: [{ name: "geometry", type: "Point" }],
        fields: [{ name: "name", type: "String" }],
      }],
    });
    vi.mocked(childProcess.execFile).mockImplementation(((...args: unknown[]) => {
      const executable = String(args[0]);
      const callback = args[3] as (error: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void;
      if (executable.endsWith("ogrinfo.exe")) {
        callback(null, inspection, "");
      } else {
        callback(Object.assign(new Error("Unexpected executable: " + executable), { code: "1" }), "", "");
      }
      return {} as never;
    }) as never);

    const stderr = "ERROR 1: Too big nCoordDataSize = 30598648";
    vi.mocked(childProcess.spawn).mockImplementation(((...args: unknown[]) => {
      const child = new EventEmitter() as EventEmitter & {
        stderr: PassThrough;
        stdout: PassThrough;
        kill: () => boolean;
      };
      child.stderr = new PassThrough();
      child.stdout = new PassThrough();
      child.kill = () => true;
      void Promise.resolve().then(() => {
        child.stderr.end(stderr);
        child.stdout.end();
        child.emit("close", 1, null);
      });
      return child as never;
    }) as never);

    await expect(service.convert(input, path.join(directory, "converted.gpkg"), { sourceEncoding: "CP936" }))
      .rejects.toMatchObject({
        name: "GisOperationError",
        message: expect.stringContaining("GDAL rejected the MapInfo coordinate-block size (30598648 bytes)."),
        report: {
          status: "failed",
          failedSamples: expect.arrayContaining([stderr]),
        },
      });
    expect(await readFile(input, "utf8")).toBe(sourceText);
  });

  it("fails conversion when ogr2ogr exits zero after a chunked GDAL ERROR diagnostic", async () => {
    const { directory, input, sourceText, service } = await createMapInfoReadFailureFixture();
    const inspection = JSON.stringify({
      driverShortName: "MapInfo File",
      layers: [{
        name: "sample",
        featureCount: 1,
        geometryFields: [{ name: "geometry", type: "Line String" }],
        fields: [{ name: "name", type: "String" }],
      }],
    });
    vi.mocked(childProcess.execFile).mockImplementation(((...args: unknown[]) => {
      const executable = String(args[0]);
      const callback = args[3] as (error: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void;
      if (executable.endsWith("ogrinfo.exe")) callback(null, inspection, "");
      else callback(Object.assign(new Error("Unexpected executable: " + executable), { code: "1" }), "", "");
      return {} as never;
    }) as never);

    const stderr = "ERROR 1: Too big nCoordDataSize = 30598648";
    vi.mocked(childProcess.spawn).mockImplementation((() => {
      const child = new EventEmitter() as EventEmitter & {
        stderr: PassThrough;
        stdout: PassThrough;
        kill: () => boolean;
      };
      child.stderr = new PassThrough();
      child.stdout = new PassThrough();
      child.kill = () => true;
      void Promise.resolve().then(() => {
        child.stderr.write("ERROR ");
        child.stderr.end("1: Too big nCoordDataSize = 30598648");
        child.stdout.end();
        child.emit("close", 0, null);
      });
      return child as never;
    }) as never);

    await expect(service.convert(input, path.join(directory, "converted.gpkg"), { sourceEncoding: "UTF-8" }))
      .rejects.toMatchObject({
        name: "GisOperationError",
        message: expect.stringContaining("GDAL rejected the MapInfo coordinate-block size (30598648 bytes)."),
        report: {
          status: "failed",
          failedSamples: expect.arrayContaining([stderr]),
        },
      });
    expect(await readFile(input, "utf8")).toBe(sourceText);
  });
});

describe("GIS operation diagnostics", () => {
  it("omits feature field values and WKB from GDAL failure samples", async () => {
    const { directory, input, service } = await createMapInfoReadFailureFixture();
    const inspection = JSON.stringify({
      driverShortName: "MapInfo File",
      layers: [{
        name: "sample",
        featureCount: 1,
        geometryFields: [{ name: "geometry", type: "Point" }],
        fields: [{ name: "name", type: "String" }],
      }],
    });
    vi.mocked(childProcess.execFile).mockImplementation(((...args: unknown[]) => {
      const executable = String(args[0]);
      const callback = args[3] as (error: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void;
      if (executable.endsWith("ogrinfo.exe")) {
        callback(null, inspection, "");
      } else {
        callback(Object.assign(new Error("Unexpected executable"), { code: "1" }), "", "");
      }
      return {} as never;
    }) as never);

    const secretValue = "private-customer-name";
    const wkb = "0101000000DEADBEEF";
    const stderr = [
      `ERROR 1: Non UTF-8 content found when writing feature 281017 with field values: name = "${secretValue}", geometry = ${wkb}`,
      `ERROR 1: Failed to write feature 281018 WKB: ${wkb}`,
    ].join("\n");
    vi.mocked(childProcess.spawn).mockImplementation(((...args: unknown[]) => {
      const child = new EventEmitter() as EventEmitter & {
        stderr: PassThrough;
        stdout: PassThrough;
        kill: () => boolean;
      };
      child.stderr = new PassThrough();
      child.stdout = new PassThrough();
      child.kill = () => true;
      void Promise.resolve().then(() => {
        child.stderr.end(stderr);
        child.stdout.end();
        child.emit("close", 1, null);
      });
      return child as never;
    }) as never);

    const failure = await service.convert(input, path.join(directory, "converted.gpkg"), { sourceEncoding: "CP936" })
      .then(() => { throw new Error("Expected conversion to fail"); }, (error: unknown) => error as Error & {
        report?: { failedSamples: string[] };
      });
    const safeDiagnostic = "ERROR 1: Non UTF-8 content found when writing feature [index omitted] [record payload omitted]";
    const safeWkbDiagnostic = "ERROR 1: Failed to write feature [index omitted] [record payload omitted]";
    expect(failure.message).toContain(safeDiagnostic);
    expect(failure.message).toContain(safeWkbDiagnostic);
    expect(failure.message).not.toContain(secretValue);
    expect(failure.message).not.toContain(wkb);
    expect(failure.report?.failedSamples).toEqual([safeDiagnostic, safeWkbDiagnostic]);
  });
});

describe("GIS operation cancellation", () => {
  it("reports cancellation and removes the staged output directory", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "dbstudio-gis-cancel-"));
    temporaryDirectories.push(directory);
    const output = path.join(directory, "roads.gpkg");
    const controller = new AbortController();
    controller.abort();

    const service = new GdalService({ PGDATABASE: "test", PGUSER: "test" });
    await expect(service.exportFromPostgres(
      "public.roads",
      output,
      {},
      {},
      { signal: controller.signal },
    )).rejects.toMatchObject({
      name: "GisOperationError",
      report: {
        operation: "export",
        status: "cancelled",
        output,
        successfulFeatures: 0,
      },
    });

    expect(await readdir(directory)).toEqual([]);
  });
});

describe("CSV GIS output", () => {
  it("preserves WKT geometry and staged CRS/type sidecars without overwriting existing companions", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "dbstudio-gis-csv-export-test-"));
    temporaryDirectories.push(directory);
    const bin = path.join(directory, "bin");
    await mkdir(bin);
    for (const name of ["gdal.exe", "ogrinfo.exe", "ogr2ogr.exe"]) {
      await writeFile(path.join(bin, name), "test executable");
    }

    const exportCalls: Array<readonly string[]> = [];
    vi.mocked(childProcess.execFile).mockImplementation(((...args: unknown[]) => {
      const executable = String(args[0]);
      const commandArgs = args[1] as readonly string[];
      const callback = args[3] as (error: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void;
      if (!executable.endsWith("ogrinfo.exe")) {
        callback(Object.assign(new Error("Unexpected executable"), { code: "1" }), "", "");
        return {} as never;
      }
      const isPostgres = commandArgs.includes("PG:");
      const stdout = JSON.stringify(isPostgres
        ? { layers: [{ name: "roads", featureCount: 1, crs: "EPSG:3857", geometryFields: [{ name: "geom", type: "Point" }], fields: [{ name: "name", type: "String" }] }] }
        : { driverShortName: "CSV", layers: [{ name: "roads", featureCount: 1, geometryFields: [{ name: "WKT", type: "Point" }], fields: [{ name: "name", type: "String" }], crs: "EPSG:4326" }] });
      callback(null, stdout, "");
      return {} as never;
    }) as never);
    vi.mocked(childProcess.spawn).mockImplementation(((...args: unknown[]) => {
      const commandArgs = args[1] as readonly string[];
      exportCalls.push(commandArgs);
      const output = String(commandArgs[2]);
      const child = new EventEmitter() as EventEmitter & {
        stderr: PassThrough;
        stdout: PassThrough;
        kill: () => boolean;
      };
      child.stderr = new PassThrough();
      child.stdout = new PassThrough();
      child.kill = () => true;
      void Promise.all([
        writeFile(output, 'WKT,name\r\n"POINT (1 2)",road\r\n'),
        writeFile(output.replace(/\.csv$/i, ".csvt"), '"WKT","String"\r\n'),
        writeFile(output.replace(/\.csv$/i, ".prj"), "WGS 84\r\n"),
      ]).then(() => {
        child.stderr.end();
        child.stdout.end();
        child.emit("close", 0, null);
      });
      return child as never;
    }) as never);

    const output = path.join(directory, "roads.csv");
    const existingTypeFile = output.replace(/\.csv$/i, ".csvt");
    await writeFile(existingTypeFile, "keep existing file");
    const service = new GdalService({ DBSTUDIO_GDAL_BIN: bin, PATH: "", PGDATABASE: "test", PGUSER: "test" });
    const connection = { host: "127.0.0.1", port: 5432, database: "test", user: "test", password: "test" };
    await expect(service.exportFromPostgres("public.roads", output, connection)).rejects.toThrow("companion files already exists");
    expect(await readFile(existingTypeFile, "utf8")).toBe("keep existing file");
    await rm(existingTypeFile);

    for (const targetLayerName of ["", "   ", "-unsafe", "unsafe\nname"]) {
      await expect(service.exportFromPostgres("public.roads", output, connection, { targetLayerName }))
        .rejects.toThrow("Output layer name");
    }
    expect(exportCalls).toHaveLength(0);

    await expect(service.exportFromPostgres("public.roads", output, connection, {
      layerCreationOptions: ["GEOMETRY=OTHER"],
    })).rejects.toThrow("is managed by DB Studio");
    expect(exportCalls).toHaveLength(0);

    const result = await service.exportFromPostgres("public.roads", output, connection, {
      targetCrs: "EPSG:4326",
      spatialFilter: { minX: -2, minY: -1, maxX: 3, maxY: 4 },
      layerCreationOptions: ["SEPARATOR=SEMICOLON"],
    });
    expect(exportCalls).toHaveLength(1);
    expect(exportCalls[0]).toEqual(expect.arrayContaining([
      "-f", "CSV", "-nln", "roads", "-lco", "GEOMETRY=AS_WKT", "-lco", "CREATE_CSVT=YES", "-lco", "SEPARATOR=SEMICOLON", "-t_srs", "EPSG:4326",
      "-spat", "-2", "-1", "3", "4",
    ]));
    await expect(readFile(output, "utf8")).resolves.toContain("POINT (1 2)");
    await expect(readFile(existingTypeFile, "utf8")).resolves.toContain("WKT");
    await expect(readFile(output.replace(/\.csv$/i, ".prj"), "utf8")).resolves.toContain("WGS 84");
    expect(result.operationReport?.warnings?.join(" ")).toContain("keep those files with the CSV");

    const renamedOutput = path.join(directory, "roads-renamed.csv");
    await service.exportFromPostgres("public.roads", renamedOutput, connection, { targetLayerName: "transport_network" });
    expect(exportCalls).toHaveLength(2);
    expect(exportCalls[1]).toEqual(expect.arrayContaining(["-f", "CSV", "-nln", "transport_network"]));
  });
});

describe("GIS geometry dimension scanning", () => {
  it("classifies XY, Z, M and ZM headers across chunks without retaining long WKT rows", async () => {
    const service = new GdalService({ DBSTUDIO_GDAL_BIN: "unused" });
    const scanner = service as unknown as {
      runOgr2Ogr: (
        args: string[],
        options: unknown,
        env: NodeJS.ProcessEnv,
        onStdout?: (chunk: string) => void,
      ) => Promise<void>;
      scanFeatureDimensions: (
        prepared: { path: string; env: NodeJS.ProcessEnv; openOptions: string[]; cleanup: () => Promise<void> },
        sourceLayer: string,
        spatialFilter: undefined,
        operationOptions: Record<string, unknown>,
      ) => Promise<{
        signatures: Set<string>;
        hasZ: boolean;
        hasM: boolean;
        mixed: boolean;
        hasMissingZ: boolean;
        hasMissingM: boolean;
        targetSuffix: "" | "Z" | "M" | "ZM";
      }>;
    };
    const longRing = `${"1 2 3 4,".repeat(50_000)}1 2 3 4`;
    const longPolygonRow = `"POLYGON ZM ((${longRing}))"\n`;
    const chunks = [
      "WK",
      'T\n"POINT (1 2)"\n"POINT Z',
      ' (3 4 5)"\n"POINT M',
      ' (6 7 8)"\n"POINT Z',
      'M (9 10 11 12)"\n',
    ];
    for (let offset = 0; offset < longPolygonRow.length; offset += 8_192) {
      chunks.push(longPolygonRow.slice(offset, offset + 8_192));
    }
    vi.spyOn(scanner, "runOgr2Ogr").mockImplementation(async (_args, _options, _env, onStdout) => {
      for (const chunk of chunks) onStdout?.(chunk);
    });

    const result = await scanner.scanFeatureDimensions({
      path: "mixed-dimensions.geojson",
      env: {},
      openOptions: [],
      cleanup: async () => undefined,
    }, "mixed", undefined, {});

    expect([...result.signatures]).toEqual(["", "Z", "M", "ZM"]);
    expect(result).toMatchObject({
      hasZ: true,
      hasM: true,
      mixed: true,
      hasMissingZ: true,
      hasMissingM: true,
      targetSuffix: "ZM",
    });
  });
});

describe("GIS geometry repair options", () => {
  it("keeps source geometry unchanged by default and adds GDAL MakeValid only when selected", () => {
    const args: string[] = [];
    appendGeometryValidityOptions(args);
    expect(args).toEqual([]);
    appendGeometryValidityOptions(args, true);
    expect(args).toEqual(["-makevalid"]);
  });
});

describe("GIS geometry validation", () => {
  it("reports bounded issue records with Point and MultiPoint locations", async () => {
    const { input, service } = await createGeometryCheckService();
    const calls = mockGeometryCommands({
      issueCount: 2,
      sampleFeatures: [
        {
          type: "Feature",
          properties: { error: "Self-intersection" },
          geometry: { type: "MultiPoint", coordinates: [[1, 2, 9], [3, 4]] },
        },
        {
          type: "Feature",
          properties: { error: "Too few points" },
          geometry: { type: "Point", coordinates: [5, 6] },
        },
      ],
    });

    const report = await service.checkGeometry(input, { sampleLimit: 2 });

    expect(report).toMatchObject({
      layer: "input",
      featureCount: 3,
      geometryCounts: [{ field: null, featureCount: 3, nullGeometryCount: 1, emptyGeometryCount: 1 }],
      issueCount: 2,
      issuesTruncated: false,
      issues: [
        { reason: "Self-intersection", locations: [{ x: 1, y: 2 }, { x: 3, y: 4 }] },
        { reason: "Too few points", locations: [{ x: 5, y: 6 }] },
      ],
    });
    expect(calls.find((call) => call.executable.endsWith("gdal.exe"))?.args).toEqual([
      "vector", "check-geometry", "--quiet", "--input-layer", "input", "-f", "GPKG",
      input, expect.stringContaining("geometry-issues.gpkg"), "--overwrite",
    ]);
    expect(calls.find((call) => call.executable.endsWith("ogr2ogr.exe") && call.args[1] === "CSV")?.args).toEqual([
      "-f", "CSV", "/vsistdout/", input, "-dialect", "SQLite", "-sql",
      'SELECT COUNT(*) AS "geometry_0_feature_count", COALESCE(SUM(CASE WHEN "geometry" IS NULL THEN 1 ELSE 0 END), 0) AS "geometry_0_null_count", COALESCE(SUM(CASE WHEN ST_IsEmpty("geometry") THEN 1 ELSE 0 END), 0) AS "geometry_0_empty_count" FROM "input"',
    ]);
  });

  it("marks a result truncated when the sample limit hides issue records", async () => {
    const { input, service } = await createGeometryCheckService();
    const calls = mockGeometryCommands({
      issueCount: 4,
      sampleFeatures: [{ type: "Feature", properties: { error: "Self-intersection" }, geometry: { type: "Point", coordinates: [1, 1] } }],
    });

    const report = await service.checkGeometry(input, { sampleLimit: 1 });

    expect(report.issueCount).toBe(4);
    expect(report.issues).toHaveLength(1);
    expect(report.issuesTruncated).toBe(true);
    expect(calls.find((call) => call.executable.endsWith("ogr2ogr.exe") && call.args[1] === "GeoJSON")?.args).toContain("1");
  });

  it("uses gdal vector open-option syntax for Shapefile encoding overrides", async () => {
    const { input, service } = await createGeometryCheckService(".shp");
    const calls = mockGeometryCommands({ issueCount: 0, sampleFeatures: [] });

    await service.checkGeometry(input, { sourceEncoding: "UTF-8" });

    const args = calls.find((call) => call.executable.endsWith("gdal.exe"))?.args ?? [];
    expect(args).toContain("--oo");
    expect(args).toContain("ENCODING=UTF-8");
    expect(args).not.toContain("-oo");
  });

  it("rejects invalid sample limits before starting a GDAL process", async () => {
    const { input, service } = await createGeometryCheckService();
    await expect(service.checkGeometry(input, { sampleLimit: 101 })).rejects.toThrow("between 1 and 100");
    expect(childProcess.execFile).not.toHaveBeenCalled();
  });

  it("cleans temporary inputs and issue databases when GDAL validation fails", async () => {
    const { input, service } = await createGeometryCheckService();
    const calls = mockGeometryCommands({ issueCount: 0, sampleFeatures: [], gdalError: "GEOS validation failed" });
    const before = await geometryCheckTempDirectories();

    await expect(service.checkGeometry(input)).rejects.toThrow("GEOS validation failed");

    expect(calls.some((call) => call.executable.endsWith("gdal.exe"))).toBe(true);
    expect(await geometryCheckTempDirectories()).toEqual(before);
  });
});

describe("GIS companion-file checks", () => {
  it("reports missing Shapefile index, attributes and CRS sidecars case-insensitively", () => {
    expect(companionFileWarnings("Roads.SHP", ["roads.shp"])).toEqual([
      "Shapefile sidecar missing: roads.shx (shape index).",
      "Shapefile sidecar missing: roads.dbf (attribute table).",
      "Shapefile CRS sidecar missing: roads.prj/.qpj; specify the source CRS before transforming coordinates.",
    ]);
  });

  it("accepts either supported projection sidecar and checks MapInfo TAB data files", () => {
    expect(companionFileWarnings("roads.shp", ["ROADS.SHP", "roads.shx", "roads.dbf", "roads.qpj"])).toEqual([]);
    expect(companionFileWarnings("districts.tab", ["districts.TAB", "districts.id"])).toEqual([
      "MapInfo TAB sidecar missing: districts.dat (attribute data).",
      "MapInfo TAB sidecar missing: districts.map (geometry data).",
    ]);
  });
});

describe("GIS field mapping", () => {
  const layer = {
    name: "source layer",
    geometryType: "Point",
    crs: "EPSG:4326",
    featureCount: 1,
    extent: null,
    fields: [{ name: "名称", type: "String" }, { name: "rank", type: "Integer" }],
  };

  it("builds a quoted OGR SQL projection with field aliases and type casts", () => {
    expect(buildFieldProjectionSql(layer, [
      { source: "名称", target: "display name" },
      { source: "rank", target: "rank", targetType: "integer64" },
    ])).toBe('SELECT "名称" AS "display name", CAST("rank" AS bigint) AS "rank" FROM "source layer"');
  });

  it("keeps the original import path when all mappings are unchanged", () => {
    expect(buildFieldProjectionSql(layer, [{ source: "名称", target: "名称" }])).toBeUndefined();
  });

  it("widens narrow string fields for MapInfo and keeps the geometry column in the projection", () => {
    const tabLayer = {
      ...layer,
      name: "metro",
      geometryFields: [{ name: "geom", type: "Line String" }],
      fields: [
        { name: "线路", type: "String", width: 10 },
        { name: "编号", type: "String", width: 60 },
        { name: "direction", type: "String", width: 254 },
      ],
    };

    expect(buildFieldProjectionSql(tabLayer, [], { stringWidth: 254, includeGeometry: true }))
      .toBe('SELECT CAST("线路" AS character(254)) AS "线路", CAST("编号" AS character(254)) AS "编号", "direction", "geom" FROM "metro"');
  });

  it("maps a KML string id field to a collision-free attribute name", () => {
    const idLayer = {
      ...layer,
      fields: [{ name: "id", type: "String" }, { name: "source_id", type: "String" }],
    };
    expect(buildKmlIdAttributeMapping(idLayer)).toEqual({ source: "id", target: "source_id_2" });
    expect(buildKmlIdAttributeMapping(
      { ...layer, fields: [{ name: "id", type: "String" }, { name: "name", type: "String" }] },
      [{ source: "name", target: "source_id" }],
    )).toEqual({ source: "id", target: "source_id_2" });
    expect(buildKmlIdAttributeMapping(idLayer, [{ source: "id", target: "feature_code" }])).toBeUndefined();
  });

  it("applies the automatic KML id alias to the PostGIS export projection", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "dbstudio-gis-kml-id-export-test-"));
    temporaryDirectories.push(directory);
    const bin = path.join(directory, "bin");
    await mkdir(bin);
    for (const name of ["gdal.exe", "ogrinfo.exe", "ogr2ogr.exe"]) {
      await writeFile(path.join(bin, name), "test executable");
    }

    const exportCalls: Array<readonly string[]> = [];
    vi.mocked(childProcess.execFile).mockImplementation(((...args: unknown[]) => {
      const executable = String(args[0]);
      const commandArgs = args[1] as readonly string[];
      const callback = args[3] as (error: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void;
      if (executable.endsWith("ogrinfo.exe")) {
        const isPostgres = commandArgs.includes("PG:");
        const stdout = JSON.stringify(isPostgres
          ? {
            layers: [{
              name: "roads",
              featureCount: 2,
              geometryFields: [{ type: "Line String" }],
              fields: [{ name: "id", type: "String" }, { name: "name", type: "String" }],
            }],
          }
          : {
            driverShortName: "KML",
            layers: [{
              name: "roads",
              featureCount: 2,
              geometryFields: [{ type: "Line String" }],
              fields: [{ name: "source_id", type: "String" }, { name: "name", type: "String" }],
            }],
          });
        callback(null, stdout, "");
        return {} as never;
      }
      callback(Object.assign(new Error("Unexpected executable"), { code: "1" }), "", "");
      return {} as never;
    }) as never);
    vi.mocked(childProcess.spawn).mockImplementation(((...args: unknown[]) => {
      const commandArgs = args[1] as readonly string[];
      exportCalls.push(commandArgs);
      const child = new EventEmitter() as EventEmitter & {
        stderr: PassThrough;
        stdout: PassThrough;
        kill: () => boolean;
      };
      child.stderr = new PassThrough();
      child.stdout = new PassThrough();
      child.kill = () => true;
      void writeFile(String(commandArgs[2]), "<kml/>").then(() => {
        child.stderr.end();
        child.stdout.end();
        child.emit("close", 0, null);
      });
      return child as never;
    }) as never);

    const output = path.join(directory, "roads.kml");
    const service = new GdalService({
      DBSTUDIO_GDAL_BIN: bin,
      PATH: "",
      PGDATABASE: "test",
      PGUSER: "test",
      PGPASSWORD: "test",
    });
    const result = await service.exportFromPostgres(
      "public.roads",
      output,
      { host: "127.0.0.1", port: 5432, database: "test", user: "test", password: "test" },
    );

    const commandArgs = exportCalls[0];
    expect(commandArgs).toBeDefined();
    const sqlIndex = commandArgs!.indexOf("-sql");
    expect(sqlIndex).toBeGreaterThanOrEqual(0);
    expect(commandArgs![sqlIndex + 1]).toContain('"id" AS "source_id"');
    expect(commandArgs).toContain("OGRSQL");
    expect(result.operationReport?.warnings?.join(" ")).toMatch(/exported as source_id so its value can round-trip/);
  });

  it("rejects unknown fields, duplicate targets and unsupported types", () => {
    expect(() => buildFieldProjectionSql(layer, [{ source: "missing", target: "renamed" }])).toThrow("source field was not found");
    expect(() => buildFieldProjectionSql(layer, [{ source: "名称", target: "rank" }])).toThrow("target field name is duplicated");
    expect(() => buildFieldProjectionSql(layer, [
      { source: "rank", target: "rank", targetType: "binary" as never },
    ])).toThrow("target field type is not supported");
  });

  it("overrides JSON subtypes at GeoJSON source read time for explicit string mappings", () => {
    const jsonLayer = {
      ...layer,
      fields: [
        { name: "grid_id", type: "String", subType: "JSON" },
        { name: "label", type: "String" },
      ],
    };
    expect(buildGeoJsonStringSubtypeSchemaOverride(jsonLayer, [
      { source: "grid_id", target: "grid_id", targetType: "string" },
      { source: "label", target: "label", targetType: "string" },
    ])).toBe(JSON.stringify({
      layers: [{
        name: "source layer",
        schemaType: "Patch",
        fields: [{ name: "grid_id", type: "String", subType: "None" }],
      }],
    }));
    expect(buildGeoJsonStringSubtypeSchemaOverride(jsonLayer, [])).toBeUndefined();
  });

  it("identifies unmapped GeoJSON JSON-subtype fields after PostGIS rejects JSON input", () => {
    const jsonLayer = {
      ...layer,
      fields: [
        { name: "city_id", type: "String", subType: "JSON" },
        { name: "county_id", type: "String", subType: "JSON" },
        { name: "label", type: "String" },
      ],
    };
    const warning = geoJsonJsonSubtypeImportWarning(
      jsonLayer,
      [{ source: "city_id", target: "city_id", targetType: "string" }],
      'PostGIS COPY failed (invalid input syntax for type json) at field "county_id"',
    );

    expect(warning).toContain("Unmapped JSON-subtype fields: county_id.");
    expect(warning).toContain("--field-type <field>=string");
    expect(warning).toContain("stores numbers and other scalar values as text rather than JSON");
    expect(geoJsonJsonSubtypeImportWarning(
      jsonLayer,
      jsonLayer.fields.slice(0, 2).map((field) => ({ source: field.name, target: field.name, targetType: "string" as const })),
      "invalid input syntax for type json",
    )).toBeUndefined();
    expect(geoJsonJsonSubtypeImportWarning(jsonLayer, [], "database connection failed")).toBeUndefined();
  });
});

describe("PostGIS numeric precision mapping", () => {
  const layer = {
    name: "source layer",
    geometryType: "Point",
    crs: "EPSG:4326",
    featureCount: 1,
    extent: null,
    fields: [
      { name: "decimal_value", type: "Real", width: 12, precision: 11 },
      { name: "integer_value", type: "Integer", width: 8, precision: 0 },
      { name: "float_without_scale", type: "Real", width: 14, precision: 0 },
    ],
  };

  it("uses unconstrained NUMERIC for real fields with source scale", () => {
    expect(buildPostgresNumericColumnTypeOverrides(layer)).toEqual({
      option: "COLUMN_TYPES=decimal_value=NUMERIC",
      skippedFields: [],
    });
  });

  it("applies a rename and respects an explicit target type", () => {
    expect(buildPostgresNumericColumnTypeOverrides(layer, [
      { source: "decimal_value", target: "safe_decimal" },
      { source: "integer_value", target: "exact_integer", targetType: "real" },
    ])).toEqual({ option: "COLUMN_TYPES=safe_decimal=NUMERIC", skippedFields: [] });
  });

  it("skips field names that cannot be represented in GDAL COLUMN_TYPES syntax", () => {
    const unsafeLayer = {
      ...layer,
      fields: [{ name: "decimal,value", type: "Real", width: 12, precision: 11 }],
    };
    expect(buildPostgresNumericColumnTypeOverrides(unsafeLayer)).toEqual({
      skippedFields: ["decimal,value"],
    });
  });

  it("forces explicitly mapped JSON subtype fields to PostgreSQL VARCHAR", () => {
    const jsonLayer = {
      ...layer,
      fields: [{ name: "grid_id", type: "String", subType: "JSON" }],
    };
    expect(buildPostgresColumnTypeOverrides(jsonLayer, [
      { source: "grid_id", target: "grid_id", targetType: "string" },
    ])).toEqual({
      option: "COLUMN_TYPES=grid_id=VARCHAR",
      skippedFields: [],
      numericFields: [],
      stringFields: ["grid_id"],
    });
  });
});

describe("GIS CRS arguments", () => {
  const source = { layers: [{ crs: "EPSG:4326" }] } as Parameters<typeof appendCrsOptions>[1];

  it("assigns a lone source CRS without requesting a coordinate transformation", () => {
    const args: string[] = [];
    appendCrsOptions(args, source, { sourceCrs: "EPSG:4326" });
    expect(args).toEqual(["-a_srs", "EPSG:4326"]);
  });

  it("uses source and target CRS options when transforming coordinates", () => {
    const args: string[] = [];
    appendCrsOptions(args, source, { sourceCrs: "EPSG:4326", targetCrs: "EPSG:3857" });
    expect(args).toEqual(["-s_srs", "EPSG:4326", "-t_srs", "EPSG:3857"]);
  });

  it("passes an explicit PROJ operation only alongside a target CRS", () => {
    const args: string[] = [];
    appendCrsOptions(args, source, {
      sourceCrs: "EPSG:4326", targetCrs: "EPSG:3857",
      coordinateOperation: "+proj=pipeline +step +proj=unitconvert +xy_in=deg +xy_out=rad",
    });
    expect(args).toEqual([
      "-s_srs", "EPSG:4326", "-t_srs", "EPSG:3857", "-ct", "+proj=pipeline +step +proj=unitconvert +xy_in=deg +xy_out=rad",
    ]);
    expect(() => appendCrsOptions([], source, { coordinateOperation: "+proj=pipeline" })).toThrow("requires a target CRS");
    expect(() => appendCrsOptions([], source, { targetCrs: "EPSG:3857", coordinateOperation: "pipeline\n+step" })).toThrow("without control characters");
  });

  it("requires a source CRS when transforming an unreferenced dataset", () => {
    const args: string[] = [];
    const unreferenced = { layers: [{ crs: null }] } as Parameters<typeof appendCrsOptions>[1];
    expect(() => appendCrsOptions(args, unreferenced, { targetCrs: "EPSG:3857" }))
      .toThrow("Source CRS is missing");
  });
});

describe("GIS conversion limitation reports", () => {
  it("reports documented Shapefile, MapInfo and GeoJSON constraints", () => {
    const layer = {
      name: "roads",
      geometryType: "GeometryCollection",
      crs: "EPSG:4326",
      featureCount: 2,
      extent: null,
      fields: [{ name: "occurred_at", type: "DateTime" }],
    };
    expect(formatConversionWarnings("roads.shp", [layer]).join(" ")).toMatch(/10 characters/);
    expect(formatConversionWarnings("roads.shp", [layer]).join(" ")).toMatch(/GeometryCollection/);
    expect(formatConversionWarnings("roads.tab", [layer]).join(" ")).toMatch(/supports Integer, Real and String/);
    expect(formatConversionWarnings("roads.tab", [layer]).join(" ")).toMatch(/format-limited precision/);
    expect(formatConversionWarnings("roads.geojson").join(" ")).toMatch(/RFC 7946/);
    expect(formatConversionWarnings("roads.geojson").join(" ")).toMatch(/17 decimal places/);
    expect(formatConversionWarnings("roads.geojson").join(" ")).not.toMatch(/defaults to 7 coordinate decimal places/);
    expect(formatConversionWarnings("roads.dxf").join(" ")).toMatch(/no OGR georeferencing information/);
    expect(formatConversionWarnings("roads.dxf").join(" ")).toMatch(/generic database attributes or styling may not be preserved/);
    expect(formatConversionWarnings("roads.dxf").join(" ")).toMatch(/normally ANSI_1252/);
    expect(formatConversionWarnings("roads.dxf", [{
      name: "entities",
      geometryType: "Point",
      crs: null,
      featureCount: 1,
      extent: null,
      fields: [{ name: "EntityHandle", type: "String" }],
    }]).join(" ")).toMatch(/EntityHandle values are CAD entity identifiers.*source handle values do not round-trip/);
    expect(formatConversionWarnings("roads.dxf", [layer]).join(" ")).not.toMatch(/EntityHandle values/);
    expect(formatConversionWarnings("roads.gpkg")).toEqual([]);
  });

  it("warns when a source attribute conflicts with GeoPackage's default geometry column", () => {
    const layer = {
      name: "roads",
      geometryType: "Line String",
      crs: "EPSG:4326",
      featureCount: 1,
      extent: null,
      fields: [
        { name: "geom", type: "String" },
        { name: "geometry", type: "String" },
        { name: "geometry_2", type: "String" },
      ],
    };

    expect(formatConversionWarnings("roads.gpkg", [layer]).join(" "))
      .toContain('geometry column will be named "geometry_3" to preserve that attribute');
    expect(formatConversionWarnings("roads.gpkg", [{ ...layer, fields: [{ name: "description", type: "String" }] }]))
      .toEqual([]);
  });

  it("warns when a source attribute conflicts with GeoPackage's default feature id column", () => {
    const layer = {
      name: "roads",
      geometryType: "Line String",
      crs: "EPSG:4326",
      featureCount: 1,
      extent: null,
      fields: [
        { name: "FID", type: "Integer64" },
        { name: "fid_2", type: "String" },
      ],
    };

    expect(formatConversionWarnings("roads.gpkg", [layer]).join(" "))
      .toContain('feature id column will be named "fid_3" to preserve that attribute');
  });

  it("warns about MapInfo column-name limits and respects explicit field renames", () => {
    const layer = {
      name: "road attributes",
      geometryType: "Point",
      crs: "EPSG:4326",
      featureCount: 1,
      extent: null,
      fields: [
        { name: "隧道覆盖CGI(5G)", type: "String" },
        { name: "1leading", type: "String" },
        { name: "x".repeat(32), type: "String" },
      ],
    };
    const warnings = formatConversionWarnings("roads.tab", [layer]).join(" ");
    expect(warnings).toMatch(/MapInfo column names allow at most 31/);
    expect(warnings).toContain("隧道覆盖CGI(5G)");
    expect(warnings).toContain("1leading");
    expect(warnings).toContain("x".repeat(32));

    const mappedWarnings = formatConversionWarnings("roads.tab", [layer], [
      { source: "隧道覆盖CGI(5G)", target: "tunnel_cgi_5g" },
      { source: "1leading", target: "leading_1" },
      { source: "x".repeat(32), target: "short_name" },
    ]).join(" ");
    expect(mappedWarnings).not.toMatch(/MapInfo column names allow at most 31/);
  });

  it("warns when a string id field is mapped to the KML Placemark identifier", () => {
    const layer = {
      name: "KML source",
      geometryType: "Point",
      crs: "EPSG:4326",
      featureCount: 1,
      extent: null,
      fields: [{ name: "id", type: "String" }],
    };
    expect(formatConversionWarnings("output.kml", [layer]).join(" ")).toMatch(/map it to a different output field/);
    expect(formatConversionWarnings("output.kml", [layer], [{ source: "id", target: "source_id" }]).join(" "))
      .toMatch(/exported as source_id so its value can round-trip/);
  });

  it("warns when KML-reserved attributes may be renamed and accepts explicit safe names", () => {
    const layer = {
      name: "KML source",
      geometryType: "Polygon",
      crs: "EPSG:4326",
      featureCount: 1,
      extent: null,
      fields: [
        { name: "extrude", type: "Integer" },
        { name: "tessellate", type: "Integer" },
        { name: "visibility", type: "Integer" },
        { name: "description", type: "String" },
      ],
    };
    expect(formatConversionWarnings("output.kml", [layer]).join(" "))
      .toMatch(/KML reserves extrude, tessellate, visibility.*numeric suffix/);
    const mappings = [
      { source: "extrude", target: "extrude_attribute" },
      { source: "tessellate", target: "tessellate_attribute" },
      { source: "visibility", target: "visibility_attribute" },
    ];
    expect(formatConversionWarnings("output.kml", [layer], mappings).join(" "))
      .not.toMatch(/KML reserves/);
  });

  it("reports Z and M dimension loss for formats that cannot preserve them", () => {
    const measuredLayer = {
      name: "measured roads",
      geometryType: "LineStringZM",
      crs: "EPSG:4326",
      featureCount: 1,
      extent: null,
      fields: [],
    };
    const geoJsonWarnings = formatConversionWarnings("roads.geojson", [measuredLayer]);
    expect(geoJsonWarnings).toContain(
      "GeoJSON output does not preserve M (measure) ordinates; those values will be dropped from layers: measured roads.",
    );
    expect(geoJsonWarnings.join(" ")).not.toMatch(/drop Z/i);
    expect(formatConversionWarnings("roads.kml", [measuredLayer])).toContain(
      "KML output does not preserve M (measure) ordinates; those values will be dropped from layers: measured roads.",
    );
    const tabWarnings = formatConversionWarnings("roads.tab", [measuredLayer]).join(" ");
    expect(tabWarnings).toMatch(/drop Z \(elevation\) ordinates/);
    expect(tabWarnings).toMatch(/does not preserve M \(measure\) ordinates/);
    expect(formatConversionWarnings("roads.shp", [measuredLayer]).join(" ")).not.toMatch(/drop [ZM]/i);
    expect(formatConversionWarnings("roads.gpkg", [measuredLayer])).toEqual([]);
    const genericLayer = { ...measuredLayer, geometryType: "Geometry" };
    expect(formatConversionWarnings("roads.geojson", [genericLayer]).join(" ")).toMatch(/generic geometry layers may contain M values/);
    expect(formatConversionWarnings("roads.tab", [genericLayer]).join(" ")).toMatch(/generic geometry layers may contain Z\/M ordinates/);
  });

  it("rejects projected output CRS for RFC 7946 GeoJSON before invoking GDAL", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "dbstudio-gis-rfc7946-"));
    temporaryDirectories.push(directory);
    const input = path.join(directory, "input.geojson");
    const output = path.join(directory, "output.geojson");
    await writeFile(input, "{}");

    await expect(new GdalService().convert(input, output, { targetCrs: "EPSG:3857" }))
      .rejects.toThrow("RFC 7946 GeoJSON output uses WGS 84");
  });
});

describe("normalizeBaseGeometryType", () => {
  it("strips leading 3D prefix", () => {
    expect(normalizeBaseGeometryType("3D Point")).toBe("Point");
    expect(normalizeBaseGeometryType("3D Polygon")).toBe("Polygon");
    expect(normalizeBaseGeometryType("3D Multi Polygon")).toBe("MultiPolygon");
  });

  it("strips trailing Z/M/ZM markers", () => {
    expect(normalizeBaseGeometryType("Point Z")).toBe("Point");
    expect(normalizeBaseGeometryType("LineString M")).toBe("LineString");
    expect(normalizeBaseGeometryType("Polygon ZM")).toBe("Polygon");
    expect(normalizeBaseGeometryType("Point 25D")).toBe("Point");
  });

  it("strips Measured prefix", () => {
    expect(normalizeBaseGeometryType("Measured Line String")).toBe("LineString");
    expect(normalizeBaseGeometryType("Measured Polygon")).toBe("Polygon");
  });

  it("normalises multi-word OGR type names", () => {
    expect(normalizeBaseGeometryType("Line String")).toBe("LineString");
    expect(normalizeBaseGeometryType("Multi Polygon")).toBe("MultiPolygon");
    expect(normalizeBaseGeometryType("Geometry Collection")).toBe("GeometryCollection");
  });

  it("handles curve and surface types", () => {
    expect(normalizeBaseGeometryType("CircularString Z")).toBe("CircularString");
    expect(normalizeBaseGeometryType("CurvePolygon ZM")).toBe("CurvePolygon");
    expect(normalizeBaseGeometryType("TIN")).toBe("TIN");
    expect(normalizeBaseGeometryType("PolyhedralSurface")).toBe("PolyhedralSurface");
  });

  it("returns null for null input", () => {
    expect(normalizeBaseGeometryType(null)).toBeNull();
    expect(normalizeBaseGeometryType("")).toBeNull();
  });

  it("preserves plain types unchanged", () => {
    expect(normalizeBaseGeometryType("Point")).toBe("Point");
    expect(normalizeBaseGeometryType("Polygon")).toBe("Polygon");
    expect(normalizeBaseGeometryType("MultiLineString")).toBe("MultiLineString");
  });
});
