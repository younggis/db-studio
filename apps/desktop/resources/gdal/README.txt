DB Studio GDAL/PROJ runtime (Windows x64)

GDAL/OGR 3.12.2 command line tools and their imported DLL dependencies are staged from the QGIS 3.44.8 Windows distribution. The QGIS application itself is not included. The five required vector drivers and the PostgreSQL/PostGIS driver were verified in ogrinfo --formats.

GDAL data files are in data/. PROJ resources include the CRS database and configuration in proj/. Optional PROJ datum-shift grid files are not included to keep the application package compact; transformations requiring those grids need a user-provided PROJ_DATA directory.

See licenses/GDAL-LICENSE.TXT and licenses/PROJ-COPYING. Versioned OSGeo4W license notices for 35 of the 36 bundled runtime packages are in licenses/osgeo4w/; the matched snapshot did not provide an msvcrt2019 license sidecar. See runtime-manifest.json and docs/gdal-dependency-inventory.csv for file-level hashes and package/source metadata. Exact license identifiers, Microsoft CRT terms and complete corresponding-source obligations remain under review; do not externally redistribute this runtime until that review is complete.

