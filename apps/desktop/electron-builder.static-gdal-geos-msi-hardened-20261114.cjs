const base = require("./electron-builder.static-gdal-geos-msi-manufacturer-20261114.cjs");

module.exports = {
  ...base,
  directories: {
    ...base.directories,
    output: "release-static-gdal-geos-msi-hardened-20261114",
  },
  electronFuses: {
    runAsNode: false,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
    // The app still serves its renderer from file://; preserve its current behavior.
    grantFileProtocolExtraPrivileges: true,
  },
};
