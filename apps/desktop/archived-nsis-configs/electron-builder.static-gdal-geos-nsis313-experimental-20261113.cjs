const base = require("./electron-builder.static-gdal-geometry-count-csv-20261112.cjs");

module.exports = {
  ...base,
  directories: {
    ...base.directories,
    output: "release-static-gdal-geos-nsis313-experimental-20261113",
  },
  files: [
    ...(base.files ?? []),
    "!**/oracledb/build/Release/*-darwin-*.node",
    "!**/oracledb/build/Release/*-linux-*.node",
  ],
};
