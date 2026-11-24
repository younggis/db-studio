const base = require("./electron-builder.static-gdal-geos-msi-bundled-preload-20261120.cjs");

module.exports = {
  ...base,
  directories: {
    ...base.directories,
    output: "release-static-gdal-geos-msi-geography-20261121",
  },
};
