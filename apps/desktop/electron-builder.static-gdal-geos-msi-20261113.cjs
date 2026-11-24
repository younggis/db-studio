const base = require("./electron-builder.static-gdal-geometry-count-csv-20261112.cjs");

module.exports = {
  ...base,
  directories: {
    ...base.directories,
    output: "release-static-gdal-geos-msi-renderer-split-20261113",
  },
  win: {
    ...base.win,
    icon: "resources/dbstudio.ico",
    target: ["msi"],
  },
  files: [
    ...base.files,
    "!**/oracledb/build/Release/*-darwin-*.node",
    "!**/oracledb/build/Release/*-linux-*.node",
    "!**/oracledb/build/Release/*-win32-arm64.node",
  ],
};
