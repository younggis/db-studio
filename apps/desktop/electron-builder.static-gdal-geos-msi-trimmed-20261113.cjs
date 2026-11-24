const base = require("./electron-builder.static-gdal-geos-msi-manufacturer-20261114.cjs");

module.exports = {
  ...base,
  directories: {
    ...base.directories,
    output: "release-static-gdal-geos-msi-trimmed-20261113",
  },
  files: [
    ...base.files,
    "!**/*.map",
    "!**/*.test.*",
    "!**/*.spec.*",
    "!**/cpu-features/deps/**",
    "!**/cpu-features/build/deps/**",
    "!**/cpu-features/build/Release/obj/**",
    "!**/cpu-features/build/**/*.tlog/**",
    "!**/cpu-features/build/**/*.vcxproj*",
    "!**/cpu-features/build/**/*.lib",
    "!**/cpu-features/build/**/*.iobj",
    "!**/cpu-features/build/**/*.ipdb",
    "!**/cpu-features/build/**/*.recipe",
  ],
};
