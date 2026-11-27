# AGENTS.md — DB Studio

Repo-specific instructions for coding agents. Verify against the files cited below before acting; commands here are taken from executable configuration, not prose.

## Toolchain (verified: `package.json`, `.github/workflows/ci.yml`, `pnpm-lock.yaml`)

- pnpm monorepo: `pnpm@10.33.0`, Node `>=22.13` (CI pins 22.13). Workspaces = `apps/*`, `packages/*` (`pnpm-workspace.yaml`).
- CI `verify` job runs, in order: `pnpm install --frozen-lockfile` → `pnpm typecheck` → `pnpm build` → `pnpm test`. Integration is a separate Docker job (`needs: verify`).
- Full local gate used in this repo also includes desktop E2E:
  ```powershell
  pnpm test; pnpm typecheck; pnpm build; pnpm --filter @db-studio/desktop run test:e2e
  ```
- Package scripts are recursive/sorted (`pnpm --recursive --sort --if-present run <script>`); to run one package use `pnpm --filter @db-studio/<pkg> run <script>`.
- SQL shared config: `tsconfig.base.json` → ES2022, NodeNext, `strict`, `verbatimModuleSyntax` (explicit `type` imports, `.js` extensions in source). Preload `electron/preload.cjs` is the only CJS file, built by esbuild (`build:preload`) — not tsc.

## Architecture boundaries (`CLAUDE.md`, `docs/architecture.md`)

- Business logic lives in `packages/*`; `apps/cli` and `apps/desktop/electron/main.tsx` both call the same Core services. Electron is never imported by Core or other business packages. Adapters construct in `try`, close in `finally`, accept `AbortSignal`; all SQL parameterized.
- GIS = OGR/GDAL subprocess boundary; renderer data always crosses `window.dbStudio.*` IPC. AI drafts are never auto-executed.

## Desktop UI: non-obvious overlay architecture (read before touching renderer)

This is the part most likely to be broken by a well-intentioned refactor. The shipped Vite entry imports a preserved compiled chunk that boots its own React/QueryClient provider:

- `apps/desktop/src/main.tsx` imports `./vendor/index-CLh2VPBN.js` **as a side effect** (one dispatcher), then mounts phase-3 pages in **separate** React roots (`Phase3Launcher`, `GisPageOverlay`). Do not add a second `QueryClientProvider` around the compiled app and do not remove the side-effect import.
- `apps/desktop/vite.config.ts` aliases `react`, `react-dom`, `react/jsx-runtime`, `react/jsx-dev-runtime` to `src/*-compat.ts` shims so reconstructed TSX shares the vendor chunk's React instance. Keep these aliases until every vendor chunk is source-ized.
- Whole-page replacement is done with **body-level fixed overlays**, not mutation of React-owned DOM: mount overlay roots under `body`, hide compiled nodes with a body class. Never inject nodes into React-managed containers.
- Overlay roots must not eat clicks elsewhere: `#sql-wb-overlay-root { pointer-events: none }` plus `:has(.sql-workbench) { pointer-events: auto }`.
- Replacing `App-D3avBeWb.js` wholesale fails (exports consumed by other vendor chunks; entry shim → React error #130). SQL page is source-ized via `SqlWorkbenchPage.tsx` / `SqlWorkbenchOverlay` instead. Connection cards stay compiled for E2E compatibility.
- Shared primitives live in `apps/desktop/src/workbench/Workbench.tsx`: `WbWorkbench`, `WbToolbar`, `WbToolbarGroup`, `WbToolButton`, `WbDataTable`, `WbTreeSidebar`, `WbTabContainer`, `WbInspector`, `WbStatusBar`. Authoritative tokens are `apps/desktop/src/workbench-theme.css` (`wb-*`). `WbToolButton` renders its icon once — do not re-add it.
- SQL sidebar is one vertical column (connections above object browser). Object tree is stacked via `--sql-tree-top`, computed from the compiled connection list bottom in `CompiledWorkbenchBridge.tsx`. GIS page cards are full-width (`max-width: none`).

## E2E contract (`apps/desktop/e2e/core-journeys.spec.ts`, `playwright.config.ts`)

- `pnpm --filter @db-studio/desktop run test:e2e` → Playwright attaches over CDP at `http://127.0.0.1:9222`; it launches `.cache/electron-rea-dev-runtime-20261117/electron.exe` (override with `DBSTUDIO_E2E_ELECTRON`) with `--remote-debugging-port=9222`. Port 9222 must be free; tests are serial (`workers: 1`).
- Selectors/values asserted by E2E — preserve or update the spec together with any change: `.connection-card` (count 7), `.connection-select`, `.conn-ctx-item`, `.sql-workbench`, `.object-tree`, `.tree-filter-kbd` (`⌘P`), tree metrics (row `28px`, arrow `16px`, icon slot `16px`, gap `6px`), `.panel-toolbar.wb-toolbar`, `.wb-statusbar` (`24px`), `.wb-app.mongo-page`, `.wb-app.gis-exchange`, `.phase3-launcher`, `.gx-dropzone`, `.mongo-*`.
- SQL editor supports multiple query windows: `.wb-query-tabs` (antd `type="editable-card"`, its `onEdit(keyOrEvent, action)` arg order) plus a `新建查询` toolbar button. Each window in `SqlWorkbenchPage.tsx` owns its SQL text, result, error, busy state **and database context (connection/schema/inspected table)**; the single object browser follows the active window, so switching windows never requires re-selecting a database. A `MutationObserver` maps the compiled left connection-card selection into the active window; keep it one-way to avoid loops. Keep the overlay mounts in `main.tsx` (`SqlWorkbenchOverlay`, `CompiledWorkbenchBridge`) — without them the compiled single-buffer editor is what runs.
- SQL editor and results are vertical panes (`.wb-sql-split`, `.wb-sql-splitter`, `.wb-results`), **not tabs**; splitter share persists in `localStorage:db-studio:sql-editor-share`. The object tree's right-click menu only appears when `DatabaseObjectTree` receives `getContextMenuItems` — `SqlWorkbenchPage` supplies it (new query / test connection / preview 100 rows / fields / copy name / refresh).
- Tool drawers must never use `rootClassName="wb-app"` (the fullscreen fixed drawer root would keep a white background after close → blank page). Use `wb-app-drawer`; BI adds `bi-drawer` and styles scoped in `bi-panel.css`.
- Spatial results: toolbar `空间结果预览` opens `SpatialResultPanel` (`spatial-result.css`), an offline canvas viewer capped at `MAX_ROWS = 5000` (SSMS-style). Renderer has **no Node `Buffer`** — use `wkb-browser.ts` (`DataView`) for WKB/EWKB, never the shared `parseWkbToGeojson`, and never call `Buffer.isBuffer` when formatting arbitrary result values (that render error unmounted the whole app when clicking a feature). `SpatialResultPanel` is wrapped in `PanelErrorBoundary` in `SqlWorkbenchPage` so a panel error cannot blank the app. Feature picking uses `geometryHits` (point-in-ring for polygon interiors, segment distance for lines, vertex distance for points) — never vertex-only checks. The canvas size comes from a callback ref + `ResizeObserver` because the Drawer portal mounts after effects.
- Token values asserted: `--wb-brand: #1677ff`, `--wb-bg-toolbar: #f3f4f6`, `--wb-font-size: 12px`, `--wb-control-h: 26px`. Shell font must compute to `12px`.

## Read first (highest signal per task)

- Commands/gates: root `package.json`, `.github/workflows/ci.yml`, `apps/desktop/package.json`.
- Renderer changes: `apps/desktop/src/main.tsx`, `vite.config.ts`, `workbench/Workbench.tsx`, `workbench-theme.css`, `SqlWorkbenchPage.tsx`, `CompiledWorkbenchBridge.tsx`, and the E2E spec above.
- Architecture detail: `docs/architecture.md`, `docs/gis-design.md`, `docs/ai-sql-assistant.md`, `docs/workbench-design-system-20261125.md`, `CLAUDE.md`.
- Integration tests: standalone `tests/integration/*.mjs`, usually needing Docker profiles in `docker/`; run via root `test:integration:*` scripts (they build prerequisite packages first).
