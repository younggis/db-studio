const base = require("./electron-builder.static-gdal-584.cjs");

module.exports = {
  ...base,
  directories: {
    ...base.directories,
    output: "release-static-gdal-liblzma-5.8.4-ai-contract",
  },
};
