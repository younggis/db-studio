const packageJson = require("./package.json");

module.exports = {
  ...packageJson.build,
  directories: {
    ...packageJson.build.directories,
    output: "release-static-gdal-geos-nsis-oracle-spatial-index-20261122",
  },
  nsis: {
    ...packageJson.build.nsis,
    include: "build/installer.nsh",
  },
  toolsets: {
    nsis: "1.2.1",
  },
};
