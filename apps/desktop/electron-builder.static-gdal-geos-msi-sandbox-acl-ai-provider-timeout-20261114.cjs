const base = require("./electron-builder.static-gdal-geos-msi-hardened-20261114.cjs");

module.exports = {
  ...base,
  directories: {
    ...base.directories,
    output: process.env.DBSTUDIO_MSI_OUTPUT_DIR
      ?? "release-static-gdal-geos-msi-sandbox-acl-ai-provider-timeout-20261114",
  },
  files: [
    ...base.files,
    "!**/*.tlog/**",
    "!**/*.lastbuildstate",
  ],
  msiProjectCreated: require("./msi-sandbox-access-hook.cjs"),
};
