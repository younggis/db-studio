const fs = require("node:fs");
const path = require("node:path");
const packageJson = require("./package.json");

const gdalSource = path.resolve(__dirname, "../../.cache/gdal-static-candidate-20261101");
if (!fs.existsSync(path.join(gdalSource, "bin", "ogr2ogr.exe"))) {
  throw new Error(`Static GDAL candidate is missing: ${gdalSource}`);
}

module.exports = {
  ...packageJson.build,
  directories: {
    ...packageJson.build.directories,
    output: "release-static-gdal",
  },
  extraResources: [
    {
      from: gdalSource,
      to: "gdal",
      filter: ["**/*"],
    },
    ...require("./electron-builder.monaco-resources.cjs"),
  ],
};
