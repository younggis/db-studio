const base = require("./electron-builder.static-gdal-geos-electron-capture-20261117.cjs");

module.exports = {
  ...base,
  directories: {
    ...base.directories,
    output: "release-static-gdal-geos-electron-capture-node-options-20261117",
  },
  // Local REA acceptance only; never use this build as a distributable.
  electronFuses: {
    ...base.electronFuses,
    enableNodeOptionsEnvironmentVariable: true,
  },
};
