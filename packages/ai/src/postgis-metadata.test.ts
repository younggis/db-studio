import { describe, expect, it, vi } from "vitest";
import { applyPostgisSpatialMetadata, loadPostgisSchemaMetadata } from "./postgis-metadata.js";
import {
  emptySchemaIndex,
  findStaleSchemaIndexTableKeys,
  replaceSchemaIndexTables,
  schemaIndexScope,
  schemaMetadataFingerprint,
  schemaTableKey,
} from "./schema-index.js";

describe("PostGIS schema metadata", () => {
  it("applies spatial metadata consistently for index and generation fingerprints", () => {
    const tables = [{
      schema: "public", name: "roads", type: "table" as const,
      columns: [
        { name: "id", dataType: "integer", nullable: false, primaryKey: true },
        { name: "geom", dataType: "USER-DEFINED", nullable: true, primaryKey: false },
      ],
    }];
    const spatialColumns = [{
      schema: "public", table: "roads", column: "geom", kind: "geometry" as const,
      geometryType: "MULTILINESTRING", srid: 26910, coordinateDimension: 2,
    }];
    const indexedTables = applyPostgisSpatialMetadata(tables, spatialColumns);
    const generationTables = applyPostgisSpatialMetadata(tables, spatialColumns);

    expect(indexedTables).toEqual(generationTables);
    expect(schemaMetadataFingerprint(indexedTables[0]!)).toBe(schemaMetadataFingerprint(generationTables[0]!));
    expect(schemaMetadataFingerprint(indexedTables[0]!)).not.toBe(schemaMetadataFingerprint(tables[0]!));
    const scope = schemaIndexScope("test-connection", "dbstudio_test", "public");
    const snapshot = replaceSchemaIndexTables(emptySchemaIndex(), scope, indexedTables, [[1, 0, 0]], "test-model");
    expect(findStaleSchemaIndexTableKeys(snapshot, scope, generationTables, "test-model")).toEqual([]);
    const changedTables = generationTables.map((table) => ({
      ...table,
      columns: table.columns.map((column) => column.name === "geom"
        ? { ...column, spatial: { ...column.spatial!, srid: 4326 } }
        : column),
    }));
    expect(findStaleSchemaIndexTableKeys(snapshot, scope, changedTables, "test-model"))
      .toEqual([schemaTableKey("public", "roads")]);
    expect(indexedTables[0]!.columns[1]).toMatchObject({
      dataType: "geometry",
      spatial: { kind: "geometry", geometryType: "MULTILINESTRING", srid: 26910, coordinateDimension: 2 },
    });
    expect(tables[0]!.columns[1]).toEqual({ name: "geom", dataType: "USER-DEFINED", nullable: true, primaryKey: false });
  });

  it("loads scoped spatial columns and only functions reported by the server", async () => {
    const responses = [
      { rows: [{ version: "3.6.4" }] },
      { rows: [{
        kind: "geometry", schema: "public", table_name: "roads", column_name: "geom",
        geometry_type: "MULTILINESTRING", srid: 26910, coordinate_dimension: 2,
        proj4text: "+proj=utm +zone=10 +datum=NAD83 +units=m +no_defs",
      }] },
      { rows: [
        { name: "st_dwithin(geometry,geometry,double precision)", supported: true },
        { name: "st_makepoint(double precision,double precision)", supported: true },
        { name: "st_setsrid(geometry,integer)", supported: true },
        { name: "st_asmvtgeom(geometry,box2d,integer,integer,boolean)", supported: true },
        { name: "st_tileenvelope(integer,integer,integer,geometry,double precision)", supported: true },
        { name: "st_makeenvelope(double precision,double precision,double precision,double precision,integer)", supported: false },
      ] },
    ];
    const query = vi.fn(async (_sql: string, _parameters?: unknown[]) => responses.shift()!);
    const result = await loadPostgisSchemaMetadata(query, "public", [
      { schema: "public", name: "roads", type: "table", columns: [] },
    ]);

    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls[1]?.[1]).toEqual(["public", ["roads"]]);
    expect(result.metadata).toEqual({
      version: "3.6.4",
      spatialColumns: [{
        schema: "public", table: "roads", column: "geom", kind: "geometry",
        geometryType: "MULTILINESTRING", srid: 26910, coordinateDimension: 2,
        coordinateUnits: { kind: "linear", name: "metre", metersPerUnit: 1 },
      }],
      supportedFunctions: ["ST_DWITHIN", "ST_MAKEPOINT", "ST_SETSRID", "ST_ASMVTGEOM", "ST_TILEENVELOPE"],
    });
    expect(query.mock.calls[2]?.[0]).toContain("st_asmvtgeom(geometry,box2d,integer,integer,boolean)");
    expect(query.mock.calls[2]?.[0]).toContain("st_tileenvelope(integer,integer,integer,geometry,double precision)");
    expect(query.mock.calls[2]?.[0]).toContain("st_makeenvelope(double precision,double precision,double precision,double precision,integer)");
    expect(result.warnings).toEqual([]);
  });

  it("classifies angular, projected-foot and unknown coordinate units conservatively", async () => {
    const responses = [
      { rows: [{ version: "3.6.4" }] },
      { rows: [
        {
          kind: "geometry", schema: "public", table_name: "wgs84", column_name: "geom",
          geometry_type: "POINT", srid: 4326, coordinate_dimension: 2,
          proj4text: "+proj=longlat +datum=WGS84 +no_defs +type=crs",
        },
        {
          kind: "geometry", schema: "public", table_name: "state_plane", column_name: "geom",
          geometry_type: "POINT", srid: 2263, coordinate_dimension: 2,
          proj4text: "+proj=lcc +lat_1=40.6666666667 +units=us-ft +no_defs",
        },
        {
          kind: "geometry", schema: "public", table_name: "custom_crs", column_name: "geom",
          geometry_type: "POINT", srid: 990001, coordinate_dimension: 2,
          proj4text: "+proj=unknown +no_defs",
        },
      ] },
      { rows: [] },
    ];
    const query = vi.fn(async (_sql: string, _parameters?: unknown[]) => responses.shift()!);
    const result = await loadPostgisSchemaMetadata(query, "public", [
      { schema: "public", name: "wgs84", type: "table", columns: [] },
      { schema: "public", name: "state_plane", type: "table", columns: [] },
      { schema: "public", name: "custom_crs", type: "table", columns: [] },
    ]);

    expect(result.metadata.spatialColumns.map((column) => column.coordinateUnits)).toEqual([
      { kind: "angular", name: "degree" },
      { kind: "linear", name: "US survey foot", metersPerUnit: 1_200 / 3_937 },
      { kind: "unknown", name: "unknown" },
    ]);
  });

  it("does not query spatial catalogs when PostGIS is not installed", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const result = await loadPostgisSchemaMetadata(query, "public", []);

    expect(query).toHaveBeenCalledTimes(1);
    expect(result.metadata.spatialColumns).toEqual([]);
    expect(result.warnings).toContain("当前数据库没有已安装的 PostGIS 扩展；无法确认空间字段或函数能力。");
  });

  it("returns a safe warning when metadata queries fail", async () => {
    const query = vi.fn(async () => { throw new Error("database detail must not escape"); });
    const result = await loadPostgisSchemaMetadata(query, "public", []);

    expect(result.metadata.spatialColumns).toEqual([]);
    expect(result.warnings).toEqual(["无法读取 PostGIS 版本、空间字段或函数元数据；助手不得猜测这些信息。"]);
  });
});
