// GeoPackage geometry BLOB codec lives in @db-studio/shared so GIS staging and
// SQLite spatial row transfer share the same implementation.
export { decodeGeoPackageGeometry, encodeGeoPackageGeometry, importColumnTypeFromSqliteDeclaration } from "@db-studio/shared";
//# sourceMappingURL=geopackage.js.map