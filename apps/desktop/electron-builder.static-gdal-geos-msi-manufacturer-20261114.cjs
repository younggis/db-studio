const base = require("./electron-builder.static-gdal-geos-msi-20261113.cjs");

module.exports = {
  ...base,
  directories: {
    ...base.directories,
    output: "release-static-gdal-geos-msi-manufacturer-20261114",
  },
};
