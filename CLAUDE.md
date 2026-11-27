# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

DB Studio is a Windows desktop application and CLI tool for database management and GIS vector data ETL. It supports PostgreSQL, MySQL, MariaDB, SQLite, SQL Server, Oracle, and MongoDB with integrated AI-powered SQL assistance, GIS file conversion, and cross-database data transfer.

The desktop app ships with bundled GDAL/OGR and PROJ runtimes for GIS operations without requiring external dependencies.

## Workspace Structure

This is a pnpm monorepo with TypeScript packages:

- **`packages/shared`**: Common types, utilities, and data structures shared across all packages
- **`packages/database`**: Database adapters using `pg`, `mysql2`, `mssql`, `oracledb`, `mongodb`, and Node's built-in `node:sqlite`
- **`packages/gis`**: GDAL/OGR subprocess boundary for vector file inspection, conversion, and PostGIS import/export
- **`packages/ai`**: AI SQL assistant with OpenAI-compatible chat, embedding, and DashScope rerank integration
- **`packages/core`**: Electron-independent orchestration layer that coordinates database, GIS, and AI operations
- **`apps/desktop`**: Electron + React desktop application with IPC handlers in `electron/` and UI in `src/`
- **`apps/cli`**: Commander-based independent CLI that uses Core services directly

Business logic belongs in packages; Electron is not a dependency of Core. Both CLI and desktop call the same Core services.

## Commands

### Development

```powershell
# Install dependencies
pnpm install

# Build all packages (builds in dependency order)
pnpm run build

# Type-check all packages
pnpm run typecheck

# Run all unit tests
pnpm run test

# Start desktop app in development mode
pnpm --filter @db-studio/desktop run dev

# Build Windows MSI installer with bundled GDAL runtime
pnpm --filter @db-studio/desktop run build
pnpm --filter @db-studio/desktop run dist:win:static-gdal-geos-msi-bundled-preload-20261120
```

### Running the CLI

```powershell
# Run CLI during development
pnpm --filter @db-studio/cli run cli -- --help

# CLI commands use environment variables for database credentials
pnpm --filter @db-studio/cli run cli -- connections add --name local-pg --engine postgres --host 127.0.0.1 --port 5432 --database demo --user app --password-env DBSTUDIO_LOCAL_PG_PASSWORD

# Test connection
pnpm --filter @db-studio/cli run cli -- connections test --connection local-pg

# Run query
pnpm --filter @db-studio/cli run cli -- query run --connection local-pg --sql "SELECT current_database()" --format json

# GIS operations require GDAL/OGR in PATH or DBSTUDIO_GDAL_BIN
$env:DBSTUDIO_GDAL_BIN = (Resolve-Path 'apps/desktop/resources/gdal/bin').Path
pnpm --filter @db-studio/cli run cli -- gis inspect --file .\roads.gpkg

# AI SQL assistant (requires explicit --include-schema consent)
pnpm --filter @db-studio/cli run cli -- ai sql generate --connection local-pg --request "find all active users" --include-schema
```

### Integration Tests

There are 82+ integration test scripts in `tests/integration/`. Most require specific database services running (use Docker Compose profiles in `docker/` with credentials in `docker/.env`).

```powershell
# Run specific integration tests
pnpm run test:integration:sqlite-data
pnpm run test:integration:sql
pnpm run test:integration:postgis
pnpm run test:integration:ai-provider

# Run all integration tests (requires all database containers)
pnpm run test:integration:all
```

### Build Individual Packages

```powershell
# Build a specific package
pnpm --filter @db-studio/core run build
pnpm --filter @db-studio/gis run typecheck
pnpm --filter @db-studio/ai run test
```

## Architecture Principles

### Separation of Concerns

- **Database operations**: Adapters in `packages/database` handle vendor-specific SQL and driver quirks. All SQL uses parameterized queries (bind parameters) to prevent injection.
- **GIS operations**: `packages/gis` spawns GDAL/OGR as a subprocess. Feature data streams through the OGR process without accumulating in Node.js memory. PostGIS transfers use OGR's PostgreSQL driver separately from the SQL adapter.
- **Core orchestration**: `packages/core` constructs adapters at operation boundaries and closes them in `finally` blocks. It accepts `AbortSignal` for cancellation and progress callbacks.
- **Entry points**: CLI and Electron IPC handlers both call Core services; Electron is never imported by Core or business packages.

### Database Adapters

Each database adapter exposes:
- Connection testing with environment-based credentials
- Parameterized query execution
- Database/schema/table/column metadata
- Transactional CSV/JSON/XLSX import/export
- Cross-database table transfer (all 30 directions among 6 relational engines verified)

MongoDB uses a separate `MongoDocumentAdapter` and service with native Find/Aggregate, GeoJSON conversion, and `2dsphere` spatial index support.

SQLite uses Node's built-in `node:sqlite` (synchronous API, requires Node ≥22.13) to avoid native addon dependencies.

### GIS Operations

- **Inspection**: Uses `ogrinfo -json -ro -so -al` to read layer metadata (fields, geometry type, CRS, extent, feature count)
- **Import/Export**: Uses `ogr2ogr` with dataset transactions; cancellation rolls back PostGIS imports
- **Field mapping**: Accepts per-field rename and type casting (String, Integer, Integer64, Real, Date, Time, DateTime)
- **CRS transformation**: Delegated to PROJ; missing source CRS must be supplied explicitly
- **Multi-layer files**: User selects one source layer for import
- **Staging**: File exports write to temporary location and move into place only on success

GIS operations report progress via callbacks and clean up on cancellation or failure.

### AI SQL Assistant

The AI assistant generates SQL drafts that are **never automatically executed**. Users review and explicitly run the SQL.

- **Desktop**: Renderer requests AI operations from Main via IPC. Main reads encrypted settings and database schema (with user consent).
- **CLI**: Uses environment variables for model credentials (never persisted in config files)
- **Schema context**: User explicitly enables sending schema; limited to 8 tables, 160 columns, 40 foreign keys per request
- **Security**: Rejects multi-statement SQL, write operations, row-locking reads, and validates column references against schema using AST parsing (PostgreSQL, MySQL, MariaDB, SQLite, SQL Server)
- **PostGIS mode**: Loads PostGIS metadata (`geometry_columns`, function signatures) and enforces CRS/unit validation for measurement operations
- **MongoDB assistant**: Separate Find/Aggregate helper; rejects `$where`, `$function`, `$out`, `$merge`, and other write stages

Encrypted settings use Windows DPAPI (desktop) or Electron `safeStorage` (other platforms). Schema embeddings and rerank are optional enhancements; fallback to keyword matching when unavailable.

### Electron IPC Architecture

Main process (`apps/desktop/electron/main.ts`):
- Registers IPC handlers for database, GIS, and AI operations
- Manages encrypted connection store, query history, and AI settings
- Spawns Core service operations with cancellation support
- Uses `OperationRegistry` to track cancellable operations
- SSH tunnel management via `SshTunnelManager`

Renderer (`apps/desktop/src/`):
- React + Zustand for state management
- Monaco Editor for SQL editing with schema-aware completion
- Ant Design UI components
- TanStack Query for async state
- MapLibre GL for GIS preview maps

Preload script (`apps/desktop/electron/preload.cjs`):
- Bundled with esbuild (not tsc) as CommonJS
- Exposes typed IPC bridge to renderer via `contextBridge`

## Code Conventions

### TypeScript Configuration

- Target: ES2022, Module: NodeNext
- Strict mode enabled
- `verbatimModuleSyntax: true` (requires explicit `type` imports)
- Each package has its own `tsconfig.json` extending `tsconfig.base.json`

### Module Patterns

- Use ES modules (`.ts`/`.js`, not `.cts`/`.mts`)
- Import with explicit `.js` extensions in TypeScript source
- Preload script is the only CommonJS file (`.cjs`) due to Electron requirements

### Error Handling

- Database and GIS operations throw typed errors (e.g., `GisOperationError`)
- Core operations construct adapters in try blocks and close in `finally`
- Cancellation is signaled via `AbortSignal`; operations check signal and clean up on abort
- Integration tests use temporary tables/collections and clean up in `finally` blocks

### Testing

- Unit tests: Vitest, colocated with source as `*.test.ts`
- Integration tests: Standalone `.mjs` scripts in `tests/integration/`
- Integration tests require real database containers (see `docker/README.md`)
- Use temporary/prefixed resources and always clean up in `finally`

## Key Files

- `docs/architecture.md`: High-level architecture overview
- `docs/database-adapters.md`: Database adapter status and capabilities
- `docs/gis-design.md`: GIS operation design and OGR integration
- `docs/ai-sql-assistant.md`: AI assistant architecture and security (Chinese)
- `docs/database-capability-matrix.md`: Feature support by database engine
- `docs/gis-format-matrix.md`: Vector format capabilities and limitations
- `docker/README.md`: Database container setup for development

## Environment Variables

The CLI reads database credentials from environment variables:

```powershell
# General
DBSTUDIO_DATABASE_TYPE=postgres|mysql|mariadb|sqlite|sqlserver|oracle|mongodb
DBSTUDIO_GDAL_BIN=path/to/gdal/bin  # Optional GDAL runtime path

# PostgreSQL
DBSTUDIO_POSTGRES_URL=postgresql://...
# or: PG_HOST, PG_PORT, PG_USER, PG_PASSWORD, PG_DATABASE

# MySQL/MariaDB
DBSTUDIO_MYSQL_URL=mysql://...
# or: MYSQL_HOST, MYSQL_PORT, MYSQL_USER, MYSQL_PASSWORD, MYSQL_DATABASE

# SQLite
DBSTUDIO_SQLITE_PATH=path/to/database.db

# SQL Server
DBSTUDIO_SQLSERVER_URL=mssql://...
# or: SQLSERVER_HOST, SQLSERVER_PORT, SQLSERVER_USER, SQLSERVER_PASSWORD, SQLSERVER_DATABASE

# Oracle
ORACLE_CONNECT_STRING=//host:port/service
# or: ORACLE_HOST, ORACLE_PORT, ORACLE_SERVICE_NAME
ORACLE_USER=username
ORACLE_PASSWORD=password

# MongoDB
DBSTUDIO_MONGODB_URL=mongodb://...
# or: MONGODB_URI
MONGODB_DATABASE=default_database

# AI Models (CLI only)
MODEL_OPENAI_BASE_URL=https://...
MODEL_OPENAI_MODEL=model-name
MODEL_OPENAI_API_KEY=key
MODEL_EMBEDDING_BASE_URL=https://...
MODEL_EMBEDDING_MODEL=embedding-model
MODEL_RERANK_MODEL=rerank-model
```

Desktop app stores encrypted credentials and AI settings in app user data directory; does not read environment variables for credentials.

## Common Patterns

### Adding a Database Feature

1. Add capability declaration to adapter interface in `packages/shared`
2. Implement in database adapter (`packages/database/src/<engine>-adapter.ts`)
3. Add Core service method (`packages/core/src/index.ts`)
4. Add CLI command (`apps/cli/src/index.ts`)
5. Add Electron IPC handler (`apps/desktop/electron/main.ts`)
6. Add renderer UI (`apps/desktop/src/`)
7. Write unit tests in adapter and Core
8. Add integration test script in `tests/integration/`

### Adding a GIS Operation

1. Implement OGR command construction in `packages/gis/src/`
2. Add Core orchestration with progress and cancellation
3. Expose via CLI and desktop IPC
4. Test with real vector files in integration tests

### Working with AI Features

- Schema consent must be explicit (checkbox in UI, `--include-schema` flag in CLI)
- Model credentials are encrypted (desktop) or from environment (CLI)
- All generated SQL is reviewed before execution
- AST parsing validates column references for supported dialects
- MongoDB queries use separate validation (no `$where`, `$function`, write stages)

## Known Constraints

- GDAL optional datum-shift grids not included; configure PROJ data directory if needed
- Shapefile/TAB/KML/GeoJSON have field/type/precision/CRS limitations (documented in operation reports)
- GDAL runtime license audit incomplete for 51 bundled DLLs (see `docs/gdal-runtime.md`)
- SQLite uses synchronous API; long-running queries block the process
- Oracle AST parsing not available; SQL validation is conservative keyword-based only
- Excel import/export have size limits: 50 MiB compressed, 128 MiB expanded, 100K rows, 2K columns

## Windows-Specific Notes

- Desktop builds target Windows with MSI installer (electron-builder)
- GDAL runtime in `apps/desktop/resources/gdal/` is Windows-only
- Encrypted storage uses Windows DPAPI (current user scope)
- Build scripts assume PowerShell environment
- File paths use forward slashes in code; Node.js normalizes automatically

## Git Branch Strategy

Current branch: `main` (default branch for PRs)

Recent commits show iterative MSI installer builds and UI refinements. When making changes:
- Commit related changes together with descriptive messages
- Reference issue numbers if applicable
- Run `pnpm typecheck` and `pnpm build` before committing
- Integration tests require database containers; run relevant tests for affected adapters
