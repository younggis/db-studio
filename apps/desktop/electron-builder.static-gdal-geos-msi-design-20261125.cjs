const base = require("./electron-builder.static-gdal-geos-msi-20261125.cjs");

module.exports = {
  ...base,
  directories: {
    ...base.directories,
    output: "release-static-gdal-geos-msi-design-20261125",
  },
};
