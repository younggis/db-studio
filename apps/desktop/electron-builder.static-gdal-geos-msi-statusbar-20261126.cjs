const base = require("./electron-builder.static-gdal-geos-msi-bridge-20261126.cjs");

module.exports = {
  ...base,
  directories: {
    ...base.directories,
    output: "release-static-gdal-geos-msi-statusbar-20261126",
  },
};
