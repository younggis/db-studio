const base = require("./electron-builder.static-gdal-geos-msi-goal-20261126.cjs");

module.exports = {
  ...base,
  directories: {
    ...base.directories,
    output: "release-static-gdal-geos-msi-adoption-20261126",
  },
};
