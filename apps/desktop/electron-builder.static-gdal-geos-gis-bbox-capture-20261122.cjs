const base = require("./electron-builder.static-gdal-geos-msi-gis-bbox-20261122.cjs");

module.exports = {
  ...base,
  directories: {
    ...base.directories,
    output: "release-static-gdal-geos-gis-bbox-capture-20261122",
  },
  // Local REA acceptance only; never use this build as a distributable.
  electronFuses: {
    ...base.electronFuses,
    enableNodeCliInspectArguments: true,
  },
};
