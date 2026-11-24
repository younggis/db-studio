import type { PostgisSchemaMetadata, SchemaTable } from "./types.js";

export type PostgisMetadataQuery = (
  sql: string,
  parameters?: unknown[],
) => Promise<{ rows: Array<Record<string, unknown>> }>;

export function applyPostgisSpatialMetadata(
  tables: SchemaTable[],
  spatialColumns: PostgisSchemaMetadata["spatialColumns"],
): SchemaTable[] {
  const columnsByKey = new Map(spatialColumns.map((column) => [
    [column.schema, column.table, column.column].join("\0"), column,
  ]));
  return tables.map((table) => {
    let changed = false;
    const columns = table.columns.map((column) => {
      const detail = columnsByKey.get([table.schema, table.name, column.name].join("\0"));
      if (!detail) return column;
      changed = true;
      return {
        ...column,
        dataType: detail.kind,
        spatial: {
          kind: detail.kind,
          geometryType: detail.geometryType,
          srid: detail.srid,
          coordinateDimension: detail.coordinateDimension,
        },
      };
    });
    return changed ? { ...table, columns } : table;
  });
}

function coordinateUnitsFromProj4(value: unknown): NonNullable<PostgisSchemaMetadata["spatialColumns"][number]["coordinateUnits"]> {
  if (typeof value !== "string" || !value.trim()) return { kind: "unknown", name: "unknown" };
  const proj4 = value.trim();
  const projection = /(?:^|\s)\+proj=([^\s]+)/i.exec(proj4)?.[1]?.toLowerCase();
  if (projection && ["longlat", "latlong", "lonlat"].includes(projection)) {
    return { kind: "angular", name: "degree" };
  }

  const unit = /(?:^|\s)\+units=([^\s]+)/i.exec(proj4)?.[1]?.toLowerCase();
  const units: Record<string, { name: string; metersPerUnit: number }> = {
    m: { name: "metre", metersPerUnit: 1 },
    meter: { name: "metre", metersPerUnit: 1 },
    metre: { name: "metre", metersPerUnit: 1 },
    km: { name: "kilometre", metersPerUnit: 1_000 },
    ft: { name: "foot", metersPerUnit: 0.3048 },
    "us-ft": { name: "US survey foot", metersPerUnit: 1_200 / 3_937 },
  };
  if (unit && units[unit]) return { kind: "linear", ...units[unit]! };

  const toMeter = /(?:^|\s)\+to_meter=([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)/i.exec(proj4)?.[1];
  const metersPerUnit = toMeter === undefined ? Number.NaN : Number(toMeter);
  if (Number.isFinite(metersPerUnit) && metersPerUnit > 0) {
    return { kind: "linear", name: "custom linear unit", metersPerUnit };
  }
  return { kind: "unknown", name: "unknown" };
}

export async function loadPostgisSchemaMetadata(
  query: PostgisMetadataQuery,
  schema: string,
  tables: SchemaTable[],
): Promise<{ metadata: PostgisSchemaMetadata; warnings: string[] }> {
  const warnings: string[] = [];
  try {
    const versionResult = await query("SELECT extversion AS version FROM pg_catalog.pg_extension WHERE extname = 'postgis'");
    const version = typeof versionResult.rows[0]?.version === "string" ? versionResult.rows[0].version : undefined;
    if (!version) {
      return {
        metadata: { spatialColumns: [] },
        warnings: ["当前数据库没有已安装的 PostGIS 扩展；无法确认空间字段或函数能力。"],
      };
    }

    const tableNames = tables.map((table) => table.name);
    const spatialResult = await query(
      `SELECT spatial.kind, spatial.schema, spatial.table_name, spatial.column_name,
              spatial.geometry_type, spatial.srid, spatial.coordinate_dimension,
              srs.proj4text
         FROM (
           SELECT 'geometry' AS kind, f_table_schema AS schema, f_table_name AS table_name,
                  f_geometry_column AS column_name, type AS geometry_type, srid,
                  coord_dimension AS coordinate_dimension
             FROM geometry_columns
            WHERE f_table_schema = $1 AND f_table_name = ANY($2::text[])
           UNION ALL
           SELECT 'geography' AS kind, f_table_schema AS schema, f_table_name AS table_name,
                  f_geography_column AS column_name, type AS geometry_type, srid,
                  coord_dimension AS coordinate_dimension
             FROM geography_columns
            WHERE f_table_schema = $1 AND f_table_name = ANY($2::text[])
         ) AS spatial
         LEFT JOIN spatial_ref_sys AS srs ON srs.srid = spatial.srid`,
      [schema, tableNames],
    );
    const functionResult = await query(
      `SELECT name,
              to_regprocedure(name) IS NOT NULL
                OR (fallback_signature IS NOT NULL AND to_regprocedure(fallback_signature) IS NOT NULL) AS supported
         FROM (VALUES ('st_intersects(geometry,geometry)', NULL::text),
                      ('st_intersects(geography,geography)', NULL::text),
                      ('st_contains(geometry,geometry)', NULL::text),
                      ('st_within(geometry,geometry)', NULL::text),
                      ('st_dwithin(geometry,geometry,double precision)', NULL::text),
                      ('st_dwithin(geography,geography,double precision,boolean)', NULL::text),
                      ('st_distance(geometry,geometry)', NULL::text),
                      ('st_distance(geography,geography,boolean)', NULL::text),
                      ('st_buffer(geometry,double precision)', NULL::text),
                      ('st_buffer(geography,double precision)', NULL::text),
                      ('st_makepoint(double precision,double precision)', NULL::text),
                      ('st_setsrid(geometry,integer)', NULL::text),
                      ('st_geomfromtext(text,integer)', NULL::text),
                      ('st_geogfromtext(text)', NULL::text),
                      ('st_transform(geometry,integer)', NULL::text),
                      ('st_area(geometry)', NULL::text), ('st_area(geography)', NULL::text),
                      ('st_length(geometry)', NULL::text), ('st_length(geography)', NULL::text),
                      ('st_asgeojson(geometry)', 'st_asgeojson(geometry,integer,integer)'),
                      ('st_asmvt(anyelement,text,integer,text)', 'st_asmvt(anyelement,text,integer,text,text)'),
                      ('st_asmvt(anyelement,text,integer,text,text)', NULL::text),
                      ('st_asmvtgeom(geometry,box2d,integer,integer,boolean)', NULL::text),
                      ('st_tileenvelope(integer,integer,integer,geometry,double precision)', 'st_tileenvelope(integer,integer,integer,geometry)'),
                      ('st_makeenvelope(double precision,double precision,double precision,double precision,integer)', NULL::text))
              AS requested(name, fallback_signature)`,
    );
    const supportedFunctions = [...new Set(functionResult.rows
      .filter((row) => row.supported === true)
      .map((row) => String(row.name).split("(")[0]!.toUpperCase()))];
    const spatialColumns = spatialResult.rows.flatMap((row) => {
      const kind: "geography" | "geometry" | undefined = row.kind === "geography" ? "geography" : row.kind === "geometry" ? "geometry" : undefined;
      const srid = Number(row.srid);
      if (!kind || !Number.isFinite(srid)) return [];
      return [{
        schema: String(row.schema),
        table: String(row.table_name),
        column: String(row.column_name),
        kind,
        geometryType: String(row.geometry_type),
        srid,
        coordinateDimension: Number.isFinite(Number(row.coordinate_dimension))
          ? Number(row.coordinate_dimension)
          : undefined,
        coordinateUnits: coordinateUnitsFromProj4(row.proj4text),
      }];
    });
    if (!spatialColumns.length) warnings.push("所选表中未发现 PostGIS geometry/geography 字段；不会猜测空间列名。");
    return { metadata: { version, spatialColumns, supportedFunctions }, warnings };
  } catch {
    return {
      metadata: { spatialColumns: [] },
      warnings: ["无法读取 PostGIS 版本、空间字段或函数元数据；助手不得猜测这些信息。"],
    };
  }
}
