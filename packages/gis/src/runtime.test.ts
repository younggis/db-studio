import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveGdalRuntimeEnvironment } from "./runtime.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("GDAL runtime environment discovery", () => {
  it("finds sibling GDAL and PROJ data from DBSTUDIO_GDAL_BIN", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "dbstudio-gdal-runtime-"));
    temporaryDirectories.push(root);
    const bin = path.join(root, "bin");
    const gdalData = path.join(root, "data");
    const projData = path.join(root, "proj");
    await Promise.all([mkdir(bin), mkdir(gdalData), mkdir(projData)]);
    await Promise.all([
      writeFile(path.join(bin, process.platform === "win32" ? "ogr2ogr.exe" : "ogr2ogr"), ""),
      writeFile(path.join(gdalData, "gdalvrt.xsd"), ""),
      writeFile(path.join(projData, "proj.db"), ""),
    ]);

    const original = { DBSTUDIO_GDAL_BIN: bin, PATH: "" };
    const environment = resolveGdalRuntimeEnvironment(original);

    expect(environment).toMatchObject({
      GDAL_DATA: gdalData,
      PROJ_DATA: projData,
      PROJ_LIB: projData,
    });
    expect(original).toEqual({ DBSTUDIO_GDAL_BIN: bin, PATH: "" });
  });

  it("discovers the runtime when its binary directory is on PATH", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "dbstudio-gdal-path-"));
    temporaryDirectories.push(root);
    const bin = path.join(root, "bin");
    const projData = path.join(root, "share", "proj");
    await Promise.all([mkdir(bin), mkdir(projData, { recursive: true })]);
    await Promise.all([
      writeFile(path.join(bin, process.platform === "win32" ? "ogr2ogr.exe" : "ogr2ogr"), ""),
      writeFile(path.join(projData, "proj.db"), ""),
    ]);

    const environment = resolveGdalRuntimeEnvironment({ PATH: [bin, "other"].join(path.delimiter) });

    expect(environment).toMatchObject({ PROJ_DATA: projData, PROJ_LIB: projData });
  });

  it("preserves explicitly configured GDAL and PROJ data paths", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "dbstudio-gdal-explicit-"));
    temporaryDirectories.push(root);
    const bin = path.join(root, "bin");
    await mkdir(bin);
    await writeFile(path.join(bin, process.platform === "win32" ? "ogr2ogr.exe" : "ogr2ogr"), "");
    const configured = {
      DBSTUDIO_GDAL_BIN: bin,
      GDAL_DATA: "custom-gdal-data",
      PROJ_DATA: "custom-proj-data",
      PROJ_LIB: "custom-proj-lib",
    };

    expect(resolveGdalRuntimeEnvironment(configured)).toMatchObject(configured);
  });
});
