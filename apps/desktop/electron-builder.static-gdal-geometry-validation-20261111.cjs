const fs = require("node:fs");
const path = require("node:path");
const packageJson = require("./package.json");

const gdalSource = path.resolve(__dirname, "../../.cache/gdal-static-candidate-20261111-geos-geometry-validation");
if (!fs.existsSync(path.join(gdalSource, "bin", "gdal.exe")) || !fs.existsSync(path.join(gdalSource, "bin", "ogr2ogr.exe"))) {
  throw new Error(`GEOS-enabled static GDAL candidate is missing required tools: ${gdalSource}`);
}

module.exports = {
  ...packageJson.build,
  directories: {
    ...packageJson.build.directories,
    output: "release-static-gdal-geometry-validation-20261111",
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
