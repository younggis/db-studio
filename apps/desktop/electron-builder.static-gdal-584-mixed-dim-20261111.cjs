const base = require("./electron-builder.static-gdal-584-current-20261111.cjs");

module.exports = {
  ...base,
  directories: {
    ...base.directories,
    output: "release-static-gdal-liblzma-5.8.4-mixed-dim-r1-20261111",
  },
};
