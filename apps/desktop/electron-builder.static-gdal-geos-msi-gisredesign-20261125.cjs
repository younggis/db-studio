const base = require("./electron-builder.static-gdal-geos-msi-quitfix-20261125.cjs");

module.exports = {
  ...base,
  directories: {
    ...base.directories,
    output: "release-static-gdal-geos-msi-gisredesign-20261125",
  },
};
