const base = require("./electron-builder.static-gdal-geos-msi-hardened-20261114.cjs");

module.exports = {
  ...base,
  directories: {
    ...base.directories,
    output: "release-static-gdal-geos-msi-sandbox-acl-20261114",
  },
  msiProjectCreated: require("./msi-sandbox-access-hook.cjs"),
};
