const base = require("./electron-builder.static-gdal-geos-nsis312-20261113.cjs");

module.exports = {
  ...base,
  directories: {
    ...base.directories,
    output: "release-static-gdal-geos-nsis-sandbox-acl-20261114",
  },
  nsis: {
    ...base.nsis,
    include: "build/installer.nsh",
  },
};
