const base = require("./electron-builder.static-gdal-geometry-count-csv-20261112.cjs");

module.exports = {
  ...base,
  directories: {
    ...base.directories,
    output: "release-static-gdal-geos-nsis312-20261113",
  },
  toolsets: {
    nsis: "1.2.1",
  },
};
