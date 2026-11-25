const base = require("./electron-builder.static-gdal-geos-msi-p0-complete-20261125.cjs");

module.exports = {
  ...base,
  directories: {
    ...base.directories,
    output: "release-static-gdal-geos-msi-workbench-20261126",
  },
};
