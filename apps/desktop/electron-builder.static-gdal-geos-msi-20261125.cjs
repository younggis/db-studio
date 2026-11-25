const base = require("./electron-builder.static-gdal-geos-msi-connmenu-20261124.cjs");

module.exports = {
  ...base,
  directories: {
    ...base.directories,
    output: "release-static-gdal-geos-msi-20261125",
  },
};
