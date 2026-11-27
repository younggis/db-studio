const base = require("./electron-builder.static-gdal-geos-msi-workbench-final-20261126.cjs");

module.exports = {
  ...base,
  directories: {
    ...base.directories,
    output: "release-static-gdal-geos-msi-features-20261127",
  },
};
