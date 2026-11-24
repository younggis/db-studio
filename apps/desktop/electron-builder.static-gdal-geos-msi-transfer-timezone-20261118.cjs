const base = require("./electron-builder.static-gdal-geos-msi-transfer-float-20261118.cjs");

module.exports = {
  ...base,
  directories: {
    ...base.directories,
    output: "release-static-gdal-geos-msi-transfer-timezone-20261118",
  },
};
