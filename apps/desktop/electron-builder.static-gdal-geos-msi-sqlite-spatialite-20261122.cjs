const base = require("./electron-builder.static-gdal-geos-msi-gis-bbox-20261122.cjs");

module.exports = {
  ...base,
  directories: {
    ...base.directories,
    output: "release-static-gdal-geos-msi-sqlite-spatialite-20261122",
  },
};
