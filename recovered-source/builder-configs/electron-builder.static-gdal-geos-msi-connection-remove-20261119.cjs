const packageJson = require("./package.json");

module.exports = {
  ...packageJson.build,
  directories: {
    ...packageJson.build.directories,
    output: "release-static-gdal-geos-msi-connection-remove-20261119",
  },
  win: {
    ...packageJson.build.win,
    icon: "resources/dbstudio.ico",
    target: ["msi"],
  },
  files: [
    ...packageJson.build.files,
    "!**/oracledb/build/Release/*-darwin-*.node",
    "!**/oracledb/build/Release/*-linux-*.node",
    "!**/oracledb/build/Release/*-win32-arm64.node",
    "!**/*.tlog/**",
    "!**/*.lastbuildstate",
  ],
  electronFuses: {
    runAsNode: false,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
    grantFileProtocolExtraPrivileges: true,
  },
  msiProjectCreated: require("./msi-sandbox-access-hook.cjs"),
};