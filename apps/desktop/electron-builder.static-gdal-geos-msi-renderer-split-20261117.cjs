const base = require("./electron-builder.static-gdal-geos-msi-postgis-mvt-20261117.cjs");

module.exports = {
  ...base,
  directories: {
    ...base.directories,
    output: "release-static-gdal-geos-msi-renderer-split-20261117",
  },
};
