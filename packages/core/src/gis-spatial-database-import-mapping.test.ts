import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { DatabaseAdapter, ImportTableColumn } from "@db-studio/database";
import { CoreService } from "./index.js";

const gdalBin = fileURLToPath(new URL("../../../apps/desktop/resources/gdal/bin", import.meta.url));
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createSource(): Promise<{ directory: string; path: string }> {
  const directory = await mkdtemp(join(tmpdir(), "db-studio-gis-field-mapping-"));
  directories.push(directory);
  const path = join(directory, "source.geojson");
  await writeFile(path, JSON.stringify({
    type: "FeatureCollection",
    name: "source",
    features: [
      { type: "Feature", properties: { source_id: 17, source_name: "成都", source_speed: 42.5, source_time: "09:30:15" }, geometry: { type: "Point", coordinates: [104.0665, 30.5723] } },
      { type: "Feature", properties: { source_id: 18, source_name: "青城山", source_speed: 31.25, source_time: "12:45:30" }, geometry: { type: "Point", coordinates: [103.567, 30.9] } },
    ],
  }), "utf8");
  return { directory, path };
}

function createRecordingAdapter() {
  const created: Array<{ table: string; columns: ImportTableColumn[]; schema?: string }> = [];
  const inserted: Array<{ table: string; columns: string[]; rows: unknown[][]; schema?: string }> = [];
  const adapter = {
    listTables: async () => [],
    createTable: async (table: string, columns: ImportTableColumn[], schema?: string) => {
      created.push({ table, columns, schema });
    },
    query: async () => ({ columns: [], rows: [], rowCount: 0, command: "ALTER" }),
    insertRows: async (table: string, columns: string[], rows: unknown[][], schema?: string) => {
      inserted.push({ table, columns, rows, schema });
      return rows.length;
    },
    close: async () => undefined,
  } as unknown as DatabaseAdapter;
  return { adapter, created, inserted };
}

const mappings = [
  { source: "source_id", target: "feature_number", targetType: "integer64" as const },
  { source: "source_name", target: "display_name", targetType: "string" as const },
  { source: "source_speed", target: "speed_value", targetType: "real" as const },
  { source: "source_time", target: "service_time", targetType: "time" as const },
];

describe.each(["mysql", "mariadb", "sqlserver", "oracle"] as const)("GIS database field mapping for %s", (engine) => {
  it("renames fields, applies mapped types, and inserts the converted values", async () => {
    const { path } = await createSource();
    const recorded = createRecordingAdapter();
    const core = new CoreService(
      () => recorded.adapter,
      { DBSTUDIO_GDAL_BIN: gdalBin },
      false,
      engine,
    );

    const report = engine === "mysql" || engine === "mariadb"
      ? await core.importGisToMysqlFamily(path, "mapped_features", "gis_test", { fieldMappings: mappings })
      : engine === "sqlserver"
        ? await core.importGisToSqlServer(path, "mapped_features", "gis_test", { fieldMappings: mappings })
        : await core.importGisToOracle(path, "mapped_features", "gis_test", { fieldMappings: mappings });

    expect(report).toMatchObject({ engine, status: "completed", successfulFeatures: 2 });
    const createdColumns = recorded.created[0]?.columns ?? [];
    expect(createdColumns).toContainEqual({ name: "feature_number", type: "integer" });
    expect(createdColumns).toContainEqual({ name: "display_name", type: "text" });
    expect(createdColumns).toContainEqual({ name: "speed_value", type: "real" });
    expect(createdColumns).toContainEqual({ name: "service_time", type: "time" });

    const batch = recorded.inserted[0];
    expect(batch).toBeDefined();
    expect(batch!.columns).toContain("feature_number");
    expect(batch!.columns).toContain("display_name");
    expect(batch!.columns).toContain("speed_value");
    const first = Object.fromEntries(batch!.columns.map((column, index) => [column, batch!.rows[0]?.[index]]));
    expect(first).toMatchObject({ feature_number: 17, display_name: "成都", speed_value: 42.5, service_time: "09:30:15" });
  });
});
