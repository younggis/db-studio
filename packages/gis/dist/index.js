import { execFile, spawn, spawnSync } from "node:child_process";
import { constants as fsConstants, existsSync, statSync } from "node:fs";
import { copyFile, link, mkdtemp, readdir, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { delimiter } from "node:path";
import { detectGisEncoding, encodingForGisDriver, effectiveSourceEncoding, findInvalidDbfUtf8Field, isVirtualZipPath, normalizeTextEncoding, prepareGisInput, toGdalEncodingName, } from "./encoding.js";
import { resolveGdalRuntimeEnvironment } from "./runtime.js";
const WKT_DIMENSION_GEOMETRY_TYPES = "(?:POINT|LINESTRING|POLYGON|MULTIPOINT|MULTILINESTRING|MULTIPOLYGON|GEOMETRYCOLLECTION|CIRCULARSTRING|COMPOUNDCURVE|CURVEPOLYGON|MULTICURVE|MULTISURFACE|TRIANGLE|TIN|POLYHEDRALSURFACE)";
const WKT_DIMENSION_MARKER = new RegExp(`^\\s*${WKT_DIMENSION_GEOMETRY_TYPES}\\s+(ZM|Z|M)\\b`, "i");
const WKT_DIMENSION_PREFIX_LENGTH = 64;
export function parseGisDriverCreationOptions(entries) {
    if (!Array.isArray(entries) || entries.some((entry) => typeof entry !== "string")) {
        throw new Error("Driver creation options must be strings in NAME=VALUE form.");
    }
    if (entries.length > 64)
        throw new Error("At most 64 driver creation options can be supplied per option group.");
    const seen = new Set();
    let totalLength = 0;
    const parsed = [];
    for (const entry of entries) {
        if (!entry.trim())
            continue;
        const separator = entry.indexOf("=");
        const name = separator < 0 ? "" : entry.slice(0, separator).trim();
        const value = separator < 0 ? "" : entry.slice(separator + 1).trim();
        if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name) || !value) {
            throw new Error("Driver creation options must use NAME=VALUE with a valid option name and non-empty value.");
        }
        if (name.length > 128 || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) {
            throw new Error("Driver creation option values must be at most 4096 characters and contain no control characters.");
        }
        const normalizedName = name.toUpperCase();
        if (seen.has(normalizedName))
            throw new Error(`Driver creation option ${name} was specified more than once.`);
        seen.add(normalizedName);
        totalLength += name.length + value.length;
        parsed.push({ name, value });
    }
    if (totalLength > 16_384)
        throw new Error("Driver creation options exceed the 16384-character limit.");
    return parsed;
}
function resolvedGisInputPath(filePath) {
    return isVirtualZipPath(filePath) ? filePath : path.resolve(filePath);
}
function assertValidTargetLayerName(name) {
    if (!name.trim())
        throw new Error("Output layer name cannot be empty.");
    if (name.startsWith("-") || /[\u0000-\u001f\u007f]/.test(name)) {
        throw new Error("Output layer name cannot begin with '-' or contain control characters.");
    }
}
function validateSpatialExtent(extent) {
    const values = [extent.minX, extent.minY, extent.maxX, extent.maxY];
    if (values.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
        throw new Error("Spatial filter bounds must be finite numbers.");
    }
    if (extent.minX >= extent.maxX || extent.minY >= extent.maxY) {
        throw new Error("Spatial filter minimum bounds must be smaller than maximum bounds.");
    }
    return extent;
}
export function parseGisSpatialExtent(value) {
    const parts = value.split(",").map((part) => part.trim());
    const numbers = parts.map(Number);
    if (parts.length !== 4 || parts.some((part) => !part) || numbers.some((number) => !Number.isFinite(number))) {
        throw new Error("Spatial filter requires four finite coordinates: minX,minY,maxX,maxY.");
    }
    const [minX, minY, maxX, maxY] = numbers;
    return validateSpatialExtent({ minX, minY, maxX, maxY });
}
export class GisOperationError extends Error {
    report;
    constructor(message, report) {
        super(message);
        this.report = report;
        this.name = "GisOperationError";
    }
}
const MAX_STDERR_LENGTH = 64 * 1024;
const MAX_FAILURE_SAMPLES = 5;
const SHAPEFILE_COMPANIONS = new Set([
    ".shp", ".shx", ".dbf", ".prj", ".qpj", ".cpg", ".qix", ".fix", ".sbn", ".sbx", ".fbn", ".fbx",
    ".shp.xml", ".aux.xml",
]);
const MAPINFO_COMPANIONS = new Set([".tab", ".dat", ".map", ".id", ".ind", ".mif", ".mid"]);
const GEOPACKAGE_COMPANIONS = new Set([".gpkg", ".gpkg-wal", ".gpkg-shm", ".gpkg-journal"]);
const CSV_COMPANIONS = new Set([".csv", ".csvt", ".prj"]);
const OUTPUT_DRIVERS = {
    ".csv": "CSV",
    ".shp": "ESRI Shapefile",
    ".geojson": "GeoJSON",
    ".json": "GeoJSON",
    ".kml": "KML",
    ".tab": "MapInfo File",
    ".gpkg": "GPKG",
    ".dxf": "DXF",
};
export class GdalService {
    env;
    constructor(env = process.env) {
        this.env = resolveGdalRuntimeEnvironment(env);
    }
    runtimeStatus() {
        const ogrinfo = this.resolveExecutable("ogrinfo");
        const ogr2ogr = this.resolveExecutable("ogr2ogr");
        const gdalinfo = this.resolveExecutable("gdalinfo");
        const version = gdalinfo ? this.readVersion(gdalinfo) : null;
        return {
            available: Boolean(ogrinfo && ogr2ogr && gdalinfo && version),
            version,
            ogrinfo,
            ogr2ogr,
            gdalinfo,
        };
    }
    async inspect(filePath, options = {}) {
        this.assertInputFile(filePath);
        const executable = this.requireExecutable("ogrinfo");
        let encoding = await detectGisEncoding(filePath, options.sourceEncoding);
        const selectedEncoding = options.sourceEncoding ?? effectiveSourceEncoding(encoding);
        const prepared = await prepareGisInput(filePath, selectedEncoding, this.env, options.zipFilenameEncoding);
        const companionWarnings = await inspectCompanionWarnings(filePath);
        let warnings = [...companionWarnings, ...encoding.warnings, ...(prepared.warnings ?? [])];
        try {
            const { stdout } = await executeFile(executable, ["-json", "-ro", "-so", "-al", ...openOptionArguments(prepared), prepared.path], prepared.env);
            let raw;
            try {
                raw = JSON.parse(stdout);
            }
            catch {
                throw new Error("OGR returned invalid JSON while inspecting the GIS file.");
            }
            const driver = asString(raw.driverShortName) || "Unknown";
            encoding = encodingForGisDriver(driver, encoding);
            warnings = [...companionWarnings, ...encoding.warnings, ...(prepared.warnings ?? [])];
            const longName = asString(raw.driverLongName);
            const rawLayers = Array.isArray(raw.layers) ? raw.layers : [];
            return {
                path: resolvedGisInputPath(filePath),
                format: formatLabel(driver, longName),
                driver,
                layers: rawLayers.map((layer) => normalizeLayer(layer)),
                encoding,
                ...(warnings.length > 0 ? { warnings } : {}),
            };
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const invalidUtf8Warning = await invalidDbfUtf8Warning(filePath, selectedEncoding, message);
            if (invalidUtf8Warning && !warnings.includes(invalidUtf8Warning))
                warnings.push(invalidUtf8Warning);
            if (warnings.length === 0)
                throw error;
            throw new Error(`${message}\n${warnings.join("\n")}`);
        }
        finally {
            await prepared.cleanup();
        }
    }
    async previewAttributes(filePath, options = {}) {
        this.assertInputFile(filePath);
        const limit = options.limit ?? 20;
        if (!Number.isInteger(limit) || limit < 1 || limit > 100)
            throw new Error("GIS attribute preview limit must be between 1 and 100.");
        const dataset = await this.inspect(filePath, {
            sourceEncoding: options.sourceEncoding,
            zipFilenameEncoding: options.zipFilenameEncoding,
        });
        const layer = selectSourceLayer(dataset, options.sourceLayer);
        const selectedEncoding = options.sourceEncoding ?? effectiveSourceEncoding(dataset.encoding);
        const warnings = [...(dataset.warnings ?? [])];
        const hasTextFields = layer.fields.some((field) => /string/i.test(field.type));
        if (!selectedEncoding && hasTextFields) {
            return {
                layer: layer.name,
                fields: layer.fields,
                rows: [],
                features: [],
                featureCount: layer.featureCount,
                encoding: dataset.encoding,
                requiresUserChoice: true,
                warnings,
            };
        }
        const prepared = await prepareGisInput(filePath, selectedEncoding, this.env, options.zipFilenameEncoding);
        try {
            const executable = this.requireExecutable("ogr2ogr");
            const args = ["-f", "GeoJSON", "/vsistdout/", "-limit", String(limit), ...openOptionArguments(prepared), prepared.path, layer.name];
            const { stdout } = await executeFile(executable, args, prepared.env);
            let raw;
            try {
                raw = JSON.parse(stdout);
            }
            catch {
                throw new Error("OGR returned invalid GeoJSON while previewing GIS attributes.");
            }
            const features = Array.isArray(raw.features) ? raw.features : [];
            return {
                layer: layer.name,
                fields: layer.fields,
                rows: features.map((feature) => recordOf(recordOf(feature).properties)),
                features: features.map((feature) => ({ geometry: recordOf(feature).geometry ?? null })),
                featureCount: layer.featureCount,
                encoding: dataset.encoding,
                requiresUserChoice: false,
                warnings,
            };
        }
        finally {
            await prepared.cleanup();
        }
    }
    async checkGeometry(filePath, options = {}) {
        this.assertInputFile(filePath);
        const sampleLimit = options.sampleLimit ?? 20;
        if (!Number.isInteger(sampleLimit) || sampleLimit < 1 || sampleLimit > 100) {
            throw new Error("GIS geometry validation sample limit must be between 1 and 100.");
        }
        const dataset = await this.inspect(filePath, {
            sourceEncoding: options.sourceEncoding,
            zipFilenameEncoding: options.zipFilenameEncoding,
        });
        const layer = selectSourceLayer(dataset, options.sourceLayer);
        const selectedEncoding = options.sourceEncoding ?? effectiveSourceEncoding(dataset.encoding);
        const prepared = await prepareGisInput(filePath, selectedEncoding, this.env, options.zipFilenameEncoding);
        const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "dbstudio-gis-geometry-check-"));
        const issuesPath = path.join(temporaryDirectory, "geometry-issues.gpkg");
        try {
            await executeFile(this.requireExecutable("gdal"), [
                "vector", "check-geometry", "--quiet", "--input-layer", layer.name,
                ...preparedGdalOpenOptionArguments(prepared), "-f", "GPKG", prepared.path, issuesPath, "--overwrite",
            ], prepared.env);
            const { stdout: infoJson } = await executeFile(this.requireExecutable("ogrinfo"), ["-json", "-ro", "-so", "-al", issuesPath], prepared.env);
            const issueDataset = parseOgrJson(infoJson, "inspect geometry validation output");
            const issueLayers = Array.isArray(issueDataset.layers) ? issueDataset.layers.map(recordOf) : [];
            const issueLayer = issueLayers.find((candidate) => asString(candidate.name) === "error_location") ?? issueLayers[0];
            if (!issueLayer)
                throw new Error("GDAL geometry checker returned no output layer.");
            const issueCount = typeof issueLayer.featureCount === "number" && Number.isFinite(issueLayer.featureCount)
                ? issueLayer.featureCount
                : 0;
            const geometryFields = layer.geometryFields?.length
                ? layer.geometryFields
                : layer.geometryType ? [{ name: null, type: layer.geometryType }] : [];
            const geometryCounts = geometryFields.length > 0
                ? await countGeometryValues(this.requireExecutable("ogr2ogr"), prepared.path, layer.name, geometryFields, prepared.env)
                : [];
            const { stdout: sampleJson } = await executeFile(this.requireExecutable("ogr2ogr"), [
                "-f", "GeoJSON", "/vsistdout/", "-limit", String(sampleLimit), issuesPath, asString(issueLayer.name) || "error_location",
            ], prepared.env);
            const sampleDataset = parseOgrJson(sampleJson, "read geometry validation samples");
            const features = Array.isArray(sampleDataset.features) ? sampleDataset.features.map(recordOf) : [];
            const issues = features.map((feature) => {
                const properties = recordOf(feature.properties);
                const geometry = recordOf(feature.geometry);
                const coordinates = Array.isArray(geometry.coordinates) ? geometry.coordinates : [];
                const coordinatePairs = geometry.type === "Point"
                    ? [coordinates]
                    : geometry.type === "MultiPoint" ? coordinates : [];
                return {
                    reason: asString(properties.error) || "Geometry is invalid or non-simple.",
                    locations: coordinatePairs.flatMap((coordinate) => {
                        if (!Array.isArray(coordinate))
                            return [];
                        const [x, y] = coordinate;
                        return typeof x === "number" && Number.isFinite(x) && typeof y === "number" && Number.isFinite(y)
                            ? [{ x, y }]
                            : [];
                    }),
                };
            });
            return {
                layer: layer.name,
                featureCount: layer.featureCount,
                geometryCounts,
                issueCount,
                issues,
                issuesTruncated: issueCount > issues.length,
                warnings: [
                    ...(dataset.warnings ?? []),
                    "GDAL checks polygon validity, line simplicity, and GeometryCollection components; other geometry types are not checked. GEOS permits repeated ring points and does not enforce ring orientation.",
                ],
            };
        }
        finally {
            try {
                await prepared.cleanup();
            }
            finally {
                await rm(temporaryDirectory, { recursive: true, force: true });
            }
        }
    }
    async inspectPostgresTable(table, connection) {
        const tableRef = parseTableReference(table);
        const executable = this.requireExecutable("ogrinfo");
        const connectionEnvironment = postgresEnvironment(connection, this.env);
        const layerName = tableRef.schema === "public" ? tableRef.name : `${tableRef.schema}.${tableRef.name}`;
        const { stdout } = await executeFile(executable, ["-json", "-ro", "-so", "PG:", layerName], connectionEnvironment);
        let raw;
        try {
            raw = JSON.parse(stdout);
        }
        catch {
            throw new Error("OGR returned invalid JSON while inspecting the PostGIS table.");
        }
        const layers = Array.isArray(raw.layers) ? raw.layers : [];
        if (layers.length === 0)
            throw new Error(`PostGIS table was not found by OGR: ${tableRef.schema}.${tableRef.name}`);
        return normalizeLayer(layers[0]);
    }
    async assertPostgresTableAbsent(table, connection) {
        const executable = this.requireExecutable("ogrinfo");
        const relation = `"${table.schema}"."${table.name}"`;
        const relationLiteral = relation.replaceAll("'", "''");
        const sql = `SELECT 1 AS present WHERE to_regclass('${relationLiteral}') IS NOT NULL`;
        const { stdout } = await executeFile(executable, ["-json", "-ro", "-dialect", "PostgreSQL", "PG:", "-sql", sql], postgresEnvironment(connection, this.env));
        let raw;
        try {
            raw = JSON.parse(stdout);
        }
        catch {
            throw new Error("OGR returned invalid JSON while checking whether the PostGIS destination exists.");
        }
        const layers = Array.isArray(raw.layers) ? raw.layers : [];
        const featureCount = Number(layers[0]?.featureCount ?? 0);
        if (featureCount > 0) {
            throw new Error(`PostGIS table already exists: ${table.schema}.${table.name}. Choose append or overwrite.`);
        }
    }
    async convert(input, output, options = {}, operationOptions = {}) {
        this.assertInputFile(input);
        const resolvedOutput = path.resolve(output);
        await assertVectorOutputAvailable(resolvedOutput);
        const driver = driverForOutput(output);
        assertStandardOutputCrs(output, options.targetCrs);
        const source = await this.inspect(input, {
            sourceEncoding: options.sourceEncoding,
            zipFilenameEncoding: options.zipFilenameEncoding,
        });
        const sourceEncoding = options.sourceEncoding ?? effectiveSourceEncoding(source.encoding);
        if (!sourceEncoding)
            throw new Error("Source encoding is uncertain. Preview the attributes and specify --source-encoding before converting.");
        const selectedLayer = options.sourceLayer === undefined ? undefined : selectSourceLayer(source, options.sourceLayer);
        const selectedLayers = selectedLayer ? [selectedLayer] : source.layers;
        const fieldMappingChanges = options.fieldMappings?.some((mapping) => mapping.source !== mapping.target || mapping.targetType !== undefined) ?? false;
        if (fieldMappingChanges && options.sourceLayer !== undefined && !selectedLayer) {
            throw new Error(`GIS source layer '${options.sourceLayer}' was not found.`);
        }
        if (fieldMappingChanges && selectedLayers.length !== 1) {
            throw new Error("Applying GIS field mappings requires one selected source layer; pass --layer.");
        }
        if (options.targetLayerName !== undefined) {
            assertValidTargetLayerName(options.targetLayerName);
            if (selectedLayers.length !== 1) {
                throw new Error("Renaming an output layer requires a single selected source layer; pass --layer.");
            }
        }
        const sourceFeatureCount = selectedLayer ? selectedLayer.featureCount : datasetFeatureCount(source);
        const spatialFilter = options.spatialFilter ? validateSpatialExtent(options.spatialFilter) : undefined;
        const creationOptions = validateGisOutputFormatOptions(output, options, selectedLayers);
        const warnings = [
            ...(source.warnings ?? []),
            ...formatConversionWarnings(output, selectedLayers),
            ...(spatialFilter
                ? ["A source-coordinate rectangular spatial filter was applied; the output count contains only matching features."]
                : []),
            ...(options.coordinateOperation?.trim() ? ["An explicit PROJ coordinate operation was supplied; verify its area of use and required datum grids."] : []),
            ...(options.makeValid
                ? ["GDAL MakeValid was explicitly enabled; repaired geometries may change type or become empty. Lower-dimensional components may be removed from mixed results, and fully collapsed features may become lines or points."]
                : []),
            ...(options.makeValid && selectedLayers.some((layer) => hasGeometryDimension(layer.geometryType, "M"))
                ? ["GDAL MakeValid may replace M (measure) values on repaired features with 0; inspect measured ordinates after conversion."]
                : []),
        ];
        const args = ["-f", driver, "", input];
        if (options.targetLayerName !== undefined)
            args.push("-nln", options.targetLayerName);
        appendOutputFormatOptions(args, output, options.targetEncoding, selectedLayers, creationOptions);
        appendCrsOptions(args, { ...source, layers: selectedLayers }, options);
        if (spatialFilter) {
            args.push("-spat", String(spatialFilter.minX), String(spatialFilter.minY), String(spatialFilter.maxX), String(spatialFilter.maxY));
        }
        appendGeometryValidityOptions(args, options.makeValid);
        args.push("-progress");
        const prepared = await prepareGisInput(input, sourceEncoding, this.env, options.zipFilenameEncoding, options.replaceIncompleteUtf8Tails);
        warnings.push(...(prepared.warnings ?? []));
        args.splice(3, 1, ...openOptionArguments(prepared), prepared.path);
        let temporary;
        try {
            let usesSqlProjection = false;
            const isTabOutput = path.extname(output).toLowerCase() === ".tab";
            if ((isTabOutput || fieldMappingChanges) && selectedLayers.length === 1) {
                const projectionLayer = prepared.path === input
                    ? selectedLayers[0]
                    : (await this.inspect(prepared.path)).layers.find((layer) => layer.name === selectedLayers[0].name);
                if (!projectionLayer)
                    throw new Error(`GIS source layer was not found after encoding preparation: ${selectedLayers[0].name}`);
                const sql = buildFieldProjectionSql(projectionLayer, options.fieldMappings ?? [], {
                    ...(isTabOutput ? { stringWidth: 254 } : {}),
                    includeGeometry: true,
                });
                if (sql) {
                    const sourceArgumentIndex = args.indexOf(prepared.path);
                    args.splice(sourceArgumentIndex, 0, "-dialect", "SQLite", "-sql", sql);
                    usesSqlProjection = true;
                }
            }
            if (options.sourceLayer !== undefined && !usesSqlProjection) {
                const sourceArgumentIndex = args.indexOf(prepared.path);
                args.splice(sourceArgumentIndex + 1, 0, options.sourceLayer);
            }
            temporary = await createTemporaryOutput(resolvedOutput);
            args[2] = temporary.output;
            await this.runOgr2Ogr(args, operationOptions, prepared.env);
            const info = await this.inspect(temporary.output);
            await commitTemporaryOutput(temporary.directory, resolvedOutput);
            const outputFeatureCount = datasetFeatureCount(info);
            const report = {
                operation: "convert",
                status: "completed",
                input: resolvedGisInputPath(input),
                output: resolvedOutput,
                featureCount: sourceFeatureCount,
                successfulFeatures: outputFeatureCount,
                failedFeatures: 0,
                failedSamples: [],
                ...(warnings.length > 0 ? { warnings } : {}),
            };
            return { ...info, path: resolvedOutput, operationReport: report };
        }
        catch (error) {
            throw makeOperationError("convert", input, resolvedOutput, sourceFeatureCount, error, operationOptions.signal, prepared.env, warnings);
        }
        finally {
            if (temporary)
                await rm(temporary.directory, { recursive: true, force: true });
            await prepared.cleanup();
        }
    }
    async importToPostgres(input, table, connection, options = {}, operationOptions = {}) {
        this.assertInputFile(input);
        const tableRef = parseTableReference(table);
        const mode = options.mode ?? "create";
        const source = await this.inspect(input, {
            sourceEncoding: options.sourceEncoding,
            zipFilenameEncoding: options.zipFilenameEncoding,
        });
        const sourceLayer = selectSourceLayer(source, options.sourceLayer);
        const hasTextFields = sourceLayer.fields.some((field) => /string/i.test(field.type));
        const sourceEncoding = options.sourceEncoding ?? effectiveSourceEncoding(source.encoding);
        if (!sourceEncoding && hasTextFields)
            throw new Error("Source encoding is uncertain. Preview the attributes and specify --source-encoding before importing.");
        const selectedSource = { ...source, layers: [sourceLayer] };
        const fidAttributeCollision = sourceLayer.fidColumnName !== null
            && sourceLayer.fidColumnName !== undefined
            && sourceLayer.fields.some((field) => field.name === sourceLayer.fidColumnName);
        const featureCount = sourceLayer.featureCount;
        const spatialFilter = options.spatialFilter ? validateSpatialExtent(options.spatialFilter) : undefined;
        let operationFeatureCount = spatialFilter ? null : featureCount;
        const dimensionSuffix = geometryDimensionSuffix(sourceLayer.geometryType);
        const unspecifiedGeometryType = sourceLayer.geometryType === null || isUnspecifiedGeometryType(sourceLayer.geometryType);
        const forceKmlAltitude = unspecifiedGeometryType && path.extname(input).toLowerCase() === ".kml";
        let importWarnings = [
            ...(source.warnings ?? []),
            mode === "append"
                ? "Append preserves the destination geometry column type; a typed column may reject features with a different geometry type."
                : "PostGIS uses a generic geometry column so single and multi-geometry features can coexist without changing their feature geometries.",
            ...(forceKmlAltitude
                ? ["Generic KML geometry is imported as XYZ to retain altitude values; 2D features may receive a zero Z ordinate."]
                : []),
            ...(spatialFilter
                ? ["A source-coordinate rectangular spatial filter was applied; the imported feature count is not estimated from the full layer metadata."]
                : []),
            ...(options.coordinateOperation?.trim() ? ["An explicit PROJ coordinate operation was supplied; verify its area of use and required datum grids."] : []),
            ...(options.makeValid
                ? ["GDAL MakeValid was explicitly enabled; repaired geometries may change type or become empty. Lower-dimensional components may be removed from mixed results, and fully collapsed features may become lines or points."]
                : []),
            ...(options.makeValid && hasGeometryDimension(sourceLayer.geometryType, "M")
                ? ["GDAL MakeValid may replace M (measure) values on repaired features with 0; inspect measured ordinates after import."]
                : []),
        ];
        const fieldSql = buildFieldProjectionSql(sourceLayer, options.fieldMappings);
        const args = ["-f", "PostgreSQL", "PG:", input];
        if (fieldSql)
            args.push("-sql", fieldSql, "-dialect", "OGRSQL");
        else
            args.push(sourceLayer.name);
        if (fidAttributeCollision) {
            args.push("-unsetFid");
            importWarnings.push(`The source attribute "${sourceLayer.fidColumnName}" also serves as the OGR feature ID; its attribute values are preserved while PostgreSQL generates independent feature IDs.`);
        }
        const postgresColumnTypes = buildPostgresColumnTypeOverrides(sourceLayer, options.fieldMappings);
        if (postgresColumnTypes.option) {
            args.push("-lco", postgresColumnTypes.option);
        }
        if (postgresColumnTypes.numericFields.length > 0) {
            importWarnings.push("Real fields with declared fractional precision are imported as unconstrained PostgreSQL NUMERIC columns to preserve decimal values and avoid width/scale overflow.");
        }
        if (postgresColumnTypes.stringFields.length > 0) {
            importWarnings.push(`Explicitly mapped string fields are created as PostgreSQL VARCHAR columns: ${postgresColumnTypes.stringFields.slice(0, 5).join(", ")}${postgresColumnTypes.stringFields.length > 5 ? ", …" : ""}.`);
        }
        if (postgresColumnTypes.skippedFields.length > 0) {
            importWarnings.push(`Could not apply PostgreSQL column type overrides to fields with comma, equals, or control characters in their target names: ${postgresColumnTypes.skippedFields.slice(0, 5).join(", ")}. Rename those fields before import if their inferred type is unsuitable.`);
        }
        if (spatialFilter)
            args.push("-spat", String(spatialFilter.minX), String(spatialFilter.minY), String(spatialFilter.maxX), String(spatialFilter.maxY));
        args.push("-nln", tableRef.name, "-lco", "SCHEMA=" + tableRef.schema, "-lco", "LAUNDER=NO");
        appendGeometryValidityOptions(args, options.makeValid);
        // The PostgreSQL OGR driver creates an unspecified geometry layer as XY and silently drops
        // feature Z/M values. Scan generic layers and explicitly select their common/superset dimension.
        if (sourceLayer.geometryType !== null && !isUnspecifiedGeometryType(sourceLayer.geometryType)) {
            // Keep a generic shape type so single/multi features can coexist, while preserving dimensions declared by OGR.
            args.push("-nlt", `GEOMETRY${dimensionSuffix}`);
        }
        if (forceKmlAltitude)
            args.push("-dim", "XYZ");
        if (mode === "append")
            args.push("-update", "-append");
        if (mode === "overwrite")
            args.push("-update", "-overwrite");
        appendCrsOptions(args, selectedSource, options);
        if (mode === "create")
            await this.assertPostgresTableAbsent(tableRef, connection);
        args.push("-ds_transaction", "-progress");
        const prepared = await prepareGisInput(input, sourceEncoding, this.env, options.zipFilenameEncoding, options.replaceIncompleteUtf8Tails);
        importWarnings.push(...(prepared.warnings ?? []));
        const connectionEnvironment = postgresEnvironment(connection, prepared.env);
        let schemaOverrideDirectory;
        try {
            const schemaOverride = source.driver.toLocaleLowerCase() === "geojson"
                ? buildGeoJsonStringSubtypeSchemaOverride(sourceLayer, options.fieldMappings ?? [])
                : undefined;
            const sourceOpenOptions = openOptionArguments(prepared);
            if (schemaOverride) {
                schemaOverrideDirectory = await mkdtemp(path.join(os.tmpdir(), "dbstudio-gis-ogr-schema-"));
                const schemaPath = path.join(schemaOverrideDirectory, "schema.json");
                await writeFile(schemaPath, schemaOverride, { encoding: "utf8", flag: "wx" });
                sourceOpenOptions.push("-oo", `OGR_SCHEMA=${schemaPath}`);
                importWarnings.push("Explicit string mappings for GeoJSON JSON-subtype fields were applied at source-schema read time so mixed JSON values are converted to text before database insertion.");
            }
            args.splice(2, 0, ...sourceOpenOptions);
            args.splice(3 + sourceOpenOptions.length, 1, prepared.path);
            if (spatialFilter) {
                const { minX, minY, maxX, maxY } = spatialFilter;
                try {
                    const { stdout } = await executeFile(this.requireExecutable("ogrinfo"), [
                        "-json", "-ro", "-so", "-spat", String(minX), String(minY), String(maxX), String(maxY),
                        ...sourceOpenOptions, prepared.path, sourceLayer.name,
                    ], prepared.env, operationOptions.signal);
                    const { layers } = parseOgrJson(stdout, "count the filtered features");
                    const count = Array.isArray(layers) && layers.length === 1 ? normalizeLayer(layers[0]).featureCount : null;
                    if (count !== null && Number.isSafeInteger(count) && count >= 0)
                        operationFeatureCount = count;
                }
                catch (error) {
                    if (operationOptions.signal?.aborted)
                        throw error;
                }
                if (operationFeatureCount === null)
                    importWarnings.push("The source driver did not provide a count for the selected spatial extent.");
            }
            let transferOptions = operationOptions;
            if (unspecifiedGeometryType && !forceKmlAltitude) {
                const dimensionScan = await this.scanFeatureDimensions(prepared, sourceLayer.name, spatialFilter, operationOptions);
                const suffix = dimensionScan.targetSuffix;
                args.push("-nlt", `GEOMETRY${suffix}`);
                if (options.makeValid && [...dimensionScan.signatures].some((signature) => signature.includes("M"))
                    && !hasGeometryDimension(sourceLayer.geometryType, "M")) {
                    importWarnings = [
                        ...importWarnings,
                        "GDAL MakeValid may replace M (measure) values on repaired features with 0; inspect measured ordinates after import.",
                    ];
                }
                if (dimensionScan.mixed) {
                    const targetDimension = suffix === "ZM" ? "XYZM" : suffix === "Z" ? "XYZ" : suffix === "M" ? "XYM" : "XY";
                    const missing = [
                        ...(dimensionScan.hasMissingZ ? ["Z"] : []),
                        ...(dimensionScan.hasMissingM ? ["M"] : []),
                    ];
                    const observed = [...dimensionScan.signatures]
                        .map((signature) => signature === "ZM" ? "XYZM" : signature === "Z" ? "XYZ" : signature === "M" ? "XYM" : "XY")
                        .join("/");
                    importWarnings = [
                        ...importWarnings,
                        `Mixed feature dimensions ${observed} were normalized to ${targetDimension}; missing ${missing.join("/")} ordinates were padded with 0 to retain present Z/M values.`,
                    ];
                }
                transferOptions = {
                    signal: operationOptions.signal,
                    onProgress: (percent) => operationOptions.onProgress?.(20 + percent * 0.8),
                };
            }
            await this.runOgr2Ogr(args, transferOptions, connectionEnvironment);
            return {
                operation: "import",
                status: "completed",
                input: resolvedGisInputPath(input),
                output: `${tableRef.schema}.${tableRef.name}`,
                featureCount: operationFeatureCount,
                successfulFeatures: operationFeatureCount,
                failedFeatures: spatialFilter && operationFeatureCount === null ? null : 0,
                failedSamples: [],
                ...(importWarnings.length > 0 ? { warnings: importWarnings } : {}),
            };
        }
        catch (error) {
            const errorObject = error && typeof error === "object" ? error : undefined;
            const errorText = typeof errorObject?.stderr === "string"
                ? errorObject.stderr
                : error instanceof Error ? error.message : String(error);
            const failedImportWarnings = [...importWarnings];
            const invalidUtf8Warning = await invalidDbfUtf8Warning(input, sourceEncoding, errorText);
            if (invalidUtf8Warning)
                failedImportWarnings.push(invalidUtf8Warning);
            if (source.driver.toLocaleLowerCase() === "geojson") {
                const jsonSubtypeWarning = geoJsonJsonSubtypeImportWarning(sourceLayer, options.fieldMappings ?? [], errorText);
                if (jsonSubtypeWarning)
                    failedImportWarnings.push(jsonSubtypeWarning);
            }
            throw makeOperationError("import", input, `${tableRef.schema}.${tableRef.name}`, operationFeatureCount, error, operationOptions.signal, connectionEnvironment, failedImportWarnings);
        }
        finally {
            try {
                await prepared.cleanup();
            }
            finally {
                if (schemaOverrideDirectory)
                    await rm(schemaOverrideDirectory, { recursive: true, force: true });
            }
        }
    }
    async scanFeatureDimensions(prepared, sourceLayer, spatialFilter, operationOptions) {
        /* dimensionEarlyStop */
        const scanController = new AbortController();
        const signatures = new Set();
        let hasZ = false;
        let hasM = false;
        let hasHeader = false;
        let linePrefix = "";
        const consumeLine = (prefix) => {
            if (!hasHeader) {
                hasHeader = true;
                return;
            }
            let value = prefix;
            if (value.startsWith('"')) {
                value = value.slice(1);
                if (value.endsWith('"'))
                    value = value.slice(0, -1);
                value = value.replaceAll('""', '"');
            }
            if (!value.trim())
                return;
            const dimension = WKT_DIMENSION_MARKER.exec(value)?.[1]?.toUpperCase();
            const featureHasZ = dimension === "Z" || dimension === "ZM";
            const featureHasM = dimension === "M" || dimension === "ZM";
            hasZ ||= featureHasZ;
            hasM ||= featureHasM;
            signatures.add(`${featureHasZ ? "Z" : ""}${featureHasM ? "M" : ""}`);
            // Once every dimension combination is observed, the superset is known.
            if (signatures.size >= 4)
                scanController.abort();
        };
        const consumeChunk = (chunk) => {
            let offset = 0;
            while (offset < chunk.length) {
                const newline = chunk.indexOf("\n", offset);
                const lineEnd = newline === -1 ? chunk.length : newline;
                const available = WKT_DIMENSION_PREFIX_LENGTH - linePrefix.length;
                if (available > 0 && lineEnd > offset) {
                    linePrefix += chunk.slice(offset, Math.min(lineEnd, offset + available));
                }
                if (newline === -1)
                    return;
                consumeLine(linePrefix);
                linePrefix = "";
                offset = newline + 1;
            }
        };
        const args = ["-f", "CSV", "/vsistdout/", "-select", "", "-lco", "GEOMETRY=AS_WKT", "-progress"];
        if (spatialFilter)
            args.push("-spat", String(spatialFilter.minX), String(spatialFilter.minY), String(spatialFilter.maxX), String(spatialFilter.maxY));
        args.push(...openOptionArguments(prepared), prepared.path, sourceLayer);
        const forwardAbort = () => scanController.abort();
        operationOptions.signal?.addEventListener("abort", forwardAbort, { once: true });
        try {
            await this.runOgr2Ogr(args, {
                signal: scanController.signal,
                onProgress: (percent) => operationOptions.onProgress?.(percent * 0.2),
            }, prepared.env, consumeChunk);
        }
        catch (error) {
            // Early stop is intentional: we already have the full dimension superset.
            if (!scanController.signal.aborted || operationOptions.signal?.aborted || signatures.size < 4)
                throw error;
        }
        finally {
            operationOptions.signal?.removeEventListener("abort", forwardAbort);
        }
        if (linePrefix)
            consumeLine(linePrefix);
        const targetSuffix = hasZ && hasM ? "ZM" : hasZ ? "Z" : hasM ? "M" : "";
        const hasMissingZ = hasZ && [...signatures].some((signature) => !signature.includes("Z"));
        const hasMissingM = hasM && [...signatures].some((signature) => !signature.includes("M"));
        return { signatures, hasZ, hasM, mixed: signatures.size > 1, hasMissingZ, hasMissingM, targetSuffix };
    }
    async exportFromPostgres(table, output, connection, options = {}, operationOptions = {}) {
        const resolvedOutput = path.resolve(output);
        await assertVectorOutputAvailable(resolvedOutput);
        const tableRef = parseTableReference(table);
        const driver = driverForOutput(output);
        assertStandardOutputCrs(output, options.targetCrs);
        const layerName = options.targetLayerName ?? path.basename(output, path.extname(output));
        assertValidTargetLayerName(layerName);
        const connectionEnvironment = postgresEnvironment(connection, this.env);
        const extension = path.extname(output).toLowerCase();
        const spatialFilter = options.spatialFilter ? validateSpatialExtent(options.spatialFilter) : undefined;
        const requiresSourceLayer = Boolean(options.fieldMappings?.length || options.layerCreationOptions?.length || options.targetCrs || options.coordinateOperation)
            || [".csv", ".shp", ".tab", ".kml", ".geojson", ".json", ".gpkg", ".dxf"].includes(extension);
        const sourceLayer = requiresSourceLayer && !operationOptions.signal?.aborted
            ? await this.inspectPostgresTable(table, connection)
            : undefined;
        const creationOptions = validateGisOutputFormatOptions(output, options, sourceLayer ? [sourceLayer] : []);
        const requestedFieldMappings = options.fieldMappings ?? [];
        const automaticKmlIdMapping = extension === ".kml" && sourceLayer
            ? buildKmlIdAttributeMapping(sourceLayer, requestedFieldMappings)
            : undefined;
        const fieldMappings = automaticKmlIdMapping
            ? [...requestedFieldMappings, automaticKmlIdMapping]
            : requestedFieldMappings;
        const warnings = formatConversionWarnings(output, sourceLayer ? [sourceLayer] : [], fieldMappings);
        if (options.coordinateOperation?.trim())
            warnings.push("An explicit PROJ coordinate operation was supplied; verify its area of use and required datum grids.");
        const fieldSql = sourceLayer && (fieldMappings.length > 0 || extension === ".tab")
            ? buildFieldProjectionSql(sourceLayer, fieldMappings, extension === ".tab" ? { stringWidth: 254 } : {})
            : undefined;
        const sql = fieldSql ?? "SELECT * FROM " + quoteIdentifier(tableRef.schema) + "." + quoteIdentifier(tableRef.name);
        const args = ["-f", driver, "", "PG:", "-sql", sql];
        if (fieldSql)
            args.push("-dialect", "OGRSQL");
        args.push("-nln", layerName);
        if (spatialFilter)
            args.push("-spat", String(spatialFilter.minX), String(spatialFilter.minY), String(spatialFilter.maxX), String(spatialFilter.maxY));
        appendOutputFormatOptions(args, output, options.targetEncoding, sourceLayer ? [sourceLayer] : [], creationOptions);
        if (extension === ".tab") {
            const hasExplicitBounds = creationOptions.layerCreationOptions.some((option) => option.name.toUpperCase() === "BOUNDS");
            const mapInfoBounds = options.targetCrs || hasExplicitBounds ? undefined : formatMapInfoBounds(sourceLayer?.extent);
            if (mapInfoBounds) {
                args.push("-lco", `BOUNDS=${mapInfoBounds}`);
                warnings.push("MapInfo TAB coordinate bounds were set from the source extent to improve coordinate accuracy.");
            }
            else if (!hasExplicitBounds) {
                warnings.push("MapInfo TAB uses driver default coordinate bounds; coordinate precision may be lower, especially after reprojection.");
            }
        }
        appendCrsOptions(args, { layers: sourceLayer ? [sourceLayer] : [] }, options);
        args.push("-progress");
        const temporary = await createTemporaryOutput(resolvedOutput);
        args[2] = temporary.output;
        try {
            await this.runOgr2Ogr(args, operationOptions, connectionEnvironment);
            const info = await this.inspect(temporary.output);
            await commitTemporaryOutput(temporary.directory, resolvedOutput);
            const report = {
                operation: "export",
                status: "completed",
                input: `${tableRef.schema}.${tableRef.name}`,
                output: resolvedOutput,
                featureCount: datasetFeatureCount(info),
                successfulFeatures: datasetFeatureCount(info),
                failedFeatures: 0,
                failedSamples: [],
                ...(warnings.length > 0 ? { warnings } : {}),
            };
            return { ...info, path: resolvedOutput, operationReport: report };
        }
        catch (error) {
            throw makeOperationError("export", `${tableRef.schema}.${tableRef.name}`, resolvedOutput, null, error, operationOptions.signal, connectionEnvironment, warnings);
        }
        finally {
            await rm(temporary.directory, { recursive: true, force: true });
        }
    }
    async importToSqlite(input, databasePath, table, storage, options = {}, operationOptions = {}) {
        this.assertInputFile(input);
        if (!databasePath.trim())
            throw new Error("SQLite GIS database path cannot be empty.");
        assertValidTargetLayerName(table);
        const resolvedDatabase = path.resolve(databasePath);
        if (!isVirtualZipPath(input) && path.resolve(input) === resolvedDatabase) {
            throw new Error("A SQLite database cannot be imported into itself as a vector source.");
        }
        const mode = options.mode ?? "create";
        const source = await this.inspect(input, {
            sourceEncoding: options.sourceEncoding,
            zipFilenameEncoding: options.zipFilenameEncoding,
        });
        const sourceLayer = selectSourceLayer(source, options.sourceLayer);
        const sourceEncoding = options.sourceEncoding ?? effectiveSourceEncoding(source.encoding);
        if (!sourceEncoding && sourceLayer.fields.some((field) => /string/i.test(field.type))) {
            throw new Error("Source encoding is uncertain. Preview the attributes and specify --source-encoding before importing.");
        }
        const spatialFilter = options.spatialFilter ? validateSpatialExtent(options.spatialFilter) : undefined;
        const featureCount = spatialFilter ? null : sourceLayer.featureCount;
        const dimensionSuffix = geometryDimensionSuffix(sourceLayer.geometryType);
        const warnings = [
            ...(source.warnings ?? []),
            `Features are stored in ${storage === "spatialite" ? "a SpatiaLite database" : "a GeoPackage database"}.`,
            ...(spatialFilter ? ["A source-coordinate rectangular spatial filter was applied."] : []),
            ...(options.coordinateOperation?.trim() ? ["An explicit PROJ coordinate operation was supplied; verify its area of use and required datum grids."] : []),
            ...(options.makeValid ? ["GDAL MakeValid was explicitly enabled; repaired geometries may change type or become empty."] : []),
            ...(options.makeValid && hasGeometryDimension(sourceLayer.geometryType, "M")
                ? ["GDAL MakeValid may replace M (measure) values on repaired features with 0; inspect measured ordinates after import."]
                : []),
        ];
        const prepared = await prepareGisInput(input, sourceEncoding, this.env, options.zipFilenameEncoding, options.replaceIncompleteUtf8Tails);
        warnings.push(...(prepared.warnings ?? []));
        const existingDatabase = existsSync(resolvedDatabase);
        let existingLayer;
        try {
            if (existingDatabase) {
                const current = await this.inspect(resolvedDatabase);
                existingLayer = current.layers.find((layer) => layer.name.toLocaleLowerCase("en-US") === table.toLocaleLowerCase("en-US"));
            }
            if (options.initializeSpatialite && (storage !== "spatialite" || !existingDatabase || mode !== "create")) {
                throw new Error("SpatiaLite initialization applies only to an existing ordinary SQLite database in create mode.");
            }
            if (mode === "create" && existingLayer) {
                throw new Error(`SQLite spatial table '${table}' already exists. Choose append or overwrite.`);
            }
            if (mode === "append" && !existingLayer) {
                throw new Error(`SQLite spatial table '${table}' does not exist for append.`);
            }
            if (options.initializeSpatialite) {
                await this.initializeSpatialiteMetadata(resolvedDatabase, operationOptions.signal);
                warnings.push("SpatiaLite metadata was explicitly initialized in the existing SQLite file; pre-existing ordinary tables are preserved.");
            }
            const driver = storage === "geopackage" ? "GPKG" : "SQLite";
            const args = ["-f", driver, resolvedDatabase, prepared.path];
            const fieldSql = options.fieldMappings?.length
                ? buildFieldProjectionSql(sourceLayer, options.fieldMappings)
                : undefined;
            if (fieldSql)
                args.push("-sql", fieldSql, "-dialect", "OGRSQL");
            else
                args.push(sourceLayer.name);
            if (existingDatabase)
                args.push("-update");
            if (mode === "append")
                args.push("-append");
            if (mode === "overwrite" && existingLayer)
                args.push("-overwrite");
            args.push("-nln", table);
            if (storage === "spatialite") {
                args.push("-lco", "FORMAT=SPATIALITE", "-lco", "LAUNDER=NO");
                if (mode !== "append")
                    args.push("-lco", `SPATIAL_INDEX=${options.createSpatialIndex === false ? "NO" : "YES"}`);
                if (!existingDatabase)
                    args.push("-dsco", "SPATIALITE=YES", "-dsco", "INIT_WITH_EPSG=YES");
            }
            else {
                if (mode !== "append")
                    args.push("-lco", `SPATIAL_INDEX=${options.createSpatialIndex === false ? "NO" : "YES"}`);
            }
            // SQLite/SpatiaLite's GDAL driver declares generic GEOMETRYZ for GEOMETRYZM,
            // then rejects concrete POINTZM features on insert. Let it retain the source
            // layer's declared type so measured geometries round-trip correctly.
            if (storage === "geopackage" && sourceLayer.geometryType && !isUnspecifiedGeometryType(sourceLayer.geometryType)) {
                args.push("-nlt", `GEOMETRY${dimensionSuffix}`);
            }
            if (spatialFilter)
                args.push("-spat", String(spatialFilter.minX), String(spatialFilter.minY), String(spatialFilter.maxX), String(spatialFilter.maxY));
            appendCrsOptions(args, { ...source, layers: [sourceLayer] }, options);
            appendGeometryValidityOptions(args, options.makeValid);
            args.push("-gt", "unlimited", "-progress");
            await this.runOgr2Ogr(args, operationOptions, prepared.env);
            const result = await this.inspect(resolvedDatabase);
            const outputLayer = result.layers.find((layer) => layer.name.toLocaleLowerCase("en-US") === table.toLocaleLowerCase("en-US"));
            if (!outputLayer)
                throw new Error(`GDAL completed the write but SQLite layer '${table}' was not visible on readback.`);
            const beforeCount = existingLayer?.featureCount ?? 0;
            const afterCount = outputLayer.featureCount;
            const successfulFeatures = afterCount === null ? null : Math.max(0, afterCount - (mode === "append" ? beforeCount : 0));
            if (successfulFeatures !== null && featureCount !== null && successfulFeatures !== featureCount) {
                throw new Error(`SQLite GIS import count mismatch: expected ${featureCount} new features, read back ${successfulFeatures}.`);
            }
            return {
                operation: "import",
                status: "completed",
                input: resolvedGisInputPath(input),
                output: `${resolvedDatabase}::${table}`,
                featureCount,
                successfulFeatures,
                failedFeatures: 0,
                failedSamples: [],
                ...(warnings.length > 0 ? { warnings } : {}),
            };
        }
        catch (error) {
            throw makeOperationError("import", input, `${resolvedDatabase}::${table}`, featureCount, error, operationOptions.signal, prepared.env, warnings);
        }
        finally {
            await prepared.cleanup();
        }
    }
    async initializeSpatialiteMetadata(databasePath, signal) {
        const executable = this.requireExecutable("ogrinfo");
        const { stdout } = await executeFile(executable, [
            "-update", "-dialect", "SQLite", "-sql", "SELECT InitSpatialMetadata(1)", path.resolve(databasePath),
        ], this.env, signal);
        if (!/InitSpatialMetaData\s*\(Integer\)\s*=\s*1/i.test(stdout)) {
            throw new Error("GDAL did not confirm successful SpatiaLite metadata initialization.");
        }
    }
    async exportFromSqlite(databasePath, table, output, options = {}, operationOptions = {}) {
        const resolvedDatabase = path.resolve(databasePath);
        if (!existsSync(resolvedDatabase))
            throw new Error(`SQLite GIS database does not exist: ${resolvedDatabase}`);
        const resolvedOutput = path.resolve(output);
        await assertVectorOutputAvailable(resolvedOutput);
        const source = await this.inspect(resolvedDatabase);
        const sourceLayer = source.layers.find((layer) => layer.name.toLocaleLowerCase("en-US") === table.toLocaleLowerCase("en-US"));
        if (!sourceLayer)
            throw new Error(`SQLite GIS table '${table}' was not found.`);
        const geometryFields = sourceLayer.geometryFields ?? [];
        if (geometryFields.length > 1)
            throw new Error("SQLite GIS export supports a single spatial column.");
        if (geometryFields.length === 0 && !sourceLayer.geometryType)
            throw new Error(`SQLite table '${table}' has no recognized spatial column.`);
        const driver = driverForOutput(output);
        assertStandardOutputCrs(output, options.targetCrs);
        const layerName = options.targetLayerName ?? path.basename(output, path.extname(output));
        assertValidTargetLayerName(layerName);
        const extension = path.extname(output).toLowerCase();
        const spatialFilter = options.spatialFilter ? validateSpatialExtent(options.spatialFilter) : undefined;
        const creationOptions = validateGisOutputFormatOptions(output, options, [sourceLayer]);
        const requestedFieldMappings = options.fieldMappings ?? [];
        const automaticKmlIdMapping = extension === ".kml"
            ? buildKmlIdAttributeMapping(sourceLayer, requestedFieldMappings)
            : undefined;
        const fieldMappings = automaticKmlIdMapping ? [...requestedFieldMappings, automaticKmlIdMapping] : requestedFieldMappings;
        const warnings = formatConversionWarnings(output, [sourceLayer], fieldMappings);
        if (options.coordinateOperation?.trim())
            warnings.push("An explicit PROJ coordinate operation was supplied; verify its area of use and required datum grids.");
        if (spatialFilter)
            warnings.push("A source-coordinate rectangular spatial filter was applied; the output count contains only matching features.");
        const fieldSql = fieldMappings.length > 0 || extension === ".tab"
            ? buildFieldProjectionSql(sourceLayer, fieldMappings, extension === ".tab" ? { stringWidth: 254 } : {})
            : undefined;
        const args = ["-f", driver, "", resolvedDatabase];
        if (fieldSql)
            args.push("-sql", fieldSql, "-dialect", "OGRSQL");
        else
            args.push(table);
        args.push("-nln", layerName);
        if (spatialFilter)
            args.push("-spat", String(spatialFilter.minX), String(spatialFilter.minY), String(spatialFilter.maxX), String(spatialFilter.maxY));
        appendOutputFormatOptions(args, output, options.targetEncoding, [sourceLayer], creationOptions);
        if (extension === ".tab") {
            const hasExplicitBounds = creationOptions.layerCreationOptions.some((option) => option.name.toUpperCase() === "BOUNDS");
            const mapInfoBounds = options.targetCrs || hasExplicitBounds ? undefined : formatMapInfoBounds(sourceLayer.extent);
            if (mapInfoBounds)
                args.push("-lco", `BOUNDS=${mapInfoBounds}`);
            else if (!hasExplicitBounds)
                warnings.push("MapInfo TAB uses driver default coordinate bounds; coordinate precision may be lower, especially after reprojection.");
        }
        appendCrsOptions(args, { ...source, layers: [sourceLayer] }, options);
        args.push("-progress");
        const temporary = await createTemporaryOutput(resolvedOutput);
        args[2] = temporary.output;
        try {
            await this.runOgr2Ogr(args, operationOptions);
            const info = await this.inspect(temporary.output);
            await commitTemporaryOutput(temporary.directory, resolvedOutput);
            const outputCount = datasetFeatureCount(info);
            return {
                ...info,
                path: resolvedOutput,
                operationReport: {
                    operation: "export",
                    status: "completed",
                    input: `${resolvedDatabase}::${table}`,
                    output: resolvedOutput,
                    featureCount: outputCount,
                    successfulFeatures: outputCount,
                    failedFeatures: 0,
                    failedSamples: [],
                    ...(warnings.length > 0 ? { warnings } : {}),
                },
            };
        }
        catch (error) {
            throw makeOperationError("export", `${resolvedDatabase}::${table}`, resolvedOutput, sourceLayer.featureCount, error, operationOptions.signal, this.env, warnings);
        }
        finally {
            await rm(temporary.directory, { recursive: true, force: true });
        }
    }
    async runOgr2Ogr(args, operationOptions = {}, env = this.env, onStdout) {
        if (operationOptions.signal?.aborted) {
            throw createOgrProcessFailure(true, "", null);
        }
        const executable = this.requireExecutable("ogr2ogr");
        await new Promise((resolve, reject) => {
            let child;
            try {
                child = spawn(executable, args, { env, windowsHide: true });
            }
            catch {
                reject(createOgrProcessFailure(false, "Could not start ogr2ogr.", null));
                return;
            }
            let stderr = "";
            let stderrDiagnosticTail = "";
            let hasGdalError = false;
            let progressBuffer = "";
            let lastProgress = -1;
            let cancelled = false;
            let settled = false;
            const finish = (action) => {
                if (settled)
                    return;
                settled = true;
                operationOptions.signal?.removeEventListener("abort", abort);
                action();
            };
            const abort = () => {
                cancelled = true;
                child.kill();
            };
            child.stderr.setEncoding("utf8");
            const parseProgress = (chunk) => {
                progressBuffer = appendTail(progressBuffer, chunk, 256);
                for (const match of progressBuffer.matchAll(/(\d{1,3}(?:\.\d+)?)\s*(?:%|\.\.\.)/g)) {
                    const percent = Number(match[1]);
                    if (Number.isFinite(percent) && percent > lastProgress) {
                        lastProgress = percent;
                        try {
                            operationOptions.onProgress?.(Math.max(0, Math.min(100, percent)));
                        }
                        catch { /* Progress reporting cannot stop the transfer. */ }
                    }
                }
            };
            child.stdout.setEncoding("utf8");
            child.stdout.on("data", (chunk) => {
                onStdout?.(chunk);
                parseProgress(chunk);
            });
            child.stderr.setEncoding("utf8");
            child.stderr.on("data", (chunk) => {
                const diagnosticText = stderrDiagnosticTail + chunk;
                if (hasGdalErrorDiagnostic(diagnosticText))
                    hasGdalError = true;
                stderrDiagnosticTail = diagnosticText.slice(-256);
                stderr = appendTail(stderr, chunk, MAX_STDERR_LENGTH);
                parseProgress(chunk);
            });
            child.once("error", () => finish(() => reject(createOgrProcessFailure(cancelled, stderr, null))));
            child.once("close", (code) => {
                finish(() => {
                    if (cancelled)
                        reject(createOgrProcessFailure(true, stderr, code));
                    else if (code === 0 && hasGdalError)
                        reject(createOgrProcessFailure(false, stderr, code));
                    else if (code === 0) {
                        try {
                            operationOptions.onProgress?.(100);
                        }
                        catch { /* Progress reporting cannot stop the transfer. */ }
                        resolve();
                    }
                    else
                        reject(createOgrProcessFailure(false, stderr, code));
                });
            });
            operationOptions.signal?.addEventListener("abort", abort, { once: true });
            if (operationOptions.signal?.aborted)
                abort();
        });
    }
    assertInputFile(filePath) {
        if (isVirtualZipPath(filePath))
            return;
        if (!existsSync(filePath) || !statSync(filePath).isFile()) {
            throw new Error("GIS input file does not exist: " + filePath);
        }
    }
    requireExecutable(name) {
        const executable = this.resolveExecutable(name);
        if (!executable) {
            throw new Error("GDAL/OGR was not found. Set DBSTUDIO_GDAL_BIN to the GDAL bin directory or add it to PATH.");
        }
        return executable;
    }
    resolveExecutable(name) {
        const extension = process.platform === "win32" ? ".exe" : "";
        const fileNames = [name + extension, name];
        const configured = this.env.DBSTUDIO_GDAL_BIN;
        const candidates = [];
        if (configured) {
            for (const fileName of fileNames)
                candidates.push(path.join(configured, fileName));
        }
        for (const directory of (this.env.PATH || "").split(delimiter).filter(Boolean)) {
            for (const fileName of fileNames)
                candidates.push(path.join(directory, fileName));
        }
        return candidates.find((candidate) => existsSync(candidate)) ?? null;
    }
    readVersion(executable) {
        const result = spawnSync(executable, ["--version"], {
            encoding: "utf8",
            windowsHide: true,
            timeout: 5_000,
        });
        return result.status === 0 ? result.stdout.trim() : null;
    }
}
function openOptionArguments(prepared) {
    return (prepared.openOptions ?? []).flatMap((option) => ["-oo", option]);
}
function preparedGdalOpenOptionArguments(prepared) {
    return (prepared.openOptions ?? []).flatMap((option) => ["--oo", option]);
}
function executeFile(executable, args, env = process.env, signal) {
    return new Promise((resolve, reject) => {
        execFile(executable, args, { encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024, env, signal }, (error, stdout, stderr) => {
            if (error || hasGdalErrorDiagnostic(stderr)) {
                const message = stderr.trim() || "ogrinfo could not inspect the GIS file.";
                reject(new Error(appendMapInfoReadFailureGuidance(message)));
                return;
            }
            resolve({ stdout, stderr });
        });
    });
}
function parseOgrJson(output, operation) {
    try {
        return JSON.parse(output);
    }
    catch {
        throw new Error(`OGR returned invalid JSON while attempting to ${operation}.`);
    }
}
function mapInfoReadFailureGuidance(message) {
    if (/ReadBytes\(\): Attempt to read past end of data block\./i.test(message)) {
        return "GDAL could not complete a MapInfo data-block read. Confirm the TAB file and its companion files come from the same dataset, then reopen and re-export the layer from its source GIS. The metadata feature count does not confirm that all records were read.";
    }
    const coordinateBlock = /Too big nCoordDataSize\s*=\s*(\d+)/i.exec(message);
    if (coordinateBlock) {
        return "GDAL rejected the MapInfo coordinate-block size (" + coordinateBlock[1] + " bytes). Verify the source file set, then reopen and re-export the layer from its source GIS. The metadata feature count does not confirm that complete geometry data was read.";
    }
    return undefined;
}
function appendMapInfoReadFailureGuidance(message) {
    const guidance = mapInfoReadFailureGuidance(message);
    return guidance ? message + "\n\nMapInfo/TAB guidance: " + guidance : message;
}
function hasGdalErrorDiagnostic(message) {
    return /^\s*ERROR\s+\d+\s*:/m.test(message);
}
function createOgrProcessFailure(cancelled, stderr, exitCode) {
    const error = new Error(cancelled ? "ogr2ogr was cancelled." : stderr.trim() || `ogr2ogr failed with exit code ${String(exitCode)}.`);
    Object.assign(error, { cancelled, stderr, exitCode });
    return error;
}
function appendTail(current, chunk, maxLength) {
    const combined = current + chunk;
    return combined.length <= maxLength ? combined : combined.slice(-maxLength);
}
function datasetFeatureCount(info) {
    let total = 0;
    for (const layer of info.layers) {
        if (layer.featureCount === null)
            return null;
        total += layer.featureCount;
    }
    return total;
}
export function companionFileWarnings(filePath, directoryEntries) {
    const extension = path.extname(filePath).toLowerCase();
    const baseName = path.basename(filePath, path.extname(filePath)).toLowerCase();
    const entries = new Set(directoryEntries.map((entry) => entry.toLowerCase()));
    const missing = (suffix) => !entries.has(`${baseName}${suffix}`);
    const warnings = [];
    if (extension === ".shp") {
        if (missing(".shx"))
            warnings.push(`Shapefile sidecar missing: ${baseName}.shx (shape index).`);
        if (missing(".dbf"))
            warnings.push(`Shapefile sidecar missing: ${baseName}.dbf (attribute table).`);
        if (missing(".prj") && missing(".qpj"))
            warnings.push(`Shapefile CRS sidecar missing: ${baseName}.prj/.qpj; specify the source CRS before transforming coordinates.`);
    }
    else if (extension === ".tab") {
        if (missing(".dat"))
            warnings.push(`MapInfo TAB sidecar missing: ${baseName}.dat (attribute data).`);
        if (missing(".map"))
            warnings.push(`MapInfo TAB sidecar missing: ${baseName}.map (geometry data).`);
    }
    return warnings;
}
async function inspectCompanionWarnings(filePath) {
    if (isVirtualZipPath(filePath))
        return [];
    const resolved = path.resolve(filePath);
    const entries = await readdir(path.dirname(resolved));
    return companionFileWarnings(path.basename(resolved), entries);
}
async function invalidDbfUtf8Warning(filePath, sourceEncoding, errorText) {
    if (isVirtualZipPath(filePath) || path.extname(filePath).toLowerCase() !== ".shp" || !sourceEncoding ||
        normalizeTextEncoding(sourceEncoding) !== "UTF-8" || !/(?:utf[\s-]*8|invalid byte sequence)/i.test(errorText)) {
        return undefined;
    }
    try {
        const invalidField = await findInvalidDbfUtf8Field(filePath);
        if (!invalidField)
            return undefined;
        return `DBF record ${invalidField.recordNumber}, field ${invalidField.fieldName}, contains bytes that are invalid UTF-8. Repair or re-export the source; changing the whole-file encoding may corrupt its other attributes.`;
    }
    catch {
        return undefined;
    }
}
function selectSourceLayer(info, requestedName) {
    if (info.layers.length === 0)
        throw new Error("The GIS dataset contains no vector layers.");
    if (requestedName === undefined && info.layers.length > 1) {
        const names = info.layers.map((layer) => layer.name).join(", ");
        throw new Error(`The GIS dataset has multiple layers. Select one with --layer. Available layers: ${names}`);
    }
    const selectedName = requestedName ?? info.layers[0].name;
    if (selectedName.startsWith("-"))
        throw new Error("GIS layer names beginning with '-' cannot be passed safely to OGR.");
    const layer = info.layers.find((candidate) => candidate.name === selectedName);
    if (!layer)
        throw new Error(`GIS source layer was not found: ${selectedName}`);
    return layer;
}
const FIELD_TYPE_CASTS = {
    string: "character(0)",
    integer: "integer",
    integer64: "bigint",
    real: "float",
    date: "date",
    time: "time",
    datetime: "timestamp",
};
export function buildFieldProjectionSql(layer, mappings = [], options = {}) {
    if (mappings.length === 0 && options.stringWidth === undefined && !options.includeGeometry)
        return undefined;
    const bySource = new Map();
    for (const mapping of mappings) {
        if (bySource.has(mapping.source))
            throw new Error(`GIS field mapping is duplicated: ${mapping.source}`);
        if (!layer.fields.some((field) => field.name === mapping.source)) {
            throw new Error(`GIS source field was not found: ${mapping.source}`);
        }
        if (!mapping.target.trim())
            throw new Error(`GIS target field name cannot be empty: ${mapping.source}`);
        if (mapping.targetType && !Object.hasOwn(FIELD_TYPE_CASTS, mapping.targetType)) {
            throw new Error(`GIS target field type is not supported: ${String(mapping.targetType)}`);
        }
        bySource.set(mapping.source, mapping);
    }
    const targets = new Set();
    for (const field of layer.fields) {
        const target = bySource.get(field.name)?.target ?? field.name;
        const normalizedTarget = target.toLocaleLowerCase();
        if (targets.has(normalizedTarget))
            throw new Error(`GIS target field name is duplicated: ${target}`);
        targets.add(normalizedTarget);
    }
    const hasChanges = [...bySource.values()].some((mapping) => mapping.source !== mapping.target || mapping.targetType !== undefined);
    const hasNarrowStringFields = options.stringWidth !== undefined && layer.fields.some((field) => field.type.toLocaleLowerCase("en-US") === "string" && (field.width === undefined || field.width < options.stringWidth));
    if (!hasChanges && !hasNarrowStringFields && !options.includeGeometry)
        return undefined;
    const fields = layer.fields.map((field) => {
        const mapping = bySource.get(field.name);
        const target = mapping?.target ?? field.name;
        const source = quoteIdentifier(field.name);
        const widenString = options.stringWidth !== undefined
            && field.type.toLocaleLowerCase("en-US") === "string"
            && (field.width === undefined || field.width < options.stringWidth);
        const cast = mapping?.targetType
            ? FIELD_TYPE_CASTS[mapping.targetType]
            : widenString ? `character(${options.stringWidth})` : undefined;
        const expression = cast ? `CAST(${source} AS ${cast})` : source;
        return target === field.name && !cast ? expression : `${expression} AS ${quoteIdentifier(target)}`;
    });
    if (options.includeGeometry) {
        const geometryFields = layer.geometryFields?.length
            ? layer.geometryFields
            : layer.geometryType ? [{ name: null, type: layer.geometryType }] : [];
        const names = new Set(layer.fields.map((field) => field.name.toLocaleLowerCase("en-US")));
        for (const geometryField of geometryFields) {
            const source = quoteIdentifier(geometryField.name ?? "geometry");
            let target = geometryField.name ?? "geometry";
            if (names.has(target.toLocaleLowerCase("en-US"))) {
                let suffix = 1;
                do {
                    target = `__dbstudio_geometry_${suffix++}`;
                } while (names.has(target.toLocaleLowerCase("en-US")));
                fields.push(`${source} AS ${quoteIdentifier(target)}`);
            }
            else {
                fields.push(source);
            }
            names.add(target.toLocaleLowerCase("en-US"));
        }
    }
    return `SELECT ${fields.join(", ")} FROM ${quoteIdentifier(layer.name)}`;
}
export function buildGeoJsonStringSubtypeSchemaOverride(layer, mappings = []) {
    const mappedSources = new Set(mappings
        .filter((mapping) => mapping.targetType === "string")
        .map((mapping) => mapping.source));
    const fields = layer.fields
        .filter((field) => mappedSources.has(field.name) && field.subType?.toLocaleUpperCase() === "JSON")
        .map((field) => ({ name: field.name, type: "String", subType: "None" }));
    if (fields.length === 0)
        return undefined;
    return JSON.stringify({ layers: [{ name: layer.name, schemaType: "Patch", fields }] });
}
export function geoJsonJsonSubtypeImportWarning(layer, mappings, errorText) {
    if (!/invalid input syntax for type json/i.test(errorText))
        return undefined;
    const textMappedFields = new Set(mappings
        .filter((mapping) => mapping.targetType === "string")
        .map((mapping) => mapping.source));
    const fields = layer.fields
        .filter((field) => field.subType?.toLocaleUpperCase() === "JSON" && !textMappedFields.has(field.name))
        .map((field) => field.name);
    if (fields.length === 0)
        return undefined;
    const fieldList = fields.slice(0, 8).join(", ");
    const more = fields.length > 8 ? `, and ${fields.length - 8} more` : "";
    return `PostGIS rejected a GeoJSON JSON-subtype value. Unmapped JSON-subtype fields: ${fieldList}${more}. If these fields contain mixed scalar identifiers, explicitly map each affected field to string in the GIS field mapping (CLI: --field-type <field>=string); this stores numbers and other scalar values as text rather than JSON.`;
}
export function buildPostgresNumericColumnTypeOverrides(layer, mappings = []) {
    const mappingBySource = new Map(mappings.map((mapping) => [mapping.source, mapping]));
    const overrides = [];
    const skippedFields = [];
    for (const field of layer.fields) {
        if (field.type.toLocaleLowerCase() !== "real" || !Number.isFinite(field.precision) || (field.precision ?? 0) <= 0)
            continue;
        const mapping = mappingBySource.get(field.name);
        if (mapping?.targetType)
            continue;
        const target = mapping?.target ?? field.name;
        if (!target || /[,=\u0000-\u001f\u007f]/.test(target)) {
            skippedFields.push(target || field.name);
            continue;
        }
        overrides.push(`${target}=NUMERIC`);
    }
    return {
        ...(overrides.length > 0 ? { option: `COLUMN_TYPES=${overrides.join(",")}` } : {}),
        skippedFields,
    };
}
export function buildPostgresColumnTypeOverrides(layer, mappings = []) {
    const mappingBySource = new Map(mappings.map((mapping) => [mapping.source, mapping]));
    const numeric = buildPostgresNumericColumnTypeOverrides(layer, mappings);
    const overrides = [numeric.option?.replace(/^COLUMN_TYPES=/, "")].filter((value) => Boolean(value));
    const numericFields = numeric.option
        ? numeric.option.replace(/^COLUMN_TYPES=/, "").split(",").map((entry) => entry.slice(0, entry.lastIndexOf("=")))
        : [];
    const stringFields = [];
    const skippedFields = [...numeric.skippedFields];
    for (const field of layer.fields) {
        const mapping = mappingBySource.get(field.name);
        if (mapping?.targetType !== "string")
            continue;
        const target = mapping.target || field.name;
        if (!target || /[,=\u0000-\u001f\u007f]/.test(target)) {
            skippedFields.push(target || field.name);
            continue;
        }
        stringFields.push(target);
        overrides.push(`${target}=VARCHAR`);
    }
    return {
        ...(overrides.length ? { option: `COLUMN_TYPES=${overrides.join(",")}` } : {}),
        skippedFields,
        numericFields,
        stringFields,
    };
}
function isOgrProcessFailure(error) {
    return error instanceof Error && "cancelled" in error && "stderr" in error && "exitCode" in error;
}
function makeOperationError(operation, input, output, featureCount, error, signal, env = process.env, warnings) {
    const processFailure = isOgrProcessFailure(error) ? error : undefined;
    let details = processFailure?.stderr || (error instanceof Error ? error.message : String(error));
    if (env.PGPASSWORD)
        details = details.replaceAll(env.PGPASSWORD, "[redacted]");
    const errorLines = details
        .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .map(sanitizeGdalDiagnostic)
        .filter((line) => Boolean(line) && !/^(?:\d{1,3}(?:\.\d+)?\.\.\s*)+\d{0,3}\.?(?:\.\s*)*$/.test(line));
    const primaryDiagnostic = errorLines.find((line) => /^(?:ERROR|FAILURE|Warning)\b/i.test(line))
        ?? errorLines.find((line) => !/^Usage:/i.test(line));
    const failedSamples = [...new Set([...(primaryDiagnostic ? [primaryDiagnostic] : []), ...errorLines.slice(-MAX_FAILURE_SAMPLES)])]
        .slice(0, MAX_FAILURE_SAMPLES);
    const cancelled = Boolean(signal?.aborted || processFailure?.cancelled);
    const actionableWarnings = (warnings ?? []).filter((warning) => /^DBF record \d+, field .+ contains bytes that are invalid UTF-8\./i.test(warning));
    const report = {
        operation,
        status: cancelled ? "cancelled" : "failed",
        input: operation === "export" ? input : resolvedGisInputPath(input),
        output,
        featureCount,
        successfulFeatures: 0,
        failedFeatures: null,
        failedSamples,
        ...(warnings && warnings.length > 0 ? { warnings } : {}),
    };
    const message = cancelled
        ? "GIS operation cancelled. The database import transaction was rolled back or the temporary output was removed."
        : `GIS ${operation} failed${processFailure?.exitCode === null || processFailure?.exitCode === undefined ? "" : ` (ogr2ogr exit ${processFailure.exitCode})`}.${failedSamples.length ? ` ${failedSamples.join(" | ")}` : ""}${actionableWarnings.length ? ` ${actionableWarnings.join(" ")}` : ""}`;
    return new GisOperationError(appendMapInfoReadFailureGuidance(message), report);
}
function sanitizeGdalDiagnostic(line) {
    const payloadMarker = /\b(?:with\s+field\s+values|field\s+values|WKB|geometry\s+data)\b\s*:?/i.exec(line);
    if (payloadMarker?.index !== undefined) {
        const safePrefix = line.slice(0, payloadMarker.index)
            .replace(/\b(feature|record)\s+(?:\d+|0x[\da-f]+)\b/gi, "$1 [index omitted]")
            .trimEnd();
        return `${safePrefix} [record payload omitted]`;
    }
    const maxLength = 1024;
    return line.length > maxLength ? `${line.slice(0, maxLength)}… [diagnostic truncated]` : line;
}
async function assertVectorOutputAvailable(output) {
    const directory = path.dirname(output);
    if (!existsSync(directory) || !statSync(directory).isDirectory()) {
        throw new Error("Output directory does not exist.");
    }
    const baseName = path.basename(output, path.extname(output)).toLowerCase();
    const extension = path.extname(output).toLowerCase();
    const companionSuffixes = extension === ".shp"
        ? SHAPEFILE_COMPANIONS
        : extension === ".tab"
            ? MAPINFO_COMPANIONS
            : extension === ".gpkg"
                ? GEOPACKAGE_COMPANIONS
                : extension === ".csv"
                    ? CSV_COMPANIONS
                    : new Set([extension]);
    const entries = await readdir(directory);
    const collision = entries.find((entry) => {
        const lower = entry.toLowerCase();
        if (!lower.startsWith(`${baseName}.`))
            return false;
        return companionSuffixes.has(lower.slice(baseName.length));
    });
    if (collision)
        throw new Error("Output or one of its companion files already exists. Choose a new path to avoid overwriting data.");
}
async function createTemporaryOutput(output) {
    const directory = await mkdtemp(path.join(path.dirname(output), ".dbstudio-gis-"));
    return { directory, output: path.join(directory, path.basename(output)) };
}
async function commitTemporaryOutput(temporaryDirectory, output) {
    const files = await readdir(temporaryDirectory, { withFileTypes: true });
    if (!files.length || files.some((entry) => !entry.isFile()))
        throw new Error("OGR did not create a valid vector output set.");
    const outputDirectory = path.dirname(output);
    const targets = files.map((entry) => path.join(outputDirectory, entry.name));
    const created = [];
    try {
        for (let index = 0; index < files.length; index += 1) {
            const source = path.join(temporaryDirectory, files[index].name);
            const target = targets[index];
            try {
                await link(source, target);
                created.push(target);
                await unlink(source);
            }
            catch (error) {
                const code = error.code;
                if (code === "EEXIST")
                    throw new Error("Output or one of its companion files was created during export.");
                created.push(target);
                await copyFile(source, target, fsConstants.COPYFILE_EXCL);
                await unlink(source);
            }
        }
        if (!targets.some((target) => path.basename(target).toLowerCase() === path.basename(output).toLowerCase())) {
            throw new Error("OGR did not create the requested vector output file.");
        }
    }
    catch (error) {
        await Promise.all(created.map((file) => unlink(file).catch(() => undefined)));
        throw error;
    }
}
export function appendCrsOptions(args, source, options) {
    const coordinateOperation = options.coordinateOperation?.trim();
    if (coordinateOperation && (!options.targetCrs || /[\u0000-\u001f\u007f]/.test(coordinateOperation) || coordinateOperation.length > 4096)) {
        throw new Error("An explicit coordinate operation requires a target CRS and must be at most 4,096 characters without control characters.");
    }
    const sourceHasCrs = source.layers.some((layer) => layer.crs);
    if (options.targetCrs && !options.sourceCrs && !sourceHasCrs) {
        throw new Error("Source CRS is missing. Specify --source-crs before transforming coordinates.");
    }
    if (options.targetCrs) {
        if (options.sourceCrs)
            args.push("-s_srs", options.sourceCrs);
        args.push("-t_srs", options.targetCrs);
        if (coordinateOperation)
            args.push("-ct", coordinateOperation);
        return;
    }
    if (options.sourceCrs)
        args.push("-a_srs", options.sourceCrs);
}
export function appendGeometryValidityOptions(args, makeValid) {
    if (makeValid)
        args.push("-makevalid");
}
function driverForOutput(output) {
    const extension = path.extname(output).toLowerCase();
    const driver = OUTPUT_DRIVERS[extension];
    if (!driver) {
        throw new Error("Unsupported GIS output extension: " + (extension || "(none)"));
    }
    return driver;
}
export function buildKmlIdAttributeMapping(layer, fieldMappings = []) {
    const idField = layer.fields.find((field) => field.name.toLocaleLowerCase("en-US") === "id" && field.type.toLocaleLowerCase("en-US") === "string");
    if (!idField || fieldMappings.some((mapping) => mapping.source === idField.name))
        return undefined;
    const usedNames = new Set([
        ...layer.fields.map((field) => field.name.toLocaleLowerCase("en-US")),
        ...fieldMappings.map((mapping) => mapping.target.toLocaleLowerCase("en-US")),
    ]);
    let target = "source_id";
    let suffix = 2;
    while (usedNames.has(target.toLocaleLowerCase("en-US"))) {
        target = "source_id_" + suffix;
        suffix += 1;
    }
    return { source: idField.name, target };
}
export function formatConversionWarnings(output, sourceLayers = [], fieldMappings = []) {
    const extension = path.extname(output).toLowerCase();
    const dimensionWarnings = geometryDimensionWarnings(extension, sourceLayers);
    if (extension === ".shp") {
        const warnings = ["Shapefile may truncate field names longer than 10 characters and values beyond DBF field widths; DBF supports Integer, Integer64, Real, String and Date fields."];
        const unsupportedFields = sourceLayers.flatMap((layer) => layer.fields
            .filter((field) => !["Integer", "Integer64", "Real", "String", "Date"].includes(field.type))
            .map((field) => `${field.name} (${field.type})`));
        if (unsupportedFields.length > 0)
            warnings.push(`Check these fields for conversion or omission: ${unsupportedFields.join(", ")}.`);
        if (sourceLayers.some((layer) => layer.geometryType?.includes("GeometryCollection"))) {
            warnings.push("Shapefile cannot store GeometryCollection features.");
        }
        return [...warnings, ...dimensionWarnings];
    }
    if (extension === ".tab") {
        const warnings = [
            "MapInfo TAB supports Integer, Real and String fields; String values beyond the configured field width may be truncated.",
            "MapInfo tables do not represent SQL NULL values; NULL attributes may be written as empty or default values, so their distinction can be lost.",
            "MapInfo TAB coordinates have format-limited precision; using the source extent as bounds can reduce, but not eliminate, coordinate quantization.",
        ];
        const mappedNames = new Map(fieldMappings.map((mapping) => [mapping.source, mapping.target]));
        const incompatibleNames = sourceLayers.flatMap((layer) => layer.fields
            .map((field) => mappedNames.get(field.name) ?? field.name)
            .filter((name) => [...name].length > 31 || !/^[\p{L}_][\p{L}\p{N}_]*$/u.test(name)));
        if (incompatibleNames.length > 0) {
            warnings.push(`MapInfo column names allow at most 31 letters, digits or underscores and cannot start with a digit; GDAL may rewrite or reject these names: ${[...new Set(incompatibleNames)].slice(0, 10).join(", ")}${incompatibleNames.length > 10 ? ", …" : ""}. Rename them with field mapping and verify the exported schema.`);
        }
        const unsupportedFields = sourceLayers.flatMap((layer) => layer.fields
            .filter((field) => !["Integer", "Real", "String"].includes(field.type))
            .map((field) => `${field.name} (${field.type})`));
        if (unsupportedFields.length > 0)
            warnings.push(`Check these fields for conversion: ${unsupportedFields.join(", ")}.`);
        return [...warnings, ...dimensionWarnings];
    }
    if (extension === ".kml") {
        const warnings = ["KML output is always EPSG:4326; GDAL transforms coordinates to WGS 84, so source coordinates and CRS may change."];
        const reservedAttributes = new Set(["extrude", "tessellate", "visibility"]);
        const mappedNames = new Map(fieldMappings.map((mapping) => [mapping.source, mapping.target]));
        const collidingFields = sourceLayers.flatMap((layer) => layer.fields
            .filter((field) => reservedAttributes.has((mappedNames.get(field.name) ?? field.name).toLocaleLowerCase("en-US")))
            .map((field) => mappedNames.get(field.name) ?? field.name));
        if (collidingFields.length > 0) {
            warnings.push(`KML reserves ${[...new Set(collidingFields)].join(", ")} for Placemark properties; GDAL may rename colliding source fields with a numeric suffix. Map them to non-reserved names and verify the exported schema.`);
        }
        for (const layer of sourceLayers) {
            const idField = layer.fields.find((field) => field.name.toLocaleLowerCase("en-US") === "id" && field.type.toLocaleLowerCase("en-US") === "string");
            if (!idField)
                continue;
            const mapping = fieldMappings.find((candidate) => candidate.source === idField.name);
            if (mapping && mapping.target.toLocaleLowerCase("en-US") !== idField.name.toLocaleLowerCase("en-US")) {
                warnings.push("KML uses a string field named id as the Placemark identifier; the source attribute is exported as " + mapping.target + " so its value can round-trip.");
            }
            else {
                warnings.push("KML uses a string field named id as the Placemark identifier; map it to a different output field such as source_id to preserve it as an attribute.");
            }
        }
        return [...warnings, ...dimensionWarnings];
    }
    if (extension === ".dxf") {
        const hasEntityHandle = sourceLayers.some((layer) => layer.fields.some((field) => field.name.toLocaleLowerCase("en-US") === "entityhandle"));
        return [
            "DXF has no OGR georeferencing information; a coordinate transformation changes drawing coordinates but the target CRS is not stored.",
            "DXF is a CAD drawing: GDAL writes supported geometry as drawing entities, and generic database attributes or styling may not be preserved. Verify the exported drawing in a DXF-aware client.",
            ...(hasEntityHandle
                ? ["DXF EntityHandle values are CAD entity identifiers; the driver generates new handles when writing entities, so source handle values do not round-trip. Keep the original identifier in the database if external references depend on it."]
                : []),
            "DXF text follows the driver's code-page behavior (normally ANSI_1252); verify multilingual labels in a DXF-aware client.",
            ...dimensionWarnings,
        ];
    }
    if (extension === ".gpkg") {
        const geometryColumn = geoPackageGeometryColumnName(sourceLayers);
        const fidColumn = geoPackageFidColumnName(sourceLayers);
        return [
            ...(geometryColumn ? [`GeoPackage's default geometry column name "geom" conflicts with a source attribute; the geometry column will be named "${geometryColumn}" to preserve that attribute.`] : []),
            ...(fidColumn ? [`GeoPackage's default feature id column name "fid" conflicts with a source attribute; the feature id column will be named "${fidColumn}" to preserve that attribute.`] : []),
            ...dimensionWarnings,
        ];
    }
    if (extension === ".csv") {
        return ["CSV stores geometry as WKT and writes .prj/.csvt sidecars for CRS and field types; keep those files with the CSV.", ...dimensionWarnings];
    }
    if (extension === ".geojson" || extension === ".json") {
        return ["GeoJSON output uses RFC 7946 WGS 84 longitude/latitude coordinates and writes up to 17 decimal places so finite binary64 coordinates can round-trip; reprojection to WGS 84 may change coordinate values.", ...dimensionWarnings];
    }
    return dimensionWarnings;
}
function hasGeometryDimension(geometryType, dimension) {
    if (!geometryType)
        return false;
    const compact = geometryType.toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (dimension === "Z")
        return /(?:ZM|Z|25D)$/.test(compact) || compact.startsWith("3D") || /\bZ\b/i.test(geometryType);
    return /M$/.test(compact) || compact.includes("MEASURED") || /\bM\b/i.test(geometryType);
}
function geometryDimensionSuffix(geometryType) {
    const hasZ = hasGeometryDimension(geometryType, "Z");
    const hasM = hasGeometryDimension(geometryType, "M");
    if (hasZ && hasM)
        return "ZM";
    if (hasZ)
        return "Z";
    if (hasM)
        return "M";
    return "";
}
function isUnspecifiedGeometryType(geometryType) {
    const compact = geometryType.toUpperCase().replace(/[^A-Z0-9]/g, "");
    return compact === "GEOMETRY" || compact === "GEOMETRYCOLLECTION" || compact.startsWith("UNKNOWN");
}
function formatMapInfoBounds(extent) {
    if (!extent)
        return undefined;
    const values = [extent.minX, extent.minY, extent.maxX, extent.maxY];
    if (!values.every(Number.isFinite) || extent.minX > extent.maxX || extent.minY > extent.maxY)
        return undefined;
    const coordinateScale = Math.max(1, ...values.map((value) => Math.abs(value)));
    const span = Math.max(extent.maxX - extent.minX, extent.maxY - extent.minY);
    const margin = Math.max(span * 1e-8, coordinateScale * 1e-12, 1e-12);
    return [extent.minX - margin, extent.minY - margin, extent.maxX + margin, extent.maxY + margin]
        .map((value) => value.toString())
        .join(",");
}
function geometryDimensionWarnings(extension, sourceLayers) {
    const namesWith = (dimension) => sourceLayers
        .filter((layer) => hasGeometryDimension(layer.geometryType, dimension))
        .map((layer) => layer.name)
        .join(", ");
    const namesWithUnspecifiedDimensions = sourceLayers
        .filter((layer) => layer.geometryType !== null && isUnspecifiedGeometryType(layer.geometryType))
        .map((layer) => layer.name)
        .join(", ");
    const warnings = [];
    if (extension === ".tab") {
        const zLayers = namesWith("Z");
        const mLayers = namesWith("M");
        if (zLayers)
            warnings.push(`MapInfo TAB output is 2D and will drop Z (elevation) ordinates from layers: ${zLayers}.`);
        if (mLayers)
            warnings.push(`MapInfo TAB output does not preserve M (measure) ordinates; those values will be dropped from layers: ${mLayers}.`);
        if (namesWithUnspecifiedDimensions) {
            warnings.push(`MapInfo TAB output is 2D; generic geometry layers may contain Z/M ordinates that will be dropped: ${namesWithUnspecifiedDimensions}.`);
        }
    }
    else if ([".geojson", ".json", ".kml"].includes(extension)) {
        const mLayers = namesWith("M");
        if (mLayers) {
            const target = extension === ".kml" ? "KML" : "GeoJSON";
            warnings.push(`${target} output does not preserve M (measure) ordinates; those values will be dropped from layers: ${mLayers}.`);
        }
        if (namesWithUnspecifiedDimensions) {
            const target = extension === ".kml" ? "KML" : "GeoJSON";
            warnings.push(`${target} output does not preserve M (measure) ordinates; generic geometry layers may contain M values that will be dropped: ${namesWithUnspecifiedDimensions}.`);
        }
    }
    return warnings;
}
function validateGisOutputFormatOptions(output, options, sourceLayers) {
    const datasetCreationOptions = validateDriverCreationOptions(options.datasetCreationOptions, "dataset");
    const layerCreationOptions = validateDriverCreationOptions(options.layerCreationOptions, "layer");
    const extension = path.extname(output).toLowerCase();
    const managedLayerOptions = new Set();
    if (extension === ".csv") {
        managedLayerOptions.add("GEOMETRY");
        managedLayerOptions.add("CREATE_CSVT");
    }
    else if (extension === ".gpkg") {
        if (geoPackageFidColumnName(sourceLayers))
            managedLayerOptions.add("FID");
        if (geoPackageGeometryColumnName(sourceLayers))
            managedLayerOptions.add("GEOMETRY_NAME");
    }
    else if (extension === ".shp") {
        managedLayerOptions.add("ENCODING");
    }
    else if (extension === ".tab" || extension === ".mif") {
        managedLayerOptions.add("ENCODING");
        managedLayerOptions.add("STRICT_FIELDS_NAME_LAUNDERING");
    }
    else if (extension === ".geojson" || extension === ".json") {
        managedLayerOptions.add("RFC7946");
        managedLayerOptions.add("COORDINATE_PRECISION");
    }
    const conflict = layerCreationOptions.find((option) => managedLayerOptions.has(option.name.toUpperCase()));
    if (conflict) {
        throw new Error(`Layer creation option ${conflict.name} is managed by DB Studio for ${extension}; use the dedicated conversion setting.`);
    }
    return { datasetCreationOptions, layerCreationOptions };
}
function validateDriverCreationOptions(options, scope) {
    try {
        return parseGisDriverCreationOptions(options ?? []);
    }
    catch (error) {
        throw new Error(`${scope} ${error instanceof Error ? error.message : "driver creation options are invalid."}`);
    }
}
function appendOutputFormatOptions(args, output, targetEncoding, sourceLayers = [], creationOptions = { datasetCreationOptions: [], layerCreationOptions: [] }) {
    const extension = path.extname(output).toLowerCase();
    const encoding = normalizeTextEncoding(targetEncoding ?? "UTF-8");
    if (extension === ".csv") {
        args.push("-lco", "GEOMETRY=AS_WKT", "-lco", "CREATE_CSVT=YES");
    }
    else if (extension === ".gpkg") {
        const geometryColumn = geoPackageGeometryColumnName(sourceLayers);
        const fidColumn = geoPackageFidColumnName(sourceLayers);
        if (fidColumn)
            args.push("-lco", `FID=${fidColumn}`);
        if (geometryColumn)
            args.push("-lco", `GEOMETRY_NAME=${geometryColumn}`);
    }
    else if (extension === ".shp") {
        args.push("-lco", `ENCODING=${toGdalEncodingName(encoding)}`);
    }
    else if (extension === ".tab" || extension === ".mif") {
        args.push("-lco", `ENCODING=${encoding}`, "-lco", "STRICT_FIELDS_NAME_LAUNDERING=NO");
    }
    else if (extension === ".geojson" || extension === ".json") {
        if (encoding !== "UTF-8")
            throw new Error(`RFC 7946 GeoJSON output uses UTF-8 and cannot use ${encoding}.`);
        args.push("-lco", "RFC7946=YES", "-lco", "COORDINATE_PRECISION=17");
    }
    else if (encoding !== "UTF-8") {
        throw new Error(`${extension || "This"} output format stores text as UTF-8 and cannot use ${encoding}.`);
    }
    for (const option of creationOptions.datasetCreationOptions)
        args.push("-dsco", `${option.name}=${option.value}`);
    for (const option of creationOptions.layerCreationOptions)
        args.push("-lco", `${option.name}=${option.value}`);
}
function geoPackageGeometryColumnName(sourceLayers) {
    const sourceFieldNames = new Set(sourceLayers.flatMap((layer) => layer.fields.map((field) => field.name.toLocaleLowerCase("en-US"))));
    if (!sourceFieldNames.has("geom"))
        return undefined;
    for (let suffix = 1;; suffix += 1) {
        const candidate = suffix === 1 ? "geometry" : `geometry_${suffix}`;
        if (!sourceFieldNames.has(candidate.toLocaleLowerCase("en-US")))
            return candidate;
    }
}
function geoPackageFidColumnName(sourceLayers) {
    const sourceFieldNames = new Set(sourceLayers.flatMap((layer) => layer.fields.map((field) => field.name.toLocaleLowerCase("en-US"))));
    if (!sourceFieldNames.has("fid"))
        return undefined;
    for (let suffix = 2;; suffix += 1) {
        const candidate = `fid_${suffix}`;
        if (!sourceFieldNames.has(candidate.toLocaleLowerCase("en-US")))
            return candidate;
    }
}
function assertStandardOutputCrs(output, targetCrs) {
    const extension = path.extname(output).toLowerCase();
    if (!targetCrs || (extension !== ".geojson" && extension !== ".json" && extension !== ".kml"))
        return;
    const normalized = targetCrs.trim().toUpperCase().replace(/\s+/g, "");
    if (["EPSG:4326", "4326", "CRS84", "OGC:CRS84", "URN:OGC:DEF:CRS:EPSG::4326", "URN:OGC:DEF:CRS:OGC::CRS84"].includes(normalized))
        return;
    throw new Error(`${extension === ".kml" ? "KML" : "RFC 7946 GeoJSON"} output uses WGS 84 (EPSG:4326). Choose EPSG:4326 or leave the target CRS blank.`);
}
function formatLabel(driver, longName) {
    if (driver === "GPKG")
        return "GeoPackage";
    if (driver === "ESRI Shapefile")
        return "Shapefile";
    if (driver === "GeoJSON")
        return "GeoJSON";
    if (driver === "MapInfo File")
        return "MapInfo TAB";
    if (driver === "KML")
        return "KML";
    return longName || driver;
}
function normalizeLayer(input) {
    const layer = recordOf(input);
    const geometryFields = Array.isArray(layer.geometryFields) ? layer.geometryFields : [];
    const geometryField = recordOf(geometryFields[0]);
    const fields = Array.isArray(layer.fields) ? layer.fields : [];
    return {
        name: asString(layer.name) || "layer",
        fidColumnName: typeof layer.fidColumnName === "string" ? layer.fidColumnName : null,
        geometryType: asString(geometryField.type) || asString(layer.geometryType),
        geometryFields: geometryFields.map((item) => {
            const field = recordOf(item);
            return { name: asString(field.name), type: asString(field.type) };
        }),
        crs: normalizeCrs(geometryField.spatialReference ??
            geometryField.coordinateSystem ??
            layer.spatialReference ??
            layer.crs),
        featureCount: asNumber(layer.featureCount ?? layer.feature_count),
        extent: normalizeExtent(layer.extent ?? geometryField.extent),
        fields: fields.map((field) => {
            const item = recordOf(field);
            return {
                name: asString(item.name) || "",
                type: asString(item.type) || "Unknown",
                subType: asString(item.subType) || undefined,
                width: typeof item.width === "number" && Number.isInteger(item.width) && item.width >= 0 ? item.width : undefined,
                precision: typeof item.precision === "number" && Number.isInteger(item.precision) && item.precision >= 0 ? item.precision : undefined,
                nullable: typeof item.nullable === "boolean" ? item.nullable : undefined,
            };
        }),
    };
}
function normalizeCrs(value) {
    if (typeof value === "string")
        return value;
    const outer = recordOf(value);
    const crs = recordOf(outer.projjson ?? outer);
    const id = recordOf(crs.id);
    const authority = asString(id.authority) || asString(crs.authority);
    const code = asIdentifier(id.code) || asIdentifier(crs.code);
    if (authority && code)
        return authority + ":" + code;
    const wkt = asString(outer.wkt) || asString(crs.wkt);
    return wkt || null;
}
function normalizeExtent(value) {
    if (Array.isArray(value) && value.length >= 4) {
        const values = value.slice(0, 4).map(Number);
        if (values.every(Number.isFinite)) {
            return { minX: values[0], minY: values[1], maxX: values[2], maxY: values[3] };
        }
    }
    const extent = recordOf(value);
    const values = [extent.minX ?? extent.xmin, extent.minY ?? extent.ymin, extent.maxX ?? extent.xmax, extent.maxY ?? extent.ymax].map(Number);
    if (values.every(Number.isFinite)) {
        return { minX: values[0], minY: values[1], maxX: values[2], maxY: values[3] };
    }
    return null;
}
function postgresEnvironment(connection, baseEnv) {
    const env = { ...baseEnv };
    if (connection.connectionString) {
        const url = new URL(connection.connectionString);
        if (!/^(postgres|postgresql):$/.test(url.protocol)) {
            throw new Error("PostgreSQL connection URL must use postgres:// or postgresql://.");
        }
        env.PGHOST = url.hostname;
        if (url.port)
            env.PGPORT = url.port;
        if (url.pathname.length > 1)
            env.PGDATABASE = decodeURIComponent(url.pathname.slice(1));
        if (url.username)
            env.PGUSER = decodeURIComponent(url.username);
        if (url.password)
            env.PGPASSWORD = decodeURIComponent(url.password);
        const sslmode = url.searchParams.get("sslmode");
        if (sslmode)
            env.PGSSLMODE = sslmode;
    }
    else {
        if (connection.host)
            env.PGHOST = connection.host;
        if (connection.port)
            env.PGPORT = String(connection.port);
        if (connection.database)
            env.PGDATABASE = connection.database;
        if (connection.user)
            env.PGUSER = connection.user;
        if (connection.password)
            env.PGPASSWORD = connection.password;
        if (connection.ssl)
            env.PGSSLMODE = "require";
    }
    if (!env.PGSSLMODE)
        delete env.PGSSLMODE;
    if (!env.PGDATABASE || !env.PGUSER) {
        throw new Error("PostgreSQL GIS operations require PGDATABASE and PGUSER or a connection URL.");
    }
    return env;
}
function parseTableReference(value) {
    const parts = value.split(".");
    if (parts.length !== 2 || parts.some((part) => !/^[A-Za-z_][A-Za-z0-9_$]*$/.test(part))) {
        throw new Error("Table must use the form schema.table with plain SQL identifiers.");
    }
    return { schema: parts[0], name: parts[1] };
}
function quoteIdentifier(value) {
    return '"' + value.replaceAll('"', '""') + '"';
}
async function countGeometryValues(ogr2ogr, datasetPath, layerName, geometryFields, env) {
    const selections = geometryFields.flatMap((field, index) => {
        const geometry = quoteIdentifier(field.name ?? "geometry");
        const alias = `geometry_${index}`;
        return [
            `COUNT(*) AS ${quoteIdentifier(`${alias}_feature_count`)}`,
            `COALESCE(SUM(CASE WHEN ${geometry} IS NULL THEN 1 ELSE 0 END), 0) AS ${quoteIdentifier(`${alias}_null_count`)}`,
            `COALESCE(SUM(CASE WHEN ST_IsEmpty(${geometry}) THEN 1 ELSE 0 END), 0) AS ${quoteIdentifier(`${alias}_empty_count`)}`,
        ];
    });
    const sql = `SELECT ${selections.join(", ")} FROM ${quoteIdentifier(layerName)}`;
    const { stdout } = await executeFile(ogr2ogr, ["-f", "CSV", "/vsistdout/", datasetPath, "-dialect", "SQLite", "-sql", sql], env);
    const rows = stdout.trim().split(/\r?\n/);
    const expectedColumns = geometryFields.length * 3;
    if (rows.length !== 2 || rows[0].split(",").length !== expectedColumns) {
        throw new Error("GDAL returned an unexpected geometry count summary.");
    }
    const values = rows[1].split(",");
    if (values.length !== expectedColumns || values.some((value) => !/^\d+$/.test(value))) {
        throw new Error("GDAL returned invalid geometry count values.");
    }
    return geometryFields.map((field, index) => {
        const [featureCount, nullGeometryCount, emptyGeometryCount] = values.slice(index * 3, index * 3 + 3).map(Number);
        if ([featureCount, nullGeometryCount, emptyGeometryCount].some((value) => !Number.isSafeInteger(value))) {
            throw new Error("GDAL geometry count exceeds the supported integer range.");
        }
        return { field: field.name, featureCount: featureCount, nullGeometryCount: nullGeometryCount, emptyGeometryCount: emptyGeometryCount };
    });
}
function recordOf(value) {
    return value !== null && typeof value === "object" ? value : {};
}
function asString(value) {
    return typeof value === "string" && value.length > 0 ? value : null;
}
function asNumber(value) {
    if (value === null || value === undefined)
        return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}
function asIdentifier(value) {
    if (typeof value === "string" && value.length > 0)
        return value;
    if (typeof value === "number" && Number.isFinite(value))
        return String(value);
    return null;
}
//# sourceMappingURL=index.js.map