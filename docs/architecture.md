# Architecture

The repository is a pnpm workspace. Business operations belong in packages and are called by entry points; Electron is not a dependency of Core.

```text
apps/desktop ── Electron IPC ──┐
                              ├── packages/core ── database adapters
apps/cli ─────────────────────┘                └── packages/gis ── GDAL/OGR
```

Initial packages:

- `packages/shared`: public database and result types.
- `packages/database`: database adapters for PostgreSQL, MySQL, MariaDB, SQLite, SQL Server, Oracle, and MongoDB.
- `packages/gis`: GDAL/OGR process boundary, metadata normalization and vector conversion/transfer.
- `packages/core`: Electron-independent orchestration shared by CLI and desktop IPC handlers.
- `apps/cli`: Commander-based independent CLI.
- `apps/desktop`: Electron + React client with isolated IPC for database and GIS operations.

Core operations construct adapters at the boundary and close them in `finally` blocks. SQL parameters are passed to `pg` as bind parameters. GIS format drivers remain separate from database drivers; PostGIS transfer uses OGR's PostgreSQL driver. CRS transformations are delegated to GDAL/PROJ, and a missing source CRS must be supplied before a requested transformation.

GIS conversion and transfer run in the OGR subprocess, so feature data does not accumulate in the Node.js process. Core accepts an `AbortSignal` and progress callback. CLI connects Ctrl+C to cancellation and writes progress to stderr. Electron relays progress over IPC and scopes cancellation to the initiating renderer. File exports are staged beside their destination and moved into place only after OGR completes; cancellation and failure clean the staging directory. PostGIS imports use a dataset transaction so cancellation rolls back the import.

For multi-layer vector files, the import caller selects one source layer. The GIS service passes that layer to OGR and derives the report count and CRS validation from the same layer; CLI exposes `gis import --layer <name>`, and the desktop form exposes the inspected layer list.

## Runtime and capability boundary

The CLI currently reads database credentials from engine-specific environment variables or URLs and does not persist passwords. The desktop selects the staged Windows GDAL/PROJ runtime when available, while CLI users can configure `DBSTUDIO_GDAL_BIN`. Current capability status is maintained in the database and GIS matrices; the Windows runtime's transitive dependency license audit remains open before external redistribution.
