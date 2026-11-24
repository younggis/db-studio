const base = require("./electron-builder.static-gdal-geos-msi-geography-20261121.cjs");

module.exports = {
  ...base,
  directories: {
    ...base.directories,
    output: "release-static-gdal-geos-msi-oracle-index-modes-20261122",
  },
};