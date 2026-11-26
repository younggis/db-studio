const base = require("./electron-builder.static-gdal-geos-msi-appsrc-20261126.cjs");

module.exports = {
  ...base,
  directories: {
    ...base.directories,
    output: "release-static-gdal-geos-msi-workbench-complete-20261126",
  },
};
