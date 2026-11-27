# GIS format matrix

The current GIS service maps extensions to OGR drivers. File validation is performed against the selected runtime, not inferred from the mapping.

| Format | Extension | Metadata / conversion wiring | Real PostGIS round trip |
|---|---|---|---|
| Shapefile | `.shp` | Implemented through OGR; UTF-8 default with selectable output encoding; `.cpg`/DBF LDID inspection; DBF field-name/type/width constraints reported | Passed |
| GeoJSON | `.geojson`, `.json` | Implemented through OGR with RFC 7946 enabled; output uses WGS 84 longitude/latitude and explicitly sets 17-decimal coordinate precision to override GDAL's 7-decimal default; explicit string mappings for JSON-subtype fields use a source `OGR_SCHEMA` override and PostgreSQL `VARCHAR` target; when OGR reports a source FID column that is also a real attribute (commonly `properties.id`), import unsets FID transfer so PostgreSQL generates its own feature key while retaining the attribute | Passed, including duplicate `properties.id` values on append |
| KML | `.kml` | Implemented through OGR; conversion report states KML output is written in EPSG:4326; warns when source fields collide with KML Placemark properties `extrude`, `tessellate` or `visibility`, since GDAL may suffix their names | Passed; driver adds metadata fields and reads geometry as generic `Geometry` |
| MapInfo TAB | `.tab` | Implemented through OGR; UTF-8 default with selectable output encoding; `Charset` inspection and safe temporary override; input field names with unsupported ASCII punctuation are normalized in an isolated byte-preserving copy with a warning; strict field-name laundering disabled; export warns for names outside MapInfo's 31-character letters/digits/underscore rule and recognizes explicit field mappings; project-generated TAB exports widen narrower/unknown String columns to `character(254)` to avoid truncation; export warns that MapInfo does not represent SQL NULL values | Passed; database → TAB → PostGIS retained a mapped schema, Unicode and quoted text in a two-row sample; a NULL string returned as an empty string, so NULL and empty-string semantics are lossy; CRS may be reported as WKT without an EPSG identifier |
| GeoPackage | `.gpkg` | Implemented through OGR; multi-layer imports require an explicit source-layer choice in CLI or desktop; source attributes named `geom` or `fid` are preserved by choosing unique geometry/feature-id column names | Passed |
| Spatial CSV (additional format) | `.csv` | OGR CSV output writes geometry in a WKT column and creates `.prj`/`.csvt` sidecars for CRS and field types; export refuses to overwrite any of these companions; UTF-8 output only | Passed; two features including NULL geometry round-tripped through PostGIS with EPSG:4326 output, CRS/type sidecars, WKT geometry and Chinese attributes; a source attribute named `WKT` was preserved while the geometry column was disambiguated as `geom_WKT` |
| DXF (additional local-corpus format, outside P0) | `.dxf` | GDAL DXF reader/writer enabled; export emits CAD drawing entities and warns that OGR CRS metadata, arbitrary database attributes/styles, and non-ANSI_1252 text may not be preserved | Geometry and feature count passed for one 413-feature local file; 20/20 geometry samples matched. Strict text comparison found one changed CAD text column; attribute round-trip is not claimed |

## 坐标维度与曲线类型支持

`GisLayerInfo` 现在暴露三个新字段，供 UI 和 CLI 显示以及测试断言：

| 字段 | 类型 | 说明 |
|------|------|------|
| `hasZ` | `boolean \| undefined` | 图层几何是否包含 Z（高程）坐标 |
| `hasM` | `boolean \| undefined` | 图层几何是否包含 M（测量值）坐标 |
| `coordinateDimension` | `2 \| 3 \| 4` | 坐标维度：2=XY、3=XYZ 或 XYM、4=XYZM |
| `baseGeometryType` | `string \| null` | 去除维度标记后的基础类型，如 `"LineString"`（来自 `"3D Line String Z"`） |

这些字段由 `normalizeBaseGeometryType()` 函数填充，该函数处理 OGR 返回的所有已知维度编码方式：

- **位前缀**：`3D Point`、`Measured Polygon`
- **后缀标记**：`Point Z`、`LineString M`、`Polygon ZM`
- **25D 编码**：`Point 25D`（等同于 Z）
- **多词类型名**：`Line String` → `LineString`，`Multi Polygon` → `MultiPolygon`

### 各格式对维度的保留情况

| 格式 | Z 坐标 | M 坐标 | ZM | 说明 |
|------|--------|--------|-----|------|
| Shapefile | ✅ | ✅ | ✅ | `.shz`/`.shm` 变体；操作报告含警告 |
| GeoPackage | ✅ | ✅ | ✅ | 完整 Z/M 支持 |
| PostGIS | ✅ | ✅ | ✅ | 通过 `GEOMETRY(PointZM, 4326)` 等类型 |
| GeoJSON | ✅ | ❌ | Z only | RFC 7946 不支持 M；转换报告有警告 |
| MapInfo TAB | ❌ | ❌ | ❌ | 两者均丢失；转换报告有警告 |
| KML | ⚠️ 高程 | ❌ | Z only | Z 映射到 KML 高程字段 |

### 曲线几何类型支持

OGR 支持 ISO SQL/MM 曲线类型（CircularString、CompoundCurve、CurvePolygon、MultiCurve、MultiSurface），以及多面体类型（TIN、PolyhedralSurface）。`normalizeBaseGeometryType()` 可正确识别这些类型，`baseGeometryType` 字段将返回规范化名称。

| 曲线类型 | GeoPackage | PostGIS | 其他格式 |
|----------|------------|---------|---------|
| CircularString | ✅ 保留 | ✅ 保留 | ❌ 线性化为 LineString |
| CompoundCurve | ✅ 保留 | ✅ 保留 | ❌ 线性化 |
| CurvePolygon | ✅ 保留 | ✅ 保留 | ❌ 线性化 |
| TIN | ✅ 保留 | ✅ 保留 | ❌ 拆分为三角面 |
| PolyhedralSurface | ✅ 保留 | ✅ 保留 | ❌ |

**注意**：Shapefile、GeoJSON、KML 和 MapInfo TAB 不支持曲线类型；OGR 在导出时自动线性化，但 DB Studio 在操作报告的 warnings 中标注该行为。

Dimension probe (`pnpm run test:integration:gis-dimensions`, GDAL 3.12.2): a PointZM feature keeps Z/M in Shapefile and GeoPackage; GeoJSON/KML keep Z but drop M; MapInfo TAB drops both and is reported as 2D. These losses appear in `operationReport.warnings`. Generic `Geometry`/`GeometryCollection` sources trigger a conservative warning where the target cannot preserve the unknown dimensions.

Evidence: `node tests/integration/postgis-gis-roundtrip.mjs` against the project PostGIS service. Each format retained two features (including one null geometry) and Chinese values 甲/乙 when imported to EPSG:3857 and exported to EPSG:4326. The test also checks transformed coordinates and output extent.

Multi-layer and field-mapping evidence: `pnpm run test:integration:postgis-multilayer` creates a two-layer GeoPackage, verifies that an unspecified or nonexistent layer is rejected, imports only the selected feature, renames a Chinese attribute and casts an integer to Integer64 on import, then applies an attribute alias and Integer64 cast on PostGIS export.

Mixed JSON scalar evidence: on GDAL 3.12.2, `F:\temp\dim_gis_org_boundary.geojson` contains five `String(JSON)` fields with heterogeneous JSON scalar values. Explicitly mapping all five to strings applies a source GeoJSON `OGR_SCHEMA` patch, then creates PostgreSQL `VARCHAR` columns. The isolated PostGIS round trip passed 14,524 features, 20/20 geometry samples, and 240/240 sampled text values; `.cache/local-gis-org-boundary-json-string-source-schema-verified-20261113.json` records the earlier run. A 2026-11-14 paired rerun confirms the failure and remedy: with no field overrides, PostGIS rejected import with `invalid input syntax for type json`; with all five fields mapped, the round trip passed 14,524 features, 20/20 geometry samples, and 240/240 sampled text values. Both temporary tables and export directories were cleaned, and both audit reports set `externalDataSent=false` (`.cache/local-gis-json-subtype-postgis-unmapped-20261114.json` and `.cache/local-gis-json-subtype-postgis-mapped-20261114.json`). GIS import errors now identify remaining unmapped JSON-subtype fields and show the explicit CLI/UI string-mapping remedy. This is guidance only: it does not change types automatically, and numeric/other scalar values become text when the user chooses that mapping. `.cache/local-gis-json-subtype-mix-20261114.json` contains value-type counts only, without source attribute values.

Local vector-file conversion evidence (GDAL 3.12.2): six datasets across Shapefile, GeoJSON, GeoPackage, KML, and MapInfo TAB completed CLI conversion out-and-back through an intermediate format: 27,233 features total, with all per-dataset feature counts retained. Full feature-property values and geometries matched after normalizing polygon ring start/direction and component order (XY tolerance `1e-8`). Shapefile DBF renamed six long/non-representable source field names and emitted one extra all-null field; values still matched by source/output field position. KML added its Placemark identifier and renamed source `extrude`, `tessellate`, and `visibility` columns with `2` suffixes; values matched under those aliases. GIS output now warns about these KML name collisions unless explicit safe aliases are supplied. Report `.cache/local-gis-realdata-roundtrip-20261114.json` stores counts and schema changes only, with `externalDataSent=false`.

GeoPackage geometry-column collision regression (GDAL 3.12.2): a GeoJSON dataset with a source string attribute named `geom` now converts through GeoPackage and back with all 2,920 features, all 12 source attributes and all geometries matched. The GeoPackage geometry column is named `geometry`; the source `geom` values remain ordinary attributes. The operation report warns about the selected geometry-column name. Sanitized evidence is in `.cache/local-gis-realdata-roundtrip-geometry-column-collision-20261114.json` (`externalDataSent=false`).

GeoPackage feature-id collision regression (GDAL 3.12.2): a 1,639-feature GeoJSON layer with a source attribute named `fid` converts through GeoPackage and back with all 3 source attributes and geometries matched. GDAL now assigns a free GeoPackage feature-id column when needed; its operation report identifies the rename. Sanitized evidence is in `.cache/local-gis-realdata-roundtrip-fid-collision-20261114.json` (`externalDataSent=false`). A second 10-dataset local conversion batch completed 19,502 features; after fixing the detected `fid` collision, all 10 datasets matched feature counts, attribute values and geometries. `.cache/local-gis-realdata-roundtrip-batch-20261114-03.json` contains only IDs, formats, counts and schema-change counts, with `externalDataSent=false`.

PostGIS export regression: the live PostGIS integration suite creates a temporary table containing ordinary `fid` and `geom` text attributes plus a separate point geometry, exports it to GeoPackage, verifies both attributes and the geometry-column rename warning, then reads both source attribute values back from the GeoPackage. The 2-feature check passed, and the integration script removes the table and output directory. `.cache/postgis-gpkg-reserved-columns-20261114.json` records only the sanitized result (`externalDataSent=false`).

Third local conversion batch (GDAL 3.12.2): 10 datasets / 8,019 features retained counts and geometries in all cases. After aligning Shapefile comparison exports with detected source encodings and widening MapInfo String columns, strict full-row attribute and geometry equality passed for all 10 datasets. The fix builds a SQLite-dialect field projection for TAB output and casts narrower or unknown String fields to `character(254)` while carrying geometry through; the MapInfo driver has no exposed creation option to widen these fields directly. A live PostGIS integration case also exports longer-than-declared `VARCHAR` values to TAB and reads them back without truncation. `.cache/local-gis-realdata-roundtrip-batch-20261114-04.json` and `.cache/postgis-mapinfo-string-width-20261114.json` contain sanitized counts/results only and set `externalDataSent=false`.

Fourth local conversion batch (GDAL 3.12.2): 10 datasets / 4,925 features completed with counts, every source field value and geometries matched. `.cache/local-gis-realdata-roundtrip-batch-20261114-05.json` contains only IDs, formats, counts and schema-change counts, with `externalDataSent=false`.

Geometry evidence: the same live test imports Point, MultiPoint, LineString, MultiLineString, Polygon, MultiPolygon, GeometryCollection, one null geometry and a self-intersecting invalid polygon into PostGIS; it checks each geometry type, null count and validity, then exports all nine features to GeoPackage and GeoJSON.

NULL/Empty validation evidence (GDAL 3.12.2): `GdalService.checkGeometry` performs per-geometry-field SQLite-dialect aggregates without materializing feature rows. A three-feature GeoPackage fixture reports 1 NULL and 1 Empty; an empty GeoPackage layer reports 0/0/0. Conversion of that fixture to Shapefile and GeoJSON reports 2 NULL/0 Empty because those drivers represent the Empty input as NULL; MapInfo TAB and KML report 1 NULL/0 Empty. The result is the target driver's stored semantics. `gdal vector check-geometry` requires `--oo` for open options (not `-oo`); a unit test covers a Shapefile UTF-8 override.

The persistent regression in `tests/integration/gis-dimensions-smoke.mjs` generates the GPKG and Shapefile cases, asserts their NULL/Empty counts, and runs through `pnpm run test:integration:gis-dimensions`.

Known format constraints: Shapefile DBF field names are limited to 10 characters and DBF supports a restricted set of types and field widths. MapInfo TAB supports Integer, Real and String output fields; declared widths can truncate strings. Project-generated TAB output widens narrower or unknown String fields to 254 characters to reduce truncation; values longer than the driver limit remain constrained by the format. MapBasic documents column names as at most 31 letters, digits or underscores, and forbids a leading digit; export warnings identify names outside this rule, while a user-provided field mapping can supply a compatible name. KML output is EPSG:4326. A string field named id is treated as the KML Placemark identifier by LIBKML; PostGIS-to-KML export now aliases that attribute to source_id (or a collision-free suffix) unless the user explicitly maps it, and reports the rename. This preserves values while changing the exported column name. See the [GDAL LIBKML driver documentation](https://gdal.org/en/stable/drivers/vector/libkml.html). GeoJSON writes RFC 7946 WGS 84 longitude/latitude. GDAL defaults to 7 coordinate decimal places, so DB Studio explicitly sets COORDINATE_PRECISION=17; file conversion and PostGIS export tests confirm exact finite binary64 XYZ round trips. See the [GDAL GeoJSON driver documentation](https://gdal.org/en/stable/drivers/vector/geojson.html). An explicit projected target CRS is rejected for these standard geographic outputs. MapInfo TAB UTF-8 interoperability requires a sufficiently recent MapInfo client; the test runtime is GDAL 3.12.2. TAB may expose a WKT CRS instead of a compact EPSG code. The warnings describe driver constraints and do not imply that every converted dataset loses information.

Additional DXF corpus support uses GDAL's DXF writer. DXF is a CAD format with no OGR georeferencing information; generic database attributes and styling need separate verification, so the current support does not claim attribute losslessness. See the [GDAL DXF driver documentation](https://gdal.org/en/stable/drivers/vector/dxf.html).

Official driver behavior: [GDAL GeoJSON driver](https://gdal.org/en/stable/drivers/vector/geojson.html), [Shapefile driver](https://gdal.org/en/stable/drivers/vector/shapefile.html), and [MapInfo File driver](https://gdal.org/en/stable/drivers/vector/mitab.html). The field-name constraints are documented in the [Precisely MapBasic Create Table reference](https://help.precisely.com/r/t/1031443568/2023-12-31/MapBasic/pub/Latest/en-US/MapInfo-MapBasic-Reference/Create-Table-statement?contentId=zgGcg2eDmt4QbE_aB~zF3Q).

The vcpkg reduced-runtime candidate is separate from the currently packaged QGIS-derived runtime. The initial reduced build did not include Expat, so KML could be written but could not be read back; do not use that candidate for distribution or replace the current runtime with it. See [runtime build and legal status](gdal-runtime.md) and the [GIS compatibility report](gis-compatibility-test-report.md).
