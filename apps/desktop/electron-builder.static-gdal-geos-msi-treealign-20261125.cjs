const base = require("./electron-builder.static-gdal-geos-msi-mongoredesign-20261125.cjs");

module.exports = {
  ...base,
  directories: {
    ...base.directories,
    output: "release-static-gdal-geos-msi-treealign-20261125",
  },
};
