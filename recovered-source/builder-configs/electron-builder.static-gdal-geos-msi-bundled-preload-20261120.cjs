const base = require("./electron-builder.static-gdal-geos-msi-current-20261119.cjs");

module.exports = {
  ...base,
  directories: {
    ...base.directories,
    output: "release-static-gdal-geos-msi-bundled-preload-20261120",
  },
};