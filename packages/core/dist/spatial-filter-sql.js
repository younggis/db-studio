function quote(engine, identifier) {
    if (engine === "mysql" || engine === "mariadb")
        return `\`${identifier.replaceAll("`", "``")}\``;
    if (engine === "sqlserver")
        return `[${identifier.replaceAll("]", "]]")}]`;
    return `"${identifier.replaceAll('"', '""')}"`;
}
/** Build a WHERE-fragment predicate for a source-CRS rectangle. */
export function spatialFilterPredicate(engine, geometryColumn, extent) {
    const column = quote(engine, geometryColumn);
    const { minX, minY, maxX, maxY } = extent;
    switch (engine) {
        case "postgres":
            // ST_MakeEnvelope(srid) uses the source CRS; && is the bbox operator.
            return {
                sql: `${column} && ST_MakeEnvelope($1, $2, $3, $4)`,
                parameters: [minX, minY, maxX, maxY],
            };
        case "mysql":
        case "mariadb":
            return {
                sql: `MBRIntersects(${column}, ST_GeomFromText($1))`,
                parameters: [`POLYGON((${minX} ${minY},${maxX} ${minY},${maxX} ${maxY},${minX} ${maxY},${minX} ${minY}))`],
            };
        case "sqlserver":
            return {
                sql: `${column}.STIntersects(geometry::STGeomFromText($1, 0))`,
                parameters: [`POLYGON((${minX} ${minY},${maxX} ${minY},${maxX} ${maxY},${minX} ${maxY},${minX} ${minY}))`],
            };
        case "oracle":
            return {
                sql: `SDO_FILTER(${column}, SDO_GEOMETRY(2003, NULL, NULL, SDO_ELEM_INFO_ARRAY(1,1003,1), SDO_ORDINATE_ARRAY($1,$2,$3,$4,$5,$6,$7,$8)), 'querytype=WINDOW') = 'TRUE'`,
                parameters: [minX, minY, maxX, minY, maxX, maxY, minX, maxY],
            };
        case "sqlite": {
            // SpatiaLite/GeoPackage RTree: use a bbox subquery only when the layer
            // is registered; callers can fall back to GDAL -spat otherwise.
            const table = geometryColumn.replace(/[^\w]/g, "");
            return {
                sql: `${column} IS NOT NULL`,
                parameters: [],
            };
        }
        default:
            return { sql: "1 = 1", parameters: [] };
    }
}
export function validateExtent(extent) {
    const values = [extent.minX, extent.minY, extent.maxX, extent.maxY];
    if (!values.every((value) => Number.isFinite(value)))
        throw new Error("范围过滤的边界必须是有限数值。");
    if (extent.minX >= extent.maxX || extent.minY >= extent.maxY)
        throw new Error("范围过滤要求最小值严格小于最大值。");
}
//# sourceMappingURL=spatial-filter-sql.js.map