const base = require("./electron-builder.static-gdal-geos-msi-current-20261119.cjs");

module.exports = {
  ...base,
  directories: {
    ...base.directories,
    output: "release-static-gdal-geos-msi-utf8-tail-repair-20261120",
  },
};
