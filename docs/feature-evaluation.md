# Feature evaluation

This release is a focused database and GIS ETL tool, not a replacement for Navicat or QGIS. The priorities below combine the project tasks with read-only research of the locally installed Navicat Premium 16.3.9 and QGIS 3.44.8.

## Scope decisions

| Area | Decision | Reason |
|---|---|---|
| Connection management, object browsing, SQL editing and execution, relational and MongoDB workflows | P0 | These are the core daily database tasks and establish the value of a cross-database client. Keep database-specific behavior behind shared Core services. |
| CSV, Excel and JSON import/export | P0 | These are common interchange paths and should use the same transfer services from the desktop client and CLI. |
| Shapefile, GeoJSON, KML, MapInfo TAB and GeoPackage | P0 | These are the first requested GIS formats. Use the selected GDAL/OGR runtime instead of reimplementing format parsers. Preserve explicit encoding, CRS, geometry and lossy-conversion behavior. |
| PostGIS import/export and spatial query workflows | P0 | PostGIS is the first spatial database target and the reference for real database round-trip validation. |
| Electron + React desktop client, independent CLI and shared Core | P0 | Both entry points are required. Shared services keep connection, SQL, transfer and GIS behavior consistent. |
| Table editing, SQL completion, history, SSH, search, lightweight map preview and range import | P1 | These improve daily usability after the query and ETL paths are reliable. Map preview remains intentionally small and does not require a general-purpose GIS canvas. |
| Full ER/model editor, visual SQL builder, schema/data synchronization, scheduled backup, BI dashboards, monitoring and administration suites | P2 | Navicat documents these as broad product areas, but they add substantial surface area beyond the first release's query and GIS ETL goals. Do not create placeholder pages or speculative APIs. |
| Full QGIS desktop, arbitrary provider parity, web map services, 3D GIS and the complete QGIS Processing catalog | Out of scope | QGIS is a reference for proven GIS workflows and provider boundaries. Implement a provider or operation only when it is required by the product tasks and has a concrete validation case. |

## What the local products suggest

The Navicat Premium 16 manual groups its workflows around connections and database objects, data viewing, SQL queries, models, import/export, data transfer and synchronization, charts and dashboards, automation, backup/restore, and server security. This confirms that the useful first-release subset is the connection/object/query/data-transfer core. The larger model, BI, synchronization, scheduling, backup and administration areas remain P2. The local manual includes edition-specific feature labels; the installed product identity does not establish which license entitlements are active.

QGIS 3.44 documentation describes a broader GIS application: database browsing and map-layer loading, DB Manager, spatial database connections, OGC services, and processing tools. Its documented spatial database set includes PostgreSQL, SpatiaLite, GeoPackage, Oracle Spatial and MS SQL Server. The local installation also contains provider paths for PostgreSQL, Oracle, SQL Server, SpatiaLite, WMS/WFS/WCS, ArcGIS, virtual layers, GPX, delimited text, PDAL and GRASS. These observations justify treating GDAL/OGR, CRS handling and PostGIS round trips as first-class engineering concerns; they do not require reproducing QGIS's full provider or algorithm catalog.

The design takeaway is to reuse familiar navigation patterns and validated data-processing boundaries while keeping DB Studio's own interface and independent GDAL/PROJ runtime. Do not infer workflow behavior from a DLL name or package inventory. QGIS components and source are not copied into the application; runtime distribution and license obligations are tracked separately in the GDAL static-runtime review.

## Research evidence and limits

- Local Navicat identity: Premium 16.3.9, executable SHA-256 `2A52A1519C75844FC1BD7D19326EE1B6C7FB847564BBB832124340559734AAC4`. REA directory inventory `ev_ed38435fd225048fe087763ea5a37d647c2804008327155db661dae931e5fddd`; retained file views `ev_a8616412bca3308fe94c7a1d6c02a3edb4322ec56c54a19172074ab37c3d7f3a` and `ev_269216165ddd8cad37177c16a440444641908e0da865e92c6155dae7e0667339`.
- Local QGIS identity: 3.44.8. REA install directory enumeration: 8,175 entries, complete within the directory view; file probing remains partial because of the 32 MiB representation budget. Evidence `ev_41d51bc173d408ee08a7c1cd3e203b015877eb1a9fc50cac3f6f29dd6ef2374e`; provider-directory view `ev_94c07a4d5b13269e876e1490eb66e39acc7f849ccda9219d926090e5f1cc1ade`.
- The local Navicat PDF manual is `C:\Program Files\PremiumSoft\Navicat Premium 16\navicat.pdf`. The current Navicat website and feature matrix describe a newer product surface and edition matrix; they are context, not proof of the installed 16.3.9 build's enabled features.
- Official references: [Navicat Premium product page](https://www.navicat.com/en/products/navicat-premium.html), [Navicat Premium feature matrix](https://www3.navicat.com/en/products/navicat-premium-feature-matrix), [QGIS 3.44 data sources and DB Manager](https://docs.qgis.org/3.44/en/docs/user_manual/managing_data_source/opening_data.html), and [QGIS 3.44 supported data and PostgreSQL workflows](https://docs.qgis.org/3.44/en/docs/user_manual/managing_data_source/supported_data.html).
- REA inventories and PE imports establish package paths and static dependencies, not loaded code, runtime call paths or successful feature execution. Navicat's saved profiles and database connections were not accessed. See [reverse-analysis notes](reverse-analysis.md) for evidence details and unknowns.

The implementation must report only capabilities backed by code and focused validation; product comparison is a source of scope decisions, not a substitute for acceptance evidence.
