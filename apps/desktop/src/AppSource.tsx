import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert, Button, Card, Empty, Input,
  Select, Space, Spin, Tag, Tooltip, Typography, message,
} from "antd";
import type { MenuProps } from "antd";
import type { ModalFuncProps } from "antd/es/modal/interface";
import type { DataNode } from "antd/es/tree";
import {
  Activity, AlertCircle, ArrowLeftRight, Braces, Check, ChevronDown, CircleHelp, Clock3, Code2,
  Database, Download, FileCode2, FileInput, FileOutput, FolderTree, Globe2,
  Layers3, Pencil, Plus, Play, RefreshCw, Save, Search, Settings2, Sparkles, Table2, TerminalSquare,
  Trash2, Upload, Wifi, X,
} from "lucide-react";
import type { editor as MonacoEditor, IPosition } from "monaco-editor";
import type { GisAttributePreview, GisDatasetInfo, GisFieldMapping, GisFieldTargetType, GisGeometryValidationReport, GisLayerInfo, GisOperationReport, GisSpatialExtent } from "@db-studio/gis";
import { queryResultToCsv } from "@db-studio/shared/format";
import type { ColumnInfo, DatabaseEngine, QueryResult, TableInfo } from "@db-studio/shared";
import type { SqlAssistantTask } from "@db-studio/ai";
import type { ConnectionSummary, ConnectionValues } from "./ConnectionFormModal";
import { buildTablePreviewSql } from "./table-data-edit";
import { invokeGisExport, parseGisExportSpatialFilter } from "./gis-export-bridge";
import { appendAssistantSql } from "./ai-sql-insertion";
import { useWorkspaceStore } from "./workspace-store";
import {
  EDITOR_SHARE_MAX,
  EDITOR_SHARE_MIN,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
  loadWorkspaceLayout,
  saveWorkspaceLayout,
  type WorkspaceLayoutPreferences,
} from "./workspace-layout";

const Editor = lazy(() => import("@monaco-editor/react"));
const MongoDocumentsPage = lazy(() => import("./MongoDocumentsPage"));
const AiAssistantPanel = lazy(() => import("./AiAssistantPanel"));
const AiSettingsModal = lazy(() => import("./AiSettingsModal"));
const QueryHistoryDrawer = lazy(() => import("./QueryHistoryDrawer"));
const DatabaseObjectSearchModal = lazy(() => import("./DatabaseObjectSearchModal"));
const DatabaseObjectTree = lazy(() => import("./DatabaseObjectTree"));
const ConnectionFormModal = lazy(() => import("./ConnectionFormModal"));
const LazyDataTable = lazy(() => import("./LazyDataTable"));
const TableStructureModal = lazy(() => import("./TableStructureModal"));
const LazyGisCheckbox = lazy(() => import("./GisControls").then(({ GisCheckbox }) => ({ default: GisCheckbox })));
const LazyGisProgress = lazy(() => import("./GisControls").then(({ GisProgress }) => ({ default: GisProgress })));
const TableDataEditorModal = lazy(() => import("./TableDataEditorModal"));
const TableTransferModal = lazy(() => import("./TableTransferModal"));
const GisPreviewMap = lazy(() => import("./GisPreviewMap"));

interface QueryFailure {
  connectionId: string;
  sql: string;
  message: string;
  code?: string;
  position?: number;
}

const desktopEngines = ["postgres", "mysql", "mariadb", "sqlite", "sqlserver", "oracle", "mongodb"] as const;
const gisFieldTypeOptions: Array<{ value: GisFieldTargetType | ""; label: string }> = [
  { value: "", label: "保留源类型" },
  { value: "string", label: "文本" },
  { value: "integer", label: "整数" },
  { value: "integer64", label: "64 位整数" },
  { value: "real", label: "小数" },
  { value: "date", label: "日期" },
  { value: "time", label: "时间" },
  { value: "datetime", label: "日期时间" },
];
const engineLabels: Record<(typeof desktopEngines)[number], string> = {
  postgres: "PostgreSQL",
  mysql: "MySQL",
  mariadb: "MariaDB",
  sqlite: "SQLite",
  mongodb: "MongoDB",
  sqlserver: "SQL Server",
  oracle: "Oracle Database",
};
const defaultPorts: Record<Exclude<(typeof desktopEngines)[number], "sqlite">, number> = {
  postgres: 5432,
  mysql: 3306,
  mariadb: 3306,
  mongodb: 27017,
  sqlserver: 1433,
  oracle: 1521,
};

const { Text, Title } = Typography;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function showConfirm(options: ModalFuncProps): Promise<void> {
  try {
    const { default: Modal } = await import("antd/es/modal");
    Modal.confirm(options);
  } catch (error) {
    message.error(`无法打开确认对话框：${errorText(error)}`);
  }
}

function useHasOpened(open: boolean): boolean {
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) setMounted(true);
  }, [open]);
  return mounted || open;
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function quotedTable(engine: DatabaseEngine, schema: string, table: string): string {
  if (engine === "mysql" || engine === "mariadb") {
    const quote = (value: string) => `\`${value.replaceAll("`", "``")}\``;
    return `${quote(schema)}.${quote(table)}`;
  }
  const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
  return `${quote(schema)}.${quote(table)}`;
}

function crsLabel(crs: string | null): string {
  if (!crs) return "CRS 未知";
  if (crs.length <= 36) return crs;
  if (crs.includes("World Geodetic System 1984")) return "WGS 84 · WKT";
  return "自定义 CRS · WKT";
}

function suggestedPostgresTable(layerName?: string): string {
  let name = layerName?.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "imported_data";
  if (!/^[a-z_]/.test(name)) name = `layer_${name}`;
  return `public.${name.slice(0, 63 - "public.".length)}`;
}

function suggestedGisTargetTable(layerName: string | undefined, engine: ConnectionSummary["engine"] | undefined, oracleSchema?: string): string {
  const postgresName = suggestedPostgresTable(layerName);
  if (engine === "sqlite") return postgresName.slice("public.".length);
  if (engine === "mysql" || engine === "mariadb") return postgresName.slice("public.".length);
  if (engine === "sqlserver") return `dbo.${postgresName.slice("public.".length)}`;
  if (engine === "oracle") return oracleSchema ? `${oracleSchema}.${postgresName.slice("public.".length)}` : postgresName.slice("public.".length);
  return postgresName;
}

export default function App() {
  const queryClient = useQueryClient();
  const page = useWorkspaceStore((state) => state.page);
  const setPage = useWorkspaceStore((state) => state.setPage);
  const sql = useWorkspaceStore((state) => state.sql);
  const setSql = useWorkspaceStore((state) => state.setSql);
  const sqlPath = useWorkspaceStore((state) => state.sqlPath);
  const setSqlPath = useWorkspaceStore((state) => state.setSqlPath);
  const result = useWorkspaceStore((state) => state.result);
  const setResult = useWorkspaceStore((state) => state.setResult);

  const [activeId, setActiveId] = useState<string>();
  const [connectionModal, setConnectionModal] = useState(false);
  const [connectionSaveError, setConnectionSaveError] = useState<string>();
  const [connectionRecoveryBusy, setConnectionRecoveryBusy] = useState(false);
  const [editingConnection, setEditingConnection] = useState<ConnectionSummary>();
  const [queryBusy, setQueryBusy] = useState(false);
  const [queryFailure, setQueryFailure] = useState<QueryFailure>();
  const [queryHistoryOpen, setQueryHistoryOpen] = useState(false);
  const [objectSearchOpen, setObjectSearchOpen] = useState(false);
  const [aiPanelOpen, setAiPanelOpen] = useState(false);
  const [aiSettingsOpen, setAiSettingsOpen] = useState(false);
  const [aiSettingsRevision, setAiSettingsRevision] = useState(0);
  const [aiInitialTask, setAiInitialTask] = useState<SqlAssistantTask>("generate");
  const [aiSelectedSql, setAiSelectedSql] = useState<string>();
  const [gisFile, setGisFile] = useState("");
  const [gisInfo, setGisInfo] = useState<GisDatasetInfo>();
  const [gisPreview, setGisPreview] = useState<GisAttributePreview>();
  const [gisValidation, setGisValidation] = useState<GisGeometryValidationReport>();
  const [gisSpatialFilter, setGisSpatialFilter] = useState<GisSpatialExtent | null>(null);
  const [sourceEncoding, setSourceEncoding] = useState("");
  const [zipFilenameEncoding, setZipFilenameEncoding] = useState("");
  const [targetEncoding, setTargetEncoding] = useState("");
  const [previewBusy, setPreviewBusy] = useState(false);
  const [selectedGisLayer, setSelectedGisLayer] = useState("");
  const [gisFieldMappings, setGisFieldMappings] = useState<GisFieldMapping[]>([]);
  const [sqlServerSpatialColumnType, setSqlServerSpatialColumnType] = useState<"geometry" | "geography">("geometry");
  const [gisBusy, setGisBusy] = useState(false);
  const [gisValidationBusy, setGisValidationBusy] = useState(false);
  const [gisOperationId, setGisOperationId] = useState<string | null>(null);
  const [gisOperationKind, setGisOperationKind] = useState<"import" | "export" | null>(null);
  const [gisProgress, setGisProgress] = useState(0);
  const [gisReport, setGisReport] = useState<GisOperationReport>();
  const gisOperationRef = useRef<string | null>(null);
  const [dataBusy, setDataBusy] = useState(false);
  const [targetTable, setTargetTable] = useState("");
  const [sourceTable, setSourceTable] = useState("");
  const [exportFieldMappings, setExportFieldMappings] = useState<GisFieldMapping[]>([]);
  const [exportFieldsBusy, setExportFieldsBusy] = useState(false);
  const [importTargetCrs, setImportTargetCrs] = useState("");
  const [exportSourceCrs, setExportSourceCrs] = useState("");
  const [exportTargetCrs, setExportTargetCrs] = useState("");
  const [exportSpatialFilterText, setExportSpatialFilterText] = useState("");
  const [exportTargetLayerName, setExportTargetLayerName] = useState("");
  const [exportDatasetCreationOptions, setExportDatasetCreationOptions] = useState("");
  const [exportLayerCreationOptions, setExportLayerCreationOptions] = useState("");
  const [sourceCrs, setSourceCrs] = useState("");
  const [importCoordinateOperation, setImportCoordinateOperation] = useState("");
  const [exportCoordinateOperation, setExportCoordinateOperation] = useState("");
  const [importMode, setImportMode] = useState<"create" | "append" | "overwrite">("create");
  const [makeValidGeometries, setMakeValidGeometries] = useState(false);
  const [replaceIncompleteUtf8Tails, setReplaceIncompleteUtf8Tails] = useState(false);
  const [createGisSpatialIndex, setCreateGisSpatialIndex] = useState(false);
  const [initializeGisSpatialite, setInitializeGisSpatialite] = useState(false);
  const [testedConnection, setTestedConnection] = useState<string>();
  const [inspectedTable, setInspectedTable] = useState<(TableInfo & { connectionId: string })>();
  const [editingDataTable, setEditingDataTable] = useState<{ connectionId: string; engine: DatabaseEngine; table: TableInfo }>();
  const [transferSource, setTransferSource] = useState<{ connectionId: string; connectionName: string; table: TableInfo }>();
  const [workspaceLayout, setWorkspaceLayout] = useState(loadWorkspaceLayout);
  const aiPanelMounted = useHasOpened(aiPanelOpen);
  const aiSettingsMounted = useHasOpened(aiSettingsOpen);
  const queryHistoryMounted = useHasOpened(queryHistoryOpen);
  const objectSearchMounted = useHasOpened(objectSearchOpen);
  const connectionModalMounted = useHasOpened(connectionModal);
  const workspaceLayoutRef = useRef(workspaceLayout);
  const resizeRef = useRef<{ kind: "sidebar" | "query"; pointerId: number; start: number; value: number } | null>(null);
  const queryWorkspaceRef = useRef<HTMLElement | null>(null);
  const editorPanelRef = useRef<HTMLDivElement | null>(null);
  const resultsPanelRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
  const completionProviderRef = useRef<{ dispose(): void } | null>(null);
  const completionContextRef = useRef<{
    connectionId: string;
    engine?: DatabaseEngine;
    database: string;
    schema: string;
    tables: TableInfo[];
  }>({ connectionId: "", database: "", schema: "", tables: [] });
  const completionColumnsRef = useRef(new Map<string, { fetchedAt: number; columns: ColumnInfo[] }>());
  const completionColumnFailuresRef = useRef(new Set<string>());
  const completionScopeRef = useRef("");

  function applyWorkspaceLayout(next: WorkspaceLayoutPreferences, persist = false) {
    workspaceLayoutRef.current = next;
    setWorkspaceLayout(next);
    if (persist) saveWorkspaceLayout(next);
  }

  function startPaneResize(kind: "sidebar" | "query", event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeRef.current = {
      kind,
      pointerId: event.pointerId,
      start: kind === "sidebar" ? event.clientX : event.clientY,
      value: kind === "sidebar" ? workspaceLayoutRef.current.sidebarWidth : workspaceLayoutRef.current.editorShare,
    };
  }

  function movePaneResize(event: ReactPointerEvent<HTMLDivElement>) {
    const active = resizeRef.current;
    if (!active || active.pointerId !== event.pointerId) return;
      const sidebarWidth = Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, active.value + event.clientX - active.start));
      applyWorkspaceLayout({ ...workspaceLayoutRef.current, sidebarWidth });
      return;

    const container = queryWorkspaceRef.current;
    const editor = editorPanelRef.current;
    const results = resultsPanelRef.current;
    if (!container || !editor || !results) return;
    const c = container as HTMLElement, e = editor as HTMLDivElement, r = results as HTMLDivElement;
    const bounds = c.getBoundingClientRect();
    const containerStyle = window.getComputedStyle(c);
    const editorStyle = window.getComputedStyle(e);
    const resultsStyle = window.getComputedStyle(r);
    const pixels = (value: string) => Number.parseFloat(value) || 0;
    const gap = pixels(containerStyle.rowGap || containerStyle.gap);
    const splitterHeight = event.currentTarget.getBoundingClientRect().height;
    const paneSpace = bounds.height
      - pixels(containerStyle.paddingTop)
      - pixels(containerStyle.paddingBottom)
      - gap * 2
      - splitterHeight;
    const minEditor = pixels(editorStyle.minHeight);
    const minResults = pixels(resultsStyle.minHeight);
    const flexSpace = Math.max(1, paneSpace - minEditor - minResults);
    const editorHeight = event.clientY - bounds.top - pixels(containerStyle.paddingTop) - gap - splitterHeight / 2;
    const editorShare = Math.min(EDITOR_SHARE_MAX, Math.max(EDITOR_SHARE_MIN, (editorHeight - minEditor) / flexSpace));
    applyWorkspaceLayout({ ...workspaceLayoutRef.current, editorShare });
  }

  function finishPaneResize(event: ReactPointerEvent<HTMLDivElement>) {
    const active = resizeRef.current;
    if (!active || active.pointerId !== event.pointerId) return;
    resizeRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    saveWorkspaceLayout(workspaceLayoutRef.current);
  }

  function handlePaneResizeKey(kind: "sidebar" | "query", event: ReactKeyboardEvent<HTMLDivElement>) {
    const delta = event.shiftKey ? 48 : 16;
    let next = workspaceLayoutRef.current;
    if (kind === "sidebar" && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      event.preventDefault();
      next = { ...next, sidebarWidth: Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, next.sidebarWidth + (event.key === "ArrowRight" ? delta : -delta))) };
    } else if (kind === "query" && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      event.preventDefault();
      const step = event.shiftKey ? 0.08 : 0.03;
      next = { ...next, editorShare: Math.min(EDITOR_SHARE_MAX, Math.max(EDITOR_SHARE_MIN, next.editorShare + (event.key === "ArrowUp" ? step : -step))) };
    } else {
      return;
    }
    applyWorkspaceLayout(next, true);
  }

  useEffect(() => {
    const unsubscribe = window.dbStudio.gis.onProgress(({ operationId, percent }) => {
      if (gisOperationRef.current === operationId) setGisProgress(Math.floor(percent));
    });
    return () => {
      unsubscribe();
      if (gisOperationRef.current) window.dbStudio.gis.cancel(gisOperationRef.current);
    };
  }, []);

  useEffect(() => {
    if (page !== "query") setAiPanelOpen(false);
  }, [page]);

  const connectionsQuery = useQuery({
    queryKey: ["connections"], queryFn: () => window.dbStudio.connections.list(),
  });
  const connections = connectionsQuery.data ?? [];
  const activeConnection = connections.find((item: any) => item.id === activeId);
  useEffect(() => { setInitializeGisSpatialite(false); }, [activeId]);
  const selectedGisLayerInfo = gisInfo?.layers.find((layer) => layer.name === selectedGisLayer) ?? gisInfo?.layers[0];
  const displayGisEncoding = gisPreview?.encoding ?? gisInfo?.encoding;
  const normalizedGisPath = gisFile.trim().replace(/\\/g, "/");
  const canReplaceIncompleteUtf8Tails = !normalizedGisPath.toLowerCase().startsWith("/vsizip/")
    && normalizedGisPath.toLowerCase().endsWith(".shp")
    && /^(?:UTF8(?:SIG)?|65001)$/.test(sourceEncoding.trim().replace(/^['"]|['"]$/g, "").toUpperCase().replace(/[^A-Z0-9]/g, ""));
  const displayGisEncodingSource = displayGisEncoding
    ? ({
        metadata: "文件元数据",
        format: "格式规范",
        user: "手动指定",
        heuristic: "样本推断",
        "ascii-compatible": "ASCII 内容安全解码",
        unknown: "未知",
      } as const)[displayGisEncoding.source]
    : undefined;
  const schemasQuery = useQuery({
    queryKey: ["schemas", activeId, activeConnection?.database], queryFn: () => window.dbStudio.database.schemas(activeId!), enabled: Boolean(activeId && activeConnection?.engine !== "mongodb"),
  });
  const defaultSchema = activeConnection?.engine === "sqlite"
    ? "main"
    : activeConnection?.engine === "mysql" || activeConnection?.engine === "mariadb"
      ? activeConnection.database || schemasQuery.data?.[0]
      : activeConnection?.engine === "sqlserver"
        ? "dbo"
      : activeConnection?.engine === "oracle"
        ? activeConnection.user?.toUpperCase() || schemasQuery.data?.[0]
      : "public";
  const tablesQuery = useQuery({
    queryKey: ["tables", activeId, activeConnection?.database, defaultSchema],
    queryFn: () => window.dbStudio.database.tables(activeId!, defaultSchema),
    enabled: Boolean(activeId && defaultSchema && activeConnection?.engine !== "mongodb"),
  });
  const tableColumnsQuery = useQuery({
    queryKey: ["table-columns", inspectedTable?.connectionId, inspectedTable?.schema, inspectedTable?.name],
    queryFn: () => window.dbStudio.database.columns(
      inspectedTable!.connectionId,
      inspectedTable!.name,
      inspectedTable!.schema,
    ),
    enabled: Boolean(inspectedTable),
  });
  const currentDatabase = activeConnection?.database ?? "";
  const completionScope = [activeId ?? "", currentDatabase, defaultSchema ?? "", tablesQuery.dataUpdatedAt].join("\0");
  if (completionScopeRef.current !== completionScope) {
    completionColumnsRef.current.clear();
    completionColumnFailuresRef.current.clear();
    completionScopeRef.current = completionScope;
  }
  completionContextRef.current = {
    connectionId: activeId ?? "",
    engine: activeConnection?.engine,
    database: currentDatabase,
    schema: defaultSchema ?? "",
    tables: tablesQuery.data ?? [],
  };

  useEffect(() => {
    if (page === "query") return;
    completionProviderRef.current?.dispose();
    completionProviderRef.current = null;
  }, [page]);

  useEffect(() => () => {
    completionProviderRef.current?.dispose();
    completionProviderRef.current = null;
  }, []);

  async function saveConnection(values: ConnectionValues) {
    setConnectionSaveError(undefined);
    try {
      const id = values.id ?? crypto.randomUUID();
      await window.dbStudio.connections.save({ ...values, password: values.password ?? "", id });
      await queryClient.invalidateQueries({ queryKey: ["connections"] });
      setActiveId(id);
      setQueryFailure(undefined);
      setConnectionModal(false);
      message.success(editingConnection ? "连接已更新" : "连接已保存");
    } catch (error) {
      const detail = errorText(error);
      setConnectionSaveError(detail);
      message.error(`连接保存失败：${detail}`);
    }
  }

  function confirmConnectionStoreRecovery() {
    void showConfirm({
      title: "备份并新建空连接库？",
      content: "应用将把当前无法解密的连接密文原样复制到旁边的 .bak 文件，再创建新的加密连接库。旧连接和密码不会恢复到新库；备份仍保留原加密形式，只能由能解密它的原系统/用户恢复。",
      okText: "保留备份并继续",
      cancelText: "取消",
      onOk: async () => {
        setConnectionRecoveryBusy(true);
        try {
          const { backupPath } = await window.dbStudio.connections.backupAndResetUnreadable();
          setActiveId(undefined);
          await queryClient.invalidateQueries({ queryKey: ["connections"] });
          message.success(`新连接库已创建；旧加密配置备份：${backupPath}`, 8);
        } catch (error) {
          message.error(`连接配置恢复失败：${errorText(error)}`);
        } finally {
          setConnectionRecoveryBusy(false);
        }
      },
    });
  }

  async function removeConnection(connection: ConnectionSummary) {
    void showConfirm({
      title: "删除连接配置？", content: `“${connection.name}”将从本机安全存储中移除。`,
      okText: "删除", okButtonProps: { danger: true }, cancelText: "取消",
      onOk: async () => {
        await window.dbStudio.connections.remove(connection.id);
        await queryClient.invalidateQueries({ queryKey: ["connections"] });
        if (activeId === connection.id) { setActiveId(undefined); setResult(undefined); setQueryFailure(undefined); }
        message.success("连接已删除");
      },
    });
  }

  async function testConnection(connection: ConnectionSummary) {
    try {
      const details = await window.dbStudio.connections.test(connection.id);
      setTestedConnection(connection.id);
      message.success(`连接成功 · ${engineLabels[connection.engine as keyof typeof engineLabels] ?? connection.engine} ${details.serverVersion} · ${details.database}`);
    } catch (error) { message.error(errorText(error)); }
  }

  async function formatCurrentSql() {
    let formatter: typeof import("./sql-formatting");
    try { formatter = await import("./sql-formatting"); }
    catch (error) { message.error(`无法加载 SQL 格式化器：${errorText(error)}`); return; }
    const editor = editorRef.current;
    const model = editor?.getModel();
    const selection = editor?.getSelection();
    const range = model
      ? selection && !selection.isEmpty() ? selection : model.getFullModelRange()
      : undefined;
    const source = model && range ? model.getValueInRange(range) : sql;
    if (!source.trim()) { message.warning("SQL 编辑器为空"); return; }
    let formatted: string;
    try { formatted = formatter.formatSqlDocument(source, activeConnection?.engine); }
    catch (error) { message.error(`SQL 格式化失败：${errorText(error)}`); return; }
    if (formatted === source) { message.info("SQL 已是格式化状态。"); return; }
    if (editor && range) {
      editor.pushUndoStop();
      const applied = editor.executeEdits("db-studio.format-sql", [{ range, text: formatted, forceMoveMarkers: true }]);
      editor.pushUndoStop();
      if (!applied) { message.error("SQL 格式化结果未能应用到编辑器。"); return; }
    } else {
      setSql(formatted);
    }
    message.success(`SQL 已按 ${formatter.sqlFormattingLanguage(activeConnection?.engine)} 规则格式化。`);
  }

  async function runQuery() {
    if (!activeId || !activeConnection) { message.warning("请先选择一个数据库连接"); return; }
    if (activeConnection?.engine === "mongodb") { setPage("mongo"); message.info("MongoDB 使用文档查询页面。"); return; }
    if (!sql.trim()) { message.warning("SQL 编辑器为空"); return; }
    const executedSql = sql;
    const connectionId = activeId;
    const connectionName = activeConnection.name;
    const engine = activeConnection.engine;
    const startedAt = Date.now();
    const executedAt = new Date(startedAt).toISOString();
    let outcome: "success" | "error" = "error";
    let rowCount: number | undefined;
    let command: string | undefined;
    setQueryBusy(true);
    try {
      const queryResult = await window.dbStudio.database.query(connectionId, executedSql);
      outcome = "success";
      rowCount = queryResult.rowCount;
      command = queryResult.command;
      setResult(queryResult);
      if (activeId === connectionId) setQueryFailure(undefined);
      message.success(`${queryResult.command ?? "完成"} · ${queryResult.rowCount} 行`);
    } catch (error) {
      if (activeId === connectionId) {
        const record = error && typeof error === "object" ? error as Record<string, unknown> : {};
        const position = Number(record.position);
        setQueryFailure({
          connectionId,
          sql: executedSql,
          message: errorText(error),
          code: typeof record.code === "string" ? record.code : undefined,
          position: Number.isInteger(position) && position > 0 ? position : undefined,
        });
      }
      message.error(errorText(error));
    }
    finally {
      try {
        await window.dbStudio.queryHistory.record({
          id: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          connectionId,
          connectionName,
          engine,
          sql: executedSql,
          executedAt,
          durationMs: Math.max(0, Date.now() - startedAt),
          outcome,
          ...(rowCount === undefined ? {} : { rowCount }),
          ...(command ? { command } : {}),
        });
      } catch {
        message.warning("查询已执行，但无法保存本机查询历史；过长 SQL 不会写入历史。");
      }
      setQueryBusy(false);
    }
  }

  const previewTableRows = useCallback(async (connectionId: string, connectionName: string, engine: DatabaseEngine, schema: string, table: string) => {
    const previewSql = buildTablePreviewSql(engine, schema, table);
    setSql(previewSql);
    setPage("query");
    const startedAt = Date.now();
    setQueryBusy(true);
    try {
      const queryResult = await window.dbStudio.database.query(connectionId, previewSql);
      setResult(queryResult);
      message.success(`已读取 ${table} · ${queryResult.rowCount} 行。`);
      try {
        await window.dbStudio.queryHistory.record({
          id: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          connectionId,
          connectionName,
          engine,
          sql: previewSql,
          executedAt: new Date(startedAt).toISOString(),
          durationMs: Math.max(0, Date.now() - startedAt),
          outcome: "success",
          rowCount: queryResult.rowCount,
          command: queryResult.command ?? "SELECT",
        });
      } catch { /* history is best-effort */ }
    } catch (error) {
      message.error(errorText(error));
    } finally {
      setQueryBusy(false);
    }
  }, [message, setPage, setQueryBusy, setResult, setSql]);

  function openAiAssistant(initialTask: SqlAssistantTask = "generate") {
    const selection = editorRef.current?.getSelection();
    const model = editorRef.current?.getModel();
    const selected = selection && model ? model.getValueInRange(selection).trim() : "";
    setAiSelectedSql(initialTask === "repair" && queryFailure && queryFailure.connectionId === activeId
      ? queryFailure.sql : selected || undefined);
    setAiInitialTask(initialTask);
    setAiPanelOpen(true);
  }

  function insertAssistantSql(content: string) {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model) {
      setSql(appendAssistantSql(useWorkspaceStore.getState().sql, content));
      return;
    }
    const selection = editor.getSelection();
    const range = selection ?? model.getFullModelRange();
    editor.executeEdits("ai-sql-assistant", [{
      range,
      text: content,
      forceMoveMarkers: true,
    }]);
    editor.focus();
  }

  async function openSql() {
    const file = await window.dbStudio.files.openSql();
    if (file) { setSql(file.content); setSqlPath(file.path); message.success(`已打开 ${file.path}`); }
  }

  async function saveSql() {
    const file = await window.dbStudio.files.saveSql(sqlPath, sql);
  }

  async function exportQueryResult(format: "csv" | "json") {
    if (!result) return;
    const content = format === "csv"
      ? `\uFEFF${queryResultToCsv(result, { spreadsheetSafe: true })}`
      : JSON.stringify({ columns: result.columns, rows: result.rows, rowCount: result.rowCount }, null, 2);
    try {
      const file = await window.dbStudio.files.saveResult(format, content);
      if (file) message.success(`查询结果已导出：${file}`);
    } catch (error) { message.error(errorText(error)); }
  }

  async function exportTableData(table: TableInfo) {
    if (!activeId) return;
    setDataBusy(true);
    try {
      const exported = await window.dbStudio.database.exportTable(activeId, table.name, table.schema);
      if (exported) message.success(`已导出 ${exported.rowCount} 行 · ${exported.format.toUpperCase()} · ${exported.path}`);
    } catch (error) { message.error(errorText(error)); }
    finally { setDataBusy(false); }
  }

  function importTableData(table: TableInfo) {
    if (!activeId) return;
    void showConfirm({
      title: `向“${table.name}”追加数据？`,
      content: "CSV、JSON 或 Excel 文件的列名必须与目标表匹配。Excel 导入使用第一个工作表；导入会追加记录，若任一行失败则整批回滚。",
      okText: "选择文件并导入",
      cancelText: "取消",
      onOk: async () => {
        setDataBusy(true);
        try {
          const imported = await window.dbStudio.database.importTable(activeId, table.name, table.schema);
          if (imported) {
            message.success(`已导入 ${imported.insertedRows} 行到 ${table.name}`);
            await queryClient.invalidateQueries({ queryKey: ["tables", activeId] });
          }
        } catch (error) { message.error(errorText(error)); }
        finally { setDataBusy(false); }
      },
    });
  }

  function importFileAsNewTable(connectionId: string, schema: string) {
    let tableName = "imported_data";
    void showConfirm({
      title: `在 ${schema} 新建数据表`,
      content: <div>
        <p>选择 CSV、JSON 或 Excel 文件。字段类型将根据文件中的值推断；同名表不会被覆盖。</p>
        <Input aria-label="新表名称" defaultValue={tableName} onChange={(event: any) => { tableName = event.target.value; }} />
      </div>,
      okText: "选择文件并导入",
      cancelText: "取消",
      onOk: async () => {
        if (!tableName.trim()) {
          message.error("请输入新表名称。");
          return false;
        }
        setDataBusy(true);
        try {
          const imported = await window.dbStudio.database.importTableToNewTable(connectionId, tableName.trim(), schema);
          if (imported) {
            message.success(`已新建 ${imported.table} 并导入 ${imported.insertedRows} 行`);
            await queryClient.invalidateQueries({ queryKey: ["tables", connectionId] });
          }
        } catch (error) { message.error(errorText(error)); }
        finally { setDataBusy(false); }
      },
    });
  }

  async function transferTableData(source: NonNullable<typeof transferSource>, target: {
    connectionId: string;
    schema: string;
    table: string;
    columnMappings: Array<{ sourceColumn: string; targetColumn: string }>;
  }) {
    setDataBusy(true);
    try {
      const result = await window.dbStudio.database.transferTable(source.connectionId, {
        targetConnectionId: target.connectionId,
        sourceTable: source.table.name,
        sourceSchema: source.table.schema,
        targetTable: target.table,
        targetSchema: target.schema,
        pageSize: 250,
        columnMappings: target.columnMappings,
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["tables", source.connectionId] }),
        queryClient.invalidateQueries({ queryKey: ["tables", target.connectionId] }),
      ]);
      return result;
    } finally {
      setDataBusy(false);
    }
  }

  async function loadGisFile(file: string, zipEncoding = zipFilenameEncoding) {
    const input = file.trim();
    if (!input) { message.warning("请选择矢量文件或填写 GDAL /vsizip 路径。"); return; }
    const sameInput = input === gisFile;
    setGisFile(input); if (!sameInput) setReplaceIncompleteUtf8Tails(false); setGisBusy(true); setGisInfo(undefined); setGisPreview(undefined); setGisValidation(undefined); setGisSpatialFilter(null); setSelectedGisLayer("");
    if (!sameInput) setSourceEncoding("");
    try {
      const inputOptions = {
        sourceEncoding: sameInput ? sourceEncoding.trim() || undefined : undefined,
        zipFilenameEncoding: zipEncoding.trim() || undefined,
      };
      const info = await window.dbStudio.gis.inspect(input, inputOptions);
      setGisInfo(info);
      const firstLayer = info.layers[0];
      setSelectedGisLayer(firstLayer?.name ?? "");
      setGisFieldMappings((firstLayer?.fields ?? []).map((field) => ({ source: field.name, target: field.name })));
      setTargetTable(suggestedGisTargetTable(firstLayer?.name, activeConnection?.engine));
      const detectedCrs = firstLayer?.crs ?? "";
      setSourceCrs(detectedCrs.length <= 48 ? detectedCrs : "");
      const preview = await window.dbStudio.gis.preview(input, { ...inputOptions, sourceLayer: firstLayer?.name, limit: 8 });
      setGisPreview(preview);
    } catch (error) { message.error(errorText(error)); }
    finally { setGisBusy(false); }
  }

  async function chooseGisFile() {
    const file = await window.dbStudio.files.openVector();
    if (!file) return;
    await loadGisFile(file);
  }

  async function refreshGisPreview(file = gisFile, layer = selectedGisLayer, encoding = sourceEncoding) {
    if (!file) return;
    setPreviewBusy(true);
    try {
      const preview = await window.dbStudio.gis.preview(file, {
        sourceLayer: layer || undefined,
        sourceEncoding: encoding.trim() || undefined,
        zipFilenameEncoding: zipFilenameEncoding.trim() || undefined,
        limit: 8,
      });
      setGisPreview(preview);
    } catch (error) { setGisPreview(undefined); message.error(errorText(error)); }
    finally { setPreviewBusy(false); }
  }

  function updateGisFieldMapping(source: string, update: Partial<GisFieldMapping>) {
    setGisFieldMappings((current) => current.map((mapping) => mapping.source === source ? { ...mapping, ...update } : mapping));
  }

  function updateExportFieldMapping(source: string, update: Partial<GisFieldMapping>) {
    setExportFieldMappings((current) => current.map((mapping) => mapping.source === source ? { ...mapping, ...update } : mapping));
  }

  async function inspectExportTable() {
    const engine = activeConnection?.engine;
    if (!activeId || (engine !== "postgres" && engine !== "sqlite" && engine !== "sqlserver")) { message.warning("请选择 SQLite/SpatiaLite、PostGIS 或 SQL Server 连接"); return; }
    if (!sourceTable) { message.warning(engine === "sqlite" ? "请输入 SQLite/SpatiaLite 表名，例如 roads" : "请输入源表名，例如 public.roads 或 dbo.roads"); return; }
    setExportFieldsBusy(true);
    try {
      const fields = engine === "postgres" || engine === "sqlite"
        ? (await window.dbStudio.gis.inspectTable(activeId, sourceTable)).fields
        : await (async () => {
            const parts = sourceTable.split(".");
            if (parts.length > 2 || parts.some((part) => !part.trim())) throw new Error("SQL Server 源表请使用 table 或 schema.table 格式。");
            const schema = parts.length === 2 ? parts[0]! : "dbo";
            const table = parts.length === 2 ? parts[1]! : parts[0]!;
            return (await window.dbStudio.database.columns(activeId, table, schema))
              .filter((column) => !/^(?:geometry|geography)$/i.test(column.dataType.trim()))
              .map((column) => ({ name: column.name }));
          })();
      setExportFieldMappings(fields.map((field) => ({ source: field.name, target: field.name })));
      if (fields.length === 0) message.info("该表没有可映射的属性字段。");
    } catch (error) { message.error(errorText(error)); }
    finally { setExportFieldsBusy(false); }
  }

  async function importGis() {
    const engine = activeConnection?.engine;
    if (!activeId || (engine !== "sqlite" && engine !== "postgres" && engine !== "mysql" && engine !== "mariadb" && engine !== "sqlserver" && engine !== "oracle")) {
      message.warning("请选择 SQLite/SpatiaLite、PostGIS、MySQL、MariaDB、SQL Server 或 Oracle 连接"); return;
    }
    if (!gisFile || !targetTable) { message.warning("请选择文件并填写目标表"); return; }
    if (!gisPreview || gisPreview.requiresUserChoice || gisPreview.layer !== selectedGisLayerInfo?.name) {
      message.warning("请先确认源编码并预览属性后再导入。"); return;
    }
    const operationId = crypto.randomUUID();
    gisOperationRef.current = operationId;
    setGisOperationId(operationId); setGisOperationKind("import"); setGisProgress(0); setGisReport(undefined);
    setGisBusy(true);
    try {
      const result = await window.dbStudio.gis.import(activeId, gisFile, targetTable, {
        mode: importMode, sourceLayer: selectedGisLayer || undefined, sourceCrs: sourceCrs || undefined, targetCrs: importTargetCrs || undefined,
        coordinateOperation: importCoordinateOperation.trim() || undefined,
        sourceEncoding: sourceEncoding.trim() || undefined,
        zipFilenameEncoding: zipFilenameEncoding.trim() || undefined,
        fieldMappings: gisFieldMappings,
        spatialFilter: gisSpatialFilter ?? undefined,
        makeValid: makeValidGeometries,
        replaceIncompleteUtf8Tails: canReplaceIncompleteUtf8Tails && replaceIncompleteUtf8Tails,
        createSpatialIndex: ["sqlite", "oracle", "mysql", "mariadb", "sqlserver"].includes(engine) && createGisSpatialIndex,
        initializeSpatialite: engine === "sqlite" && initializeGisSpatialite,
        spatialColumnType: engine === "sqlserver" ? sqlServerSpatialColumnType : undefined,
      }, operationId);
      setGisReport(result.report);
      if (!result.ok) { message.error(result.error); return; }
      message.success(`导入完成 · ${result.report.successfulFeatures ?? "未知"} 个要素`);
      await queryClient.invalidateQueries({ queryKey: ["tables", activeId] });
    } catch (error) { message.error(errorText(error)); }
    finally {
      if (gisOperationRef.current === operationId) gisOperationRef.current = null;
      setGisOperationId(null); setGisOperationKind(null); setGisBusy(false);
    }
  }

  async function checkGisGeometry() {
    if (!gisFile || !selectedGisLayerInfo) { message.warning("请选择矢量文件和源图层。"); return; }
    setGisValidationBusy(true);
    setGisValidation(undefined);
    try {
      const report = await window.dbStudio.gis.validate(gisFile, {
        sourceLayer: selectedGisLayerInfo.name,
        sourceEncoding: sourceEncoding.trim() || undefined,
        zipFilenameEncoding: zipFilenameEncoding.trim() || undefined,
      });
      setGisValidation(report);
    } catch (error) { message.error(errorText(error)); }
    finally { setGisValidationBusy(false); }
  }

  async function exportGis() {
    if (!activeId || !["sqlite", "postgres", "mysql", "mariadb", "sqlserver", "oracle"].includes(activeConnection?.engine ?? "")) { message.warning("请选择 SQLite/SpatiaLite、PostGIS、MySQL、MariaDB、SQL Server 或 Oracle 连接"); return; }
    if (!sourceTable) { message.warning(activeConnection?.engine === "postgres" || activeConnection?.engine === "oracle" ? "请输入要导出的表名，例如 schema.roads" : "请输入要导出的表名"); return; }
    let spatialFilter: GisSpatialExtent | undefined;
    if (exportSpatialFilterText.trim()) {
      try { spatialFilter = parseGisExportSpatialFilter(exportSpatialFilterText); }
      catch (error) { message.error(errorText(error)); return; }
    }
    const output = await window.dbStudio.files.saveVector();
    if (!output) return;
    const operationId = crypto.randomUUID();
    gisOperationRef.current = operationId;
    setGisOperationId(operationId); setGisOperationKind("export"); setGisProgress(0); setGisReport(undefined);
    setGisBusy(true);
    try {
      const result = await invokeGisExport(window.dbStudio.gis, {
        connectionId: activeId,
        table: sourceTable,
        output,
        operationId,
        form: {
          targetLayerName: exportTargetLayerName,
          sourceCrs: exportSourceCrs,
          targetCrs: exportTargetCrs,
          coordinateOperation: exportCoordinateOperation,
          spatialFilter,
          targetEncoding,
          fieldMappings: activeConnection?.engine === "postgres" || activeConnection?.engine === "sqlite" || activeConnection?.engine === "sqlserver" ? exportFieldMappings : [],
          datasetCreationOptions: exportDatasetCreationOptions ? exportDatasetCreationOptions.split("\n").filter(Boolean) : [],
          layerCreationOptions: exportLayerCreationOptions ? exportLayerCreationOptions.split("\n").filter(Boolean) : [],
        },
      });
      if (!result.ok) { setGisReport(result.report); message.error(result.error); return; }
      const info = result.dataset;
      setGisReport(info.operationReport);
      message.success(`导出完成 · ${info.operationReport?.successfulFeatures ?? info.layers[0]?.featureCount ?? "未知"} 个要素`);
      setGisInfo(info); setGisFile(output); setReplaceIncompleteUtf8Tails(false);
    } catch (error) { message.error(errorText(error)); }
    finally {
      if (gisOperationRef.current === operationId) gisOperationRef.current = null;
      setGisOperationId(null); setGisOperationKind(null); setGisBusy(false);
    }
  }

  const treeData = useMemo<DataNode[]>(() => connections.map((connection) => ({
    key: connection.id, title: connection.name, icon: <Database size={14} />,
    children: activeId === connection.id
      ? (schemasQuery.data ?? []).map((schema) => ({
          key: `${connection.id}:${schema}`, title: schema, icon: <FolderTree size={14} />,
          children: schema === defaultSchema ? (tablesQuery.data ?? []).map((table: TableInfo) => ({
            key: `${connection.id}:${schema}.${table.name}`,
            title: table.name,
            icon: <Table2 size={13} />,
            isLeaf: true,
            onClick: () => { setPage("query"); setSql(buildTablePreviewSql(connection.engine, schema, table.name)); },
          })) : [],
        }))
      : undefined,
  })), [connections, activeId, defaultSchema, schemasQuery.data, tablesQuery.data, setPage, setSql]);

  const getTreeNodeMenuItems = useCallback((node: DataNode): MenuProps["items"] => {
    const key = String(node.key ?? "");
    const connection = connections.find((item: any) => item.id === activeId);
    if (!connection) return [];
    const refresh = { key: "refresh", label: "刷新", onClick: () => { void schemasQuery.refetch(); void tablesQuery.refetch(); } };
    if (key === activeId) return [
      { key: "new-query", label: "新建 SQL 查询", onClick: () => { setPage("query"); setSql(""); } },
      { key: "search", label: "搜索数据库对象…", onClick: () => setObjectSearchOpen(true) },
      { key: "test", label: "测试连接", onClick: () => void testConnection(connection) },
      { type: "divider" },
      refresh,
      { key: "remove", label: "删除连接…", danger: true, onClick: () => void removeConnection(connection) },
    ];
    const rest = key.substring(key.indexOf(":") + 1);
    if (!rest.includes(".")) return [
      { key: "new-table", label: "从文件新建表…", disabled: dataBusy, onClick: () => importFileAsNewTable(connection.id, rest) },
      { type: "divider" },
      refresh,
    ];
    const schema = rest.substring(0, rest.lastIndexOf("."));
    const tableName = rest.substring(rest.lastIndexOf(".") + 1);
    const table: TableInfo = tablesQuery.data?.find((item: any) => item.name === tableName && item.schema === schema)
      ?? { name: tableName, schema, type: "table", comment: null, nullable: true, defaultValue: null, primaryKey: false, ordinalPosition: 0 } as TableInfo;
    return [
      { key: "preview", label: "查询前 100 条", onClick: () => void previewTableRows(connection.id, connection.name, connection.engine, schema, tableName) },
      { key: "edit", label: "编辑表数据…", onClick: () => setEditingDataTable({ connectionId: connection.id, engine: connection.engine, table }) },
      { key: "fields", label: "查看字段…", onClick: () => setInspectedTable({ ...table, connectionId: connection.id }) },
      { type: "divider" },
      { key: "import", label: "导入 CSV / JSON / Excel…", onClick: () => importTableData(table) },
      { key: "export", label: "导出 CSV / JSON / Excel…", onClick: () => void exportTableData(table) },
      { key: "transfer", label: "传输到其他连接…", onClick: () => setTransferSource({ connectionId: connection.id, connectionName: connection.name, table }) },
      { type: "divider" },
      refresh,
    ];
  }, [activeId, connections, dataBusy, exportTableData, importFileAsNewTable, importTableData, previewTableRows, schemasQuery, setEditingDataTable, setInspectedTable, setObjectSearchOpen, setPage, setSql, setTransferSource, tablesQuery, testConnection, removeConnection]);

  const columns = useMemo(() => (result?.columns ?? []).map((name: any) => ({
    title: <span className="result-column">{name}</span>, dataIndex: name, key: name,
    ellipsis: true, width: 180, render: (value: unknown) => {
      if (value === null) return <span className="null-value">NULL</span>;
      if (typeof value === "boolean") return <Tag color={value ? "green" : "default"}>{String(value)}</Tag>;
      return <span className={typeof value === "number" ? "numeric-value" : ""}>{cellText(value)}</span>;
    },
  })), [result?.columns]);
  const dataSource = useMemo(() => result?.rows.map((row: any, index: any) => ({ ...row, key: index })) ?? [], [result?.rows]);

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand-lockup"><div className="brand-mark"><Layers3 size={18} /></div><div><strong>DB STUDIO</strong><span>DATA WORKBENCH</span></div></div>
        <div className="topbar-divider" />
        <div className="breadcrumb"><span>Workspace</span><ChevronDown size={13} /><b>{page === "query" ? "SQL 查询" : page === "mongo" ? "MongoDB 文档" : "GIS 数据"}</b></div>
        <div className="topbar-spacer" />
        <div className="topbar-actions">
          <span className="environment-dot" />
          <Text className="env-label">LOCAL SESSION</Text>
          <Tooltip title="连接配置由本机系统安全存储加密"><CircleHelp size={16} className="help-icon" /></Tooltip>
        </div>
      </header>

      <div className="main-frame">
        <aside className="sidebar" style={{ width: workspaceLayout.sidebarWidth, flexBasis: workspaceLayout.sidebarWidth }}>
          <div className="sidebar-heading"><span>连接</span><Button type="text" size="small" icon={<Plus size={15} />} onClick={() => { setEditingConnection(undefined); setConnectionSaveError(undefined); setConnectionModal(true); }} /></div>
          <div className="connection-list">
              {connectionsQuery.isLoading ? <Spin size="small" /> : connectionsQuery.isError ? (
              <Alert
                showIcon
                type="error"
                message="读取连接配置失败"
                description={<div>
                  <div>{errorText(connectionsQuery.error)}</div>
                  <div>如确认旧加密文件无法由当前系统恢复，可先保留密文备份，再新建空连接库。</div>
                </div>}
                action={<Space size={4} wrap>
                  <Button size="small" onClick={() => void connectionsQuery.refetch()}>重试</Button>
                  <Button size="small" type="link" danger loading={connectionRecoveryBusy} onClick={confirmConnectionStoreRecovery}>备份并重建</Button>
                </Space>}
              />
            ) : connections.length === 0 ? (
              <div className="sidebar-empty"><Database size={20} /><span>还没有连接</span><Button type="link" size="small" onClick={() => { setConnectionSaveError(undefined); setConnectionModal(true); }}>添加数据库</Button></div>
            ) : connections.map((connection) => (
              <div className={`connection-card ${activeId === connection.id ? "selected" : ""}`} key={connection.id}>
                <button className="connection-select" onClick={() => { setActiveId(connection.id); setQueryFailure(undefined); setTestedConnection(undefined); if (connection.engine === "mongodb") setPage("mongo"); }}>
                  <span className={`db-icon ${activeId === connection.id ? "active" : ""}`}><Database size={15} /></span>
                  <span className="connection-name"><b>{connection.name}</b><small>{connection.path ?? connection.endpoint ?? `${connection.host}:${connection.port}`}</small></span>
                  {testedConnection === connection.id && <span className="connected-indicator" title="连接已测试" />}
                </button>
                <div className="connection-tools">
                  <Tooltip title="测试连接"><Button type="text" size="small" icon={<Wifi size={13} />} onClick={() => void testConnection(connection)} /></Tooltip>
                  <Tooltip title="编辑"><Button type="text" size="small" icon={<Settings2 size={13} />} onClick={() => { setEditingConnection(connection); setConnectionSaveError(undefined); setConnectionModal(true); }} /></Tooltip>
                  <Tooltip title="删除"><Button type="text" size="small" danger icon={<Trash2 size={13} />} onClick={() => removeConnection(connection)} /></Tooltip>
                </div>
              </div>
            ))}
          </div>
          {activeId && activeConnection?.engine === "mongodb" ? <div className="object-tree mongo-tree-hint">
            <div className="tree-label"><span>文档浏览器</span><Button type="text" size="small" icon={<RefreshCw size={13} />} onClick={() => setPage("mongo")} /></div>
            <Text type="secondary">MongoDB 按数据库和 Collection 浏览文档。</Text>
            <Button type="link" size="small" onClick={() => setPage("mongo")}>打开文档查询</Button>
          </div> : activeId && <Suspense fallback={<div className="object-tree"><Spin size="small" /></div>}>
            <DatabaseObjectTree
              data={treeData.filter((node) => node.key === activeId)}
              loading={schemasQuery.isLoading}
              error={schemasQuery.error ? errorText(schemasQuery.error) : undefined}
              onSearch={() => setObjectSearchOpen(true)}
              onRefresh={() => { void schemasQuery.refetch(); void tablesQuery.refetch(); }}
              onSelect={(keys) => { if (keys[0] === activeId) void tablesQuery.refetch(); }}
              getContextMenuItems={getTreeNodeMenuItems}
            />
          </Suspense>}
          <div className="sidebar-bottom"><div className="runtime-chip"><span className="runtime-dot" /><span>PostgreSQL · MySQL · MariaDB · SQLite · SQL Server · Oracle · MongoDB</span><span className="runtime-version">v0.1</span></div><div className="sidebar-footer">DB Studio <span>0.1.0 · Preview</span></div></div>
        </aside>

        <div
          aria-label="调整连接与工作区宽度"
          aria-orientation="vertical"
          aria-valuemax={SIDEBAR_WIDTH_MAX}
          aria-valuemin={SIDEBAR_WIDTH_MIN}
          aria-valuenow={Math.round(workspaceLayout.sidebarWidth)}
          className="pane-splitter sidebar-splitter"
          onKeyDown={(event: any) => handlePaneResizeKey("sidebar", event)}
          onPointerCancel={finishPaneResize}
          onPointerDown={(event: any) => startPaneResize("sidebar", event)}
          onPointerMove={movePaneResize}
          onPointerUp={finishPaneResize}
          role="separator"
          tabIndex={0}
          title="拖动调整连接面板宽度；方向键微调，Shift + 方向键大幅调整"
        ><span /></div>

        <main className="workspace">
          <div className="workspace-head">
            <div className="page-title"><div className="title-icon">{page === "query" ? <Code2 size={18} /> : page === "mongo" ? <Braces size={18} /> : <Globe2 size={18} />}</div><div><Title level={4}>{page === "query" ? "SQL 查询" : page === "mongo" ? "MongoDB 文档" : "GIS 数据交换"}</Title><Text>{page === "query" ? "编写 SQL 并直接查看执行结果" : page === "mongo" ? "浏览 Collection，筛选并分页查看 JSON/BSON 文档" : "查看矢量文件元数据，与多种空间数据库双向交换"}</Text></div></div>
            <div className="head-actions">
              <Select
                value={activeId} placeholder="选择数据库连接" className="connection-picker" allowClear
                onChange={(value: any) => { setActiveId(value); setQueryFailure(undefined); if (connections.find((item: any) => item.id === value)?.engine === "mongodb") setPage("mongo"); }}
                options={connections.map((connection) => ({ value: connection.id, label: connection.name }))}
              />
              <Button type={page === "query" ? "primary" : "default"} icon={<Code2 size={15} />} onClick={() => setPage("query")}>SQL 编辑器</Button>
              <Button type={page === "mongo" ? "primary" : "default"} icon={<Braces size={15} />} onClick={() => setPage("mongo")}>Mongo 文档</Button>
              <Button type={page === "gis" ? "primary" : "default"} icon={<Globe2 size={15} />} onClick={() => setPage("gis")}>GIS 交换</Button>
              {page !== "query" && <Button icon={<Sparkles size={15} />} onClick={() => openAiAssistant("generate")}>AI 助手</Button>}
            </div>
          </div>

          {page === "query" ? <section className="query-workspace" ref={queryWorkspaceRef}>
            <div className="editor-panel" ref={editorPanelRef} style={{ flex: `${workspaceLayout.editorShare} 1 0%` }}>
              <div className="panel-toolbar">
                <div className="document-tab"><FileCode2 size={14} /><span>{sqlPath?.split(/[\\/]/).pop() ?? "query.sql"}</span><span className="tab-dirty" /></div>
                <div className="toolbar-actions">
                  <Button size="small" icon={<FolderTree size={14} />} onClick={() => void openSql()}>打开</Button>
                  <Button size="small" icon={<Save size={14} />} onClick={() => void saveSql()}>保存</Button>
                  <Button size="small" icon={<Code2 size={14} />} title="格式化选中 SQL 或全文 · Alt+Shift+F" onClick={() => void formatCurrentSql()}>格式化</Button>
                  <Button size="small" icon={<Clock3 size={14} />} onClick={() => setQueryHistoryOpen(true)}>历史</Button>
                  <Button size="small" icon={<Sparkles size={14} />} onClick={() => openAiAssistant("generate")}>AI 助手</Button>
                  <Button size="small" icon={<Settings2 size={14} />} onClick={() => setAiSettingsOpen(true)}>模型设置</Button>
                  <span className="toolbar-separator" />
                  <Button type="primary" size="small" icon={<Play size={14} fill="currentColor" />} loading={queryBusy} onClick={() => void runQuery()}>执行查询</Button>
                </div>
              </div>
              <div className="editor-area">
                <Suspense fallback={<div className="gis-loading"><Spin size="small" /> 正在加载 SQL 编辑器</div>}>
                  <Editor
                    height="100%" language="sql" theme="vs" value={sql}
                    onChange={(value: any) => setSql(value ?? "")}
                    onMount={(editor: any, monaco: any) => {
                    editorRef.current = editor;
                    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => { void runQuery(); });
                    editor.addAction({
                      id: "db-studio.format-sql",
                      label: "格式化 SQL",
                      keybindings: [monaco.KeyMod.Alt | monaco.KeyMod.Shift | monaco.KeyCode.KeyF],
                      run: () => { void formatCurrentSql(); },
                    });
                    completionProviderRef.current?.dispose();
                    completionProviderRef.current = monaco.languages.registerCompletionItemProvider("sql", {
                      triggerCharacters: [".", " "],
                      async provideCompletionItems(model: MonacoEditor.ITextModel, position: IPosition) {
                        const context = completionContextRef.current;
                        if (!context.connectionId || !context.engine || !context.schema || !context.tables.length) return { suggestions: [] };
                        const { getSqlCompletionContext, quoteSqlIdentifier, sameSqlCompletionScope } = await import("./sql-completion");
                        const currentContext = completionContextRef.current;
                        if (!sameSqlCompletionScope(context, currentContext)) return { suggestions: [] };
                        const sql = model.getValue();
                        const cursorOffset = model.getOffsetAt(position);
                        const beforeCursor = sql.slice(0, cursorOffset);
                        const afterCursor = sql.slice(cursorOffset);
                        const completion = getSqlCompletionContext(beforeCursor, context.tables, context.schema, afterCursor);
                        if (!completion) return { suggestions: [] };
                        const word = model.getWordUntilPosition(position);
                        const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
                        if (completion.kind === "table") {
                          const rows = context.tables.filter((table) =>
                            (completion.schemaPrefix
                              ? table.schema.toLocaleLowerCase().startsWith(completion.schemaPrefix.toLocaleLowerCase())
                              : table.schema === context.schema)
                            && table.name.toLocaleLowerCase().startsWith(completion.prefix.toLocaleLowerCase()),
                          );
                          const cteSuggestions = (completion.cteNames ?? [])
                            .filter((name: any) => name.toLocaleLowerCase().startsWith(completion.prefix.toLocaleLowerCase()))
                            .slice(0, 100)
                            .map((name: any) => ({
                              label: name,
                              kind: monaco.languages.CompletionItemKind.Class,
                              detail: "公共表表达式",
                              insertText: quoteSqlIdentifier(context.engine!, name),
                              range,
                            }));
                          const tableSuggestions = rows.slice(0, 100).map((table) => ({
                            label: table.schema + "." + table.name,
                            kind: monaco.languages.CompletionItemKind.Class,
                            detail: table.type === "view" ? "视图" : "数据表",
                            insertText: completion.qualified
                              ? quoteSqlIdentifier(context.engine!, table.name)
                              : quotedTable(context.engine!, table.schema, table.name),
                            range,
                          }));
                          return { suggestions: [...cteSuggestions, ...tableSuggestions].slice(0, 100) };
                        }
                        if (completion.columns) {
                          return { suggestions: completion.columns
                            .filter((name: any) => name.toLocaleLowerCase().startsWith(completion.prefix.toLocaleLowerCase()))
                            .slice(0, 100)
                            .map((name: any) => ({
                                  label: name,
                                  kind: monaco.languages.CompletionItemKind.Field,
                                  detail: "CTE 输出列",
                                  insertText: quoteSqlIdentifier(context.engine!, name),
                                  range,
                                })) };
                              }
                              if (!completion.table) return { suggestions: [] };
                               const completionTable = completion.table as any;
                              const cacheKey = [
                                context.connectionId,
                                context.database,
                                completionTable.schema,
                                completionTable.name,
                              ].join("\0");
                              let cached = completionColumnsRef.current.get(cacheKey);
                              if (!cached || Date.now() - cached.fetchedAt > 60_000) {
                                try {
                                  const columns = await window.dbStudio.database.columns(
                                    context.connectionId,
                                    completionTable.name,
                                    completionTable.schema,
                                  );
                                  if (!sameSqlCompletionScope(context, currentContext)) return { suggestions: [] };
                                  cached = { fetchedAt: Date.now(), columns };
                                  completionColumnsRef.current.set(cacheKey, cached);
                                  completionColumnFailuresRef.current.delete(cacheKey);
                                } catch {
                                  if (!sameSqlCompletionScope(context, currentContext)) return { suggestions: [] };
                                  if (!completionColumnFailuresRef.current.has(cacheKey)) {
                                    completionColumnFailuresRef.current.add(cacheKey);
                                    message.error(`读取 ${completionTable.schema}.${completionTable.name} 的列信息失败，请检查连接后重试。`);
                                  }
                                  return { suggestions: [] };
                                }
                              }
                              return { suggestions: cached.columns
                                .filter((column) => column.name.toLocaleLowerCase().startsWith(completion.prefix.toLocaleLowerCase()))
                                .slice(0, 100)
                                .map((column) => ({
                                  label: column.name,
                                  kind: monaco.languages.CompletionItemKind.Field,
                                  detail: column.dataType,
                                  insertText: quoteSqlIdentifier(context.engine!, column.name),
                                  range,
                                })) };
                            },
                          });
                          editorRef.current?.focus();
                        }}
                        options={{
                          fontSize: 13,
                          fontFamily: "Cascadia Code, Consolas, monospace",
                          minimap: { enabled: false },
                          lineNumbers: "on",
                          scrollBeyondLastLine: false,
                          wordWrap: "on",
                          automaticLayout: true,
                          padding: { top: 14 },
                          renderLineHighlight: "gutter",
                          tabSize: 2,
                        }}
                    />
                  </Suspense>
                </div>
                <div className="editor-status">
                  <span>{activeConnection ? engineLabels[activeConnection.engine as keyof typeof engineLabels] ?? activeConnection.engine : "SQL"}</span>
                  <span>UTF-8</span>
                  <span>Ctrl + Enter 执行</span>
                  <span className="status-spacer" />
                  <span>{sqlPath ?? "未保存"}</span>
                </div>
              </div>
              <div
                aria-label="调整 SQL 编辑器与结果面板高度"
                aria-orientation="horizontal"
                aria-valuemax={Math.round(EDITOR_SHARE_MAX * 100)}
                aria-valuemin={Math.round(EDITOR_SHARE_MIN * 100)}
                aria-valuenow={Math.round(workspaceLayout.editorShare * 100)}
                className="pane-splitter query-splitter"
                onKeyDown={(event: any) => handlePaneResizeKey("query", event)}
                onPointerCancel={finishPaneResize}
                onPointerDown={(event: any) => startPaneResize("query", event)}
                onPointerMove={movePaneResize}
                onPointerUp={finishPaneResize}
                role="separator"
                tabIndex={0}
                title="拖动调整编辑器与查询结果高度；方向键微调，Shift + 方向键大幅调整"
              >
                <span />
              </div>
              <div className="results-panel" ref={resultsPanelRef} style={{ flex: `${1 - workspaceLayout.editorShare} 1 0%` }}>
                <div className="results-toolbar">
                  <div className="results-title"><Database size={15} /><b>结果</b>{result && <Tag bordered={false}>{result.command ?? "QUERY"}</Tag>}</div>
                  <div className="results-toolbar-right">
                    {result && <div className="results-actions">
                      <Button size="small" onClick={() => void exportQueryResult("csv")}>导出 CSV</Button>
                      <Button size="small" onClick={() => void exportQueryResult("json")}>导出 JSON</Button>
                    </div>}
                    <div className="results-meta">{result ? <><span>{result.rowCount} 行</span><span className="meta-dot">·</span><span>{result.columns.length} 列</span></> : <span>等待执行查询</span>}</div>
                  </div>
                </div>
                {queryFailure && queryFailure.connectionId === activeId && <div className="query-failure">
                  <div><b>查询失败</b><span>{queryFailure.code ? queryFailure.code + " · " : ""}{queryFailure.message}</span></div>
                  <Button size="small" icon={<Sparkles size={13} />} onClick={() => openAiAssistant("repair")}>AI 修复</Button>
                </div>}
              {result ? <Suspense fallback={<Spin size="small" />}><LazyDataTable
                size="small" className="query-table" columns={columns} dataSource={dataSource}
                scroll={{ x: "max-content", y: "calc(100vh - 590px)" }} pagination={{ pageSize: 50, showSizeChanger: false, showTotal: (total: any, range: any) => `${range[0]}–${range[1]} / ${total}` }}
              /></Suspense> : <div className="results-empty"><div className="empty-icon"><Activity size={20} /></div><b>运行一条查询以查看结果</b><span>结果会显示在这里，可使用参数绑定和常见 SQL 语句。</span></div>}
            </div>
          </section> : page === "mongo" ? activeId && activeConnection?.engine === "mongodb"
            ? <Suspense fallback={<div className="gis-loading"><Spin size="small" /> 正在加载 MongoDB 文档页</div>}>
                <MongoDocumentsPage key={activeId} connectionId={activeId} defaultDatabase={activeConnection.database} />
              </Suspense>
            : <div className="mongo-no-connection"><Empty description="选择一个 MongoDB 连接以浏览文档" /></div>
          : <section className="gis-workspace">
            <div className="gis-top-grid">
              <Card className="gis-card file-card" title={<div className="card-heading"><span className="card-icon purple"><Layers3 size={17} /></span><div><b>矢量文件</b><small>读取图层、字段与坐标参考系</small></div></div>} extra={<Tag color="purple">OGR</Tag>}>
                <Button block className="file-picker" icon={<Upload size={15} />} disabled={Boolean(gisOperationId) || gisValidationBusy} onClick={() => void chooseGisFile()}>{gisFile ? "更换文件" : "选择矢量文件"}</Button>
                <Space.Compact className="gis-export-table-control">
                  <Input
                    aria-label="矢量文件或 GDAL /vsizip 路径"
                    value={gisFile}
                    onChange={(event: any) => {
                      setGisFile(event.target.value);
                      setReplaceIncompleteUtf8Tails(false);
                      setGisInfo(undefined); setGisPreview(undefined); setGisValidation(undefined); setGisSpatialFilter(null); setSelectedGisLayer(""); setSourceEncoding("");
                    }}
                    onPressEnter={() => void loadGisFile(gisFile)}
                    placeholder="本地路径，或 /vsizip/F:/data/archive.zip/folder/layer.tab"
                  />
                  <Button disabled={!gisFile.trim() || gisBusy || Boolean(gisOperationId)} onClick={() => void loadGisFile(gisFile)}>读取路径</Button>
                </Space.Compact>
                <div className="form-row">
                  <label>ZIP 文件名编码</label>
                  <Space.Compact className="gis-export-table-control">
                    <Input
                      aria-label="ZIP 文件名编码"
                      disabled={gisBusy || Boolean(gisOperationId)}
                      value={zipFilenameEncoding}
                      onChange={(event: any) => { setZipFilenameEncoding(event.target.value); setGisPreview(undefined); setGisValidation(undefined); }}
                      onPressEnter={() => void loadGisFile(gisFile)}
                      placeholder="默认；必要时填写 UTF-8 或 CP936"
                    />
                    <Button disabled={!gisFile.trim() || gisBusy || Boolean(gisOperationId)} onClick={() => void loadGisFile(gisFile)}>应用并重读</Button>
                  </Space.Compact>
                </div>
                <Text type="secondary" className="gis-field-mapping-note">此编码只用于 ZIP 成员名称；TAB/DBF 属性文字使用下方的源编码设置。</Text>
                {gisBusy && !gisInfo ? <div className="gis-loading"><Spin size="small" /> 正在读取文件元数据</div> : gisInfo ? <div className="layer-list">{gisInfo.layers.map((layer: GisLayerInfo) => <div className="layer-summary" key={layer.name}><div className="layer-glyph"><Braces size={15} /></div><div className="layer-copy"><b>{layer.name}</b><span>{layer.geometryType ?? "无几何"} · {layer.featureCount ?? "未知"} 个要素</span></div><Tag>{crsLabel(layer.crs)}</Tag></div>)}</div> : <div className="drop-hint">支持 SHP、GeoJSON、KML、TAB、GPKG；也可输入 ZIP 内成员 /vsizip 路径</div>}
                {gisInfo?.warnings && gisInfo.warnings.length > 0 && <Alert
                  className="inline-alert" showIcon type="warning" message="文件配套检查"
                  description={<ul>{gisInfo.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>}
                />}
                {(activeConnection?.engine === "mysql" || activeConnection?.engine === "mariadb") && <Alert
                  className="inline-alert" showIcon type="info" message="MySQL/MariaDB 直接导入"
                  description="数据经临时 GeoPackage 分批导入；支持字段重命名/类型转换、源坐标范围筛选、GDAL MakeValid，以及显式 UTF-8 独立 Shapefile 的末尾截断修复。"
                />}
                {activeConnection?.engine === "sqlserver" && <Alert
                  className="inline-alert" showIcon type="info" message="SQL Server 直接导入"
                  description="空间列可选 geometry 或 geography；支持字段重命名/类型转换、源坐标系范围筛选、GDAL MakeValid，以及显式 UTF-8 独立 Shapefile 的末尾截断修复。"
                />}
              </Card>
              <Card className="gis-card transfer-card" title={<div className="card-heading"><span className="card-icon teal"><Database size={17} /></span><div><b>目标数据库</b><small>SQLite/SpatiaLite、GeoPackage、PostGIS、MySQL 系列、SQL Server 和 Oracle 支持矢量导入</small></div></div>} extra={activeConnection ? <Tag color="green">已选择</Tag> : <Tag>未连接</Tag>}>
                <Select className="wide-control" value={["sqlite", "postgres", "mysql", "mariadb", "sqlserver", "oracle"].includes(activeConnection?.engine ?? "") ? activeId : undefined} placeholder="选择数据库连接" onChange={(id: string) => {
                  const nextConnection = connections.find((connection) => connection.id === id);
                  setActiveId(id);
                  if (nextConnection?.engine === "sqlite") {
                    setTargetTable((current) => current.split(".").at(-1) ?? current);
                  } else if (nextConnection?.engine === "mysql" || nextConnection?.engine === "mariadb") {
                    setTargetTable((current) => current.startsWith("public.") ? current.slice("public.".length) : current);
                  } else if (nextConnection?.engine === "postgres") {
                    setTargetTable((current) => current.includes(".") ? current : `public.${current}`);
                  } else if (nextConnection?.engine === "sqlserver") {
                    setTargetTable((current) => current.includes(".") ? current : `dbo.${current}`);
                  } else if (nextConnection?.engine === "oracle") {
                    setGisSpatialFilter(null);
                    setMakeValidGeometries(false);
                    setReplaceIncompleteUtf8Tails(false);
                    setGisFieldMappings((currentMappings) => currentMappings.map((mapping) => ({ source: mapping.source, target: mapping.source })));
                    setTargetTable((current) => {
                      const tableName = current.split(".").at(-1) || current;
                      return nextConnection.user ? `${nextConnection.user}.${tableName}` : tableName;
                    });
                  }
                }} options={connections.filter((connection) => ["sqlite", "postgres", "mysql", "mariadb", "sqlserver", "oracle"].includes(connection.engine)).map((connection) => ({ value: connection.id, label: `${connection.name} · ${connection.engine} · ${connection.database}` }))} />
                <div className="transfer-subline"><span>连接目标</span><b>{activeConnection?.engine === "sqlite" ? activeConnection.name : activeConnection ? `${activeConnection.host}:${activeConnection.port}/${activeConnection.database}` : "选择数据库连接"}</b></div>
                {activeConnection?.engine === "oracle" && <Alert className="inline-alert" showIcon type="info" message="Oracle SDO_GEOMETRY 导入/导出" description="目标表请使用 schema.table。仅支持 XY 几何；可在新建或覆盖表时登记 Oracle 空间元数据并创建索引，追加时要求目标已有有效索引且新数据位于已登记范围内。" />}
                {activeConnection?.engine === "sqlite" && <Alert className="inline-alert" showIcon type="info" message="SQLite 空间导入" description="新建数据库默认为 SpatiaLite；.gpkg 路径创建 GeoPackage。已有数据库必须包含 SpatiaLite 或 GeoPackage 空间元数据，普通 SQLite 文件不会被自动改写。" />}
                {activeConnection?.engine !== "sqlite" && activeConnection?.engine !== "postgres" && activeConnection?.engine !== "mysql" && activeConnection?.engine !== "mariadb" && activeConnection?.engine !== "sqlserver" && activeConnection?.engine !== "oracle" && <Alert className="inline-alert" showIcon type="info" message="矢量文件导入支持 SQLite/SpatiaLite、GeoPackage、PostGIS、MySQL、MariaDB、SQL Server 和 Oracle。" />}
              </Card>
            </div>

            <div className="gis-action-grid">
              <Card className="gis-card action-card" title={<div className="card-heading"><span className="card-icon amber"><FileInput size={17} /></span><div><b>导入到 {activeConnection?.engine === "sqlite" ? "SQLite/SpatiaLite" : activeConnection?.engine === "mysql" ? "MySQL" : activeConnection?.engine === "mariadb" ? "MariaDB" : activeConnection?.engine === "sqlserver" ? "SQL Server" : activeConnection?.engine === "oracle" ? "Oracle SDO_GEOMETRY" : "PostGIS"}</b><small>矢量文件 → 空间数据表</small></div></div>}>
                {gisInfo && <div className="form-row"><label>源图层</label><Select
                  value={selectedGisLayerInfo?.name}
                  disabled={gisBusy || gisValidationBusy || gisInfo.layers.length === 0}
                  placeholder="选择要导入的图层"
                  options={gisInfo.layers.map((layer) => ({ value: layer.name, label: `${layer.name} · ${layer.featureCount ?? "未知"} 个要素` }))}
                  onChange={(name: string) => {
                    setGisValidation(undefined);
                    const layer = gisInfo.layers.find((candidate) => candidate.name === name);
                    setSelectedGisLayer(name);
                    setGisPreview(undefined);
                    setGisSpatialFilter(null);
                    setGisFieldMappings((layer?.fields ?? []).map((field) => ({ source: field.name, target: field.name })));
                    setTargetTable(suggestedGisTargetTable(name, activeConnection?.engine, activeConnection?.user));
                    const detectedCrs = layer?.crs ?? "";
                    setSourceCrs(detectedCrs.length <= 48 ? detectedCrs : "");
                    void refreshGisPreview(gisFile, name, sourceEncoding);
                  }}
                /></div>}
                <div className="form-row"><label>目标表</label><Input value={targetTable} onChange={(event: any) => setTargetTable(event.target.value)} placeholder={activeConnection?.engine === "sqlite" || activeConnection?.engine === "mysql" || activeConnection?.engine === "mariadb" ? "roads" : activeConnection?.engine === "sqlserver" ? "dbo.roads" : activeConnection?.engine === "oracle" ? "SYSTEM.ROADS" : "public.roads"} /></div>
                {activeConnection?.engine === "sqlserver" && <div className="form-row"><label>SQL Server 空间列类型</label><Select value={sqlServerSpatialColumnType} onChange={setSqlServerSpatialColumnType} options={[{ value: "geometry", label: "geometry（平面）" }, { value: "geography", label: "geography（地理坐标）" }]} /></div>}
                {activeConnection?.engine === "sqlserver" && sqlServerSpatialColumnType === "geography" && <Alert className="crs-warning" showIcon type="info" message="geography 需要 SQL Server 支持的地理 CRS 与非零 SRID；导入前会检查空间参考目录。投影坐标请先转换到合适的地理 CRS。" />}
                <div className="form-row"><label>导入模式</label><Select value={importMode} onChange={(mode) => { setImportMode(mode); if (mode !== "create") setInitializeGisSpatialite(false); }} options={[{ value: "create", label: "新建表（已存在则报错）" }, { value: "append", label: "追加到现有表" }, { value: "overwrite", label: "覆盖现有表" }]} /></div>
                {activeConnection?.engine === "sqlite" && <div className="form-row"><label>普通 SQLite</label><div>
                  <Suspense fallback={null}><LazyGisCheckbox checked={initializeGisSpatialite} disabled={gisBusy || importMode !== "create"} onChange={(event: any) => setInitializeGisSpatialite(event.target.checked)}>为现有普通 SQLite 文件初始化 SpatiaLite</LazyGisCheckbox></Suspense>
                  <Text type="secondary" className="gis-field-mapping-note">仅在 create 模式使用；会添加 SpatiaLite 元数据表并保留已有业务表。仅勾选后才初始化，初始化成功后即使后续要素导入失败，元数据也可能保留。GeoPackage 文件不使用此选项。</Text>
                </div></div>}
                {activeConnection && ["sqlite", "oracle", "mysql", "mariadb", "sqlserver"].includes(activeConnection.engine) && <div className="form-row"><label>空间索引</label><div>
                  <Suspense fallback={null}><LazyGisCheckbox checked={createGisSpatialIndex} disabled={gisBusy} onChange={(event: any) => setCreateGisSpatialIndex(event.target.checked)}>{importMode === "append" && ["sqlite", "oracle", "mysql", "mariadb", "sqlserver"].includes(activeConnection.engine) ? "沿用并维护现有空间索引" : "导入后创建空间索引"}</LazyGisCheckbox></Suspense>
                  {createGisSpatialIndex && activeConnection.engine === "sqlite" && <Text type="secondary" className="gis-field-mapping-note">SpatiaLite 使用 RTree 空间索引；GeoPackage 使用 RTree 扩展。追加时由 GDAL 维护已有索引。</Text>}
                  {createGisSpatialIndex && activeConnection.engine === "oracle" && importMode !== "append" && <Text type="secondary" className="gis-field-mapping-note">仅适用于当前连接用户的 schema、非空 XY 几何和已知 SRID。新建/覆盖时会先在目标表或 staging 表登记元数据并创建索引；覆盖通过索引状态校验后再换表。表名与几何列名转为大写简单标识（最多 30 字符）；范围外扩 5%，容差为 0.05，请按坐标系与精度复核。</Text>}
                  {createGisSpatialIndex && activeConnection.engine === "oracle" && importMode === "append" && <Text type="secondary" className="gis-field-mapping-note">追加前要求目标几何列已有状态 VALID 的 Oracle 空间索引、匹配的 X/Y 元数据和 SRID；源图层范围必须完全落在已登记范围内，否则不会写入。</Text>}
                  {createGisSpatialIndex && ["mysql", "mariadb"].includes(activeConnection.engine) && importMode !== "append" && <Text type="secondary" className="gis-field-mapping-note">新建或覆盖表要求已知正 SRID 且所有要素都有几何。几何列将设为 NOT NULL 并限定到图层 SRID；覆盖先在 staging 表建索引并核验后再换表。</Text>}
                  {createGisSpatialIndex && ["mysql", "mariadb"].includes(activeConnection.engine) && importMode === "append" && <Text type="secondary" className="gis-field-mapping-note">追加要求目标几何列已有单列 SPATIAL 索引、NOT NULL 约束和相同正 SRID；MariaDB 还要求对该几何列/SRID 生效的 CHECK 约束。导入数据不得含 NULL 几何，索引会在追加后复核。</Text>}
                  {createGisSpatialIndex && activeConnection.engine === "sqlserver" && importMode !== "append" && <Text type="secondary" className="gis-field-mapping-note">新建或覆盖时会将暂存 GeoPackage 的整数要素 ID 设为聚集主键。geometry 索引使用图层 XY 范围外扩 5% 的边界框；geography 使用自动网格。覆盖在 staging 表核验索引和主键后再换表。</Text>}
                  {createGisSpatialIndex && activeConnection.engine === "sqlserver" && importMode === "append" && <Text type="secondary" className="gis-field-mapping-note">追加要求目标已有启用的 SPATIAL 索引，且聚集主键是暂存 GeoPackage 要素 ID。geometry 输入范围必须完全落在现有索引边界框内；geography 使用全局自动网格。追加后会复核索引和主键。</Text>}
                </div></div>}
                <div className="form-row"><label>几何有效性</label><div>
                  <Button size="small" loading={gisValidationBusy} disabled={!gisFile || !selectedGisLayerInfo || gisBusy} onClick={() => void checkGisGeometry()}>检查几何并报告错误</Button>
                  <Suspense fallback={null}><LazyGisCheckbox checked={makeValidGeometries} disabled={gisBusy || !["sqlite", "postgres", "mysql", "mariadb", "sqlserver", "oracle"].includes(activeConnection?.engine ?? "")} onChange={(event: any) => setMakeValidGeometries(event.target.checked)}>导入前修复无效几何（GDAL MakeValid）</LazyGisCheckbox></Suspense>
                  {(!activeConnection || !["sqlite", "postgres", "mysql", "mariadb", "sqlserver", "oracle"].includes(activeConnection.engine)) && <Text type="secondary" className="gis-field-mapping-note">请选择支持矢量导入的数据库连接后启用几何修复。</Text>}
                  {makeValidGeometries && <Text type="secondary" className="gis-field-mapping-note">修复可能改变几何类型、使几何变空，或从混合结果中移除较低维的部分。完全坍塌的要素可能变成线或点。</Text>}
                </div></div>
                {gisValidation && <Alert
                  className="inline-alert" showIcon type={gisValidation.issueCount > 0 ? "warning" : "success"}
                  message={`图层“${gisValidation.layer}”：检查 ${gisValidation.featureCount ?? "未知"} 个要素，发现 ${gisValidation.issueCount} 条几何问题`}
                  description={<><div>{gisValidation.geometryCounts.map((count) => <div key={count.field ?? "geometry"}>{count.field ? `几何字段“${count.field}”` : "几何"}：NULL {count.nullGeometryCount} 个，空几何 {count.emptyGeometryCount} 个（计数 {count.featureCount} 个要素）</div>)}</div><ul>{gisValidation.issues.map((issue: any, index: any) => <li key={`${issue.reason}-${index}`}>{issue.reason}{issue.locations.length > 0 ? `（位置 ${issue.locations.map(({ x, y }: any) => `${x}, ${y}`).join("；")}）` : ""}</li>)}</ul>{gisValidation.issuesTruncated && <Text type="secondary">仅显示前 {gisValidation.issues.length} 条错误记录。</Text>}<ul>{gisValidation.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></>}
                />}
                {gisInfo && <>
                  <div className="form-row crs-row"><label>源编码</label><Space.Compact className="gis-export-table-control">
                    <Input disabled={gisValidationBusy} value={sourceEncoding} onChange={(event: any) => { setSourceEncoding(event.target.value); setGisPreview(undefined); setGisValidation(undefined); setGisSpatialFilter(null); }} placeholder={gisInfo.encoding.declaredEncoding ?? gisInfo.encoding.detectedEncoding ?? "自动识别；不确定时填写 GBK 等编码"} />
                    <Button loading={previewBusy} disabled={!gisFile} onClick={() => void refreshGisPreview()}>预览属性</Button>
                  </Space.Compact></div>
                  {canReplaceIncompleteUtf8Tails && <div className="form-row"><label>UTF-8 截断</label><div>
                    <Suspense fallback={null}><LazyGisCheckbox checked={replaceIncompleteUtf8Tails} disabled={gisBusy || !["sqlite", "postgres", "mysql", "mariadb", "sqlserver", "oracle"].includes(activeConnection?.engine ?? "")} onChange={(event: any) => setReplaceIncompleteUtf8Tails(event.target.checked)}>仅替换字段末尾不完整字符</LazyGisCheckbox></Suspense>
                    <Text type="secondary" className="gis-field-mapping-note">仅用于已明确选择 UTF-8 的独立 Shapefile 导入；临时副本中字段末尾的不完整字符会替换为 ?，源文件不变。字段内部的无效 UTF-8、ZIP 内 Shapefile 和其他格式仍会报错。</Text>
                  </div></div>}
                  {displayGisEncoding && <div className="transfer-subline"><span>识别结果</span><b>{displayGisEncoding.declaredEncoding ?? displayGisEncoding.detectedEncoding ?? "编码不确定"} · {displayGisEncodingSource}{displayGisEncoding.confidence == null ? "" : ` · ${Math.round(displayGisEncoding.confidence * 100)}%`}</b></div>}
                  {gisPreview?.requiresUserChoice && <Alert className="inline-alert" showIcon type="warning" message="无法可靠判断源编码" description="请填写实际编码并重新预览；确认中文属性正确后才能导入。" />}
                  {gisPreview && !gisPreview.requiresUserChoice && <>
                    {gisPreview.warnings.length > 0 && <Alert className="inline-alert" showIcon type="warning" message="编码预览提示" description={<ul>{gisPreview.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>} />}
                    {gisPreview.features.length > 0 && <Suspense fallback={<div className="gis-loading"><Spin size="small" /> 正在加载地图预览</div>}>
                      <GisPreviewMap
                        features={gisPreview.features}
                        selectedExtent={gisSpatialFilter}
                        coordinateReference={crsLabel(sourceCrs.trim() || selectedGisLayerInfo?.crs || null)}
                        disabled={gisBusy}
                        onExtentChange={setGisSpatialFilter}
                      />
                    </Suspense>}
                    {gisPreview.rows.length > 0 && <Suspense fallback={<Spin size="small" />}><LazyDataTable
                      size="small" className="query-table gis-preview-table"
                      columns={gisPreview.fields.map((field) => ({ title: field.name, dataIndex: field.name, key: field.name, ellipsis: true, render: (value: unknown) => cellText(value) }))}
                      dataSource={gisPreview.rows.map((row: any, index: any) => ({ ...row, key: index }))}
                      scroll={{ x: "max-content", y: 180 }} pagination={false}
                    /></Suspense>}
                  </>}
                </>}
                {selectedGisLayerInfo?.fields.length ? <div className="gis-field-mapping">
                  <div className="gis-field-mapping-heading"><span>源字段</span><span>目标字段</span><span>目标类型</span></div>
                  {selectedGisLayerInfo.fields.map((field) => {
                    const mapping = gisFieldMappings.find((item: any) => item.source === field.name) ?? { source: field.name, target: field.name };
                    return <div className="gis-field-mapping-row" key={field.name}>
                      <Tooltip title={`${field.name} · ${field.type}`}><Text code ellipsis>{field.name}</Text></Tooltip>
                      <Input size="small" aria-label={`${field.name} 的目标字段`} value={mapping.target} onChange={(event: any) => updateGisFieldMapping(field.name, { target: event.target.value })} />
                      <Select size="small" aria-label={`${field.name} 的目标类型`} value={mapping.targetType ?? ""} options={gisFieldTypeOptions} onChange={(value: GisFieldTargetType | "") => updateGisFieldMapping(field.name, { targetType: value || undefined })} />
                    </div>;
                  })}
                  <Text type="secondary" className="gis-field-mapping-note">字段改名和类型转换由 GDAL 导入阶段执行；无法转换的值会使导入失败。</Text>
                </div> : null}
                <div className="form-row crs-row"><label>源 CRS</label><Input value={sourceCrs} onChange={(event: any) => setSourceCrs(event.target.value)} placeholder="读取文件值，或手动指定" /></div>
                <div className="form-row crs-row"><label>目标 CRS</label><Input value={importTargetCrs} onChange={(event: any) => setImportTargetCrs(event.target.value)} placeholder="例如 EPSG:4326" /></div>
                <div className="form-row"><label>坐标操作（可选）</label><Input.TextArea value={importCoordinateOperation} onChange={(event: any) => setImportCoordinateOperation(event.target.value)} placeholder="PROJ pipeline；需同时指定目标 CRS" autoSize={{ minRows: 2, maxRows: 4 }} maxLength={4096} showCount /><Text type="secondary">完整填写 PROJ pipeline（包括需要的轴序/单位步骤），并确认适用区域及所需 Datum Grid。</Text></div>
                {importCoordinateOperation.trim() && !importTargetCrs.trim() && <Alert className="crs-warning" showIcon type="warning" message="指定坐标操作时必须同时填写目标 CRS。" />}
                {selectedGisLayerInfo && selectedGisLayerInfo.crs == null && <Alert className="crs-warning" showIcon type="warning" message="源图层没有 CRS。请明确填写源 CRS 后再转换。" />}
                <Button type="primary" icon={<Download size={15} />} loading={gisBusy} disabled={!gisFile || !selectedGisLayerInfo || !gisPreview || gisPreview.requiresUserChoice || gisPreview.layer !== selectedGisLayerInfo.name || !["sqlite", "postgres", "mysql", "mariadb", "sqlserver", "oracle"].includes(activeConnection?.engine ?? "")} onClick={() => void importGis()}>{gisSpatialFilter ? "按范围导入" : "导入数据"}</Button>
              </Card>

              <Card className="gis-card action-card" title={<div className="card-heading"><span className="card-icon blue"><FileOutput size={17} /></span><div><b>从空间数据库导出</b><small>SQLite/SpatiaLite、GeoPackage、PostGIS、MySQL、MariaDB、SQL Server、Oracle → 矢量文件</small></div></div>}>
                <div className="form-row"><label>源表</label><Space.Compact className="gis-export-table-control">
                  <Input value={sourceTable} onChange={(event: any) => { setSourceTable(event.target.value); setExportFieldMappings([]); }} placeholder={activeConnection?.engine === "sqlite" ? "roads" : activeConnection?.engine === "postgres" ? "public.roads" : activeConnection?.engine === "sqlserver" ? "dbo.roads" : activeConnection?.engine === "oracle" ? "SYSTEM.ROADS" : "roads 或 database.roads"} />
                  <Button loading={exportFieldsBusy} disabled={!sourceTable || (activeConnection?.engine !== "postgres" && activeConnection?.engine !== "sqlite" && activeConnection?.engine !== "sqlserver")} onClick={() => void inspectExportTable()}>读取字段</Button>
                </Space.Compact></div>
                {(activeConnection?.engine === "postgres" || activeConnection?.engine === "sqlite" || activeConnection?.engine === "sqlserver") && exportFieldMappings.length > 0 && <div className="gis-field-mapping">
                  <div className="gis-field-mapping-heading"><span>源字段</span><span>输出字段</span><span>输出类型</span></div>
                  {exportFieldMappings.map((mapping) => <div className="gis-field-mapping-row" key={mapping.source}>
                    <Tooltip title={mapping.source}><Text code ellipsis>{mapping.source}</Text></Tooltip>
                    <Input size="small" aria-label={`${mapping.source} 的输出字段`} value={mapping.target} onChange={(event: any) => updateExportFieldMapping(mapping.source, { target: event.target.value })} />
                    <Select size="small" aria-label={`${mapping.source} 的输出类型`} value={mapping.targetType ?? ""} options={gisFieldTypeOptions} onChange={(value: GisFieldTargetType | "") => updateExportFieldMapping(mapping.source, { targetType: value || undefined })} />
                  </div>)}
                  <Text type="secondary" className="gis-field-mapping-note">将字段留空类型可保留可映射的源类型；目标格式仍可能有自身类型限制。</Text>
                </div>}
                <div className="form-row crs-row"><label>输出图层名（可选）</label><Input aria-label="输出图层名" value={exportTargetLayerName} onChange={(event: any) => setExportTargetLayerName(event.target.value)} placeholder="留空时使用输出文件名" /></div>
                <div className="form-row"><label>数据集创建选项</label><Input.TextArea aria-label="数据集创建选项" value={exportDatasetCreationOptions} onChange={(event: any) => setExportDatasetCreationOptions(event.target.value)} placeholder="每行一个 NAME=VALUE；使用当前输出格式的 GDAL 选项" autoSize={{ minRows: 2, maxRows: 4 }} maxLength={16_384} /></div>
                <div className="form-row"><label>图层创建选项</label><Input.TextArea aria-label="图层创建选项" value={exportLayerCreationOptions} onChange={(event: any) => setExportLayerCreationOptions(event.target.value)} placeholder="每行一个 NAME=VALUE；例如 GeoPackage 的 SPATIAL_INDEX=NO" autoSize={{ minRows: 2, maxRows: 4 }} maxLength={16_384} /></div>
                <div className="form-row crs-row"><label>源 CRS（可选）</label><Input value={exportSourceCrs} onChange={(event: any) => setExportSourceCrs(event.target.value)} placeholder="数据库无 SRID 定义时指定，例如 EPSG:4326" /></div>
                <div className="form-row crs-row"><label>范围过滤（源 CRS，可选）</label><Input aria-label="导出范围过滤" value={exportSpatialFilterText} onChange={(event: any) => setExportSpatialFilterText(event.target.value)} placeholder="minX,minY,maxX,maxY，例如 104,30.5,104.2,30.7" /><Text type="secondary">仅导出与该矩形相交的要素；坐标按数据源 CRS 解释。</Text></div>
                <div className="form-row crs-row"><label>目标 CRS</label><Input value={exportTargetCrs} onChange={(event: any) => setExportTargetCrs(event.target.value)} placeholder="GeoJSON/KML 固定 WGS 84；其他格式可指定" /></div>
                <div className="form-row"><label>坐标操作（可选）</label><Input.TextArea value={exportCoordinateOperation} onChange={(event: any) => setExportCoordinateOperation(event.target.value)} placeholder="PROJ pipeline；需同时指定目标 CRS" autoSize={{ minRows: 2, maxRows: 4 }} maxLength={4096} showCount /><Text type="secondary">完整填写 PROJ pipeline（包括需要的轴序/单位步骤），并确认适用区域及所需 Datum Grid。</Text></div>
                {exportCoordinateOperation.trim() && !exportTargetCrs.trim() && <Alert className="crs-warning" showIcon type="warning" message="指定坐标操作时必须同时填写目标 CRS。" />}
                <div className="form-row crs-row"><label>目标编码</label><Input value={targetEncoding} onChange={(event: any) => setTargetEncoding(event.target.value)} placeholder="Shapefile / TAB 默认 UTF-8" /></div>
                <div className="format-hint"><span>可导出格式</span><div><Tag>GeoPackage</Tag><Tag>GeoJSON</Tag><Tag>Shapefile</Tag><Tag>KML</Tag><Tag>MapInfo TAB</Tag></div></div>
                <Button type="primary" icon={<FileOutput size={15} />} loading={gisBusy} disabled={!activeConnection || !["sqlite", "postgres", "mysql", "mariadb", "sqlserver", "oracle"].includes(activeConnection.engine)} onClick={() => void exportGis()}>选择路径并导出</Button>
              </Card>
            </div>

            {gisOperationId && <Card className="gis-card gis-progress-card">
              <div className="gis-progress-head"><b>正在{gisOperationKind === "import" ? "导入" : "导出"} GIS 数据</b><Button danger size="small" onClick={() => window.dbStudio.gis.cancel(gisOperationId)}>取消操作</Button></div>
              <Suspense fallback={null}><LazyGisProgress percent={gisProgress} size="small" status="active" /></Suspense>
              {gisOperationKind === "import" && gisSpatialFilter
                ? <Text type="secondary">按框选范围过滤图层“{selectedGisLayerInfo?.name}”；范围外的要素不会导入。</Text>
                : gisOperationKind === "export" && exportSpatialFilterText.trim()
                  ? <Text type="secondary">按源 CRS 范围筛选；范围外的要素不会写入输出文件。</Text>
                : gisOperationKind === "import" && selectedGisLayerInfo?.featureCount != null
                  ? <Text type="secondary">图层“{selectedGisLayerInfo.name}”共有 {selectedGisLayerInfo.featureCount} 个要素。</Text>
                  : null}
              <Text type="secondary">取消导入时会回滚本次数据集事务；文件导出会清理临时文件。</Text>
            </Card>}

            {gisReport && <Alert
              showIcon
              type={gisReport.status === "completed" ? "success" : gisReport.status === "cancelled" ? "warning" : "error"}
              message={`${gisReport.operation === "import" ? "导入" : gisReport.operation === "export" ? "导出" : "转换"}${gisReport.status === "completed" ? "完成" : gisReport.status === "cancelled" ? "已取消" : "失败"}`}
              description={<div>
                <div>要素：成功 {gisReport.successfulFeatures ?? "未知"} / {gisReport.featureCount ?? "总数未知"}；失败 {gisReport.failedFeatures ?? "未知"}</div>
                {gisReport.warnings && gisReport.warnings.length > 0 && <ul>{gisReport.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>}
                {gisReport.failedSamples.length > 0 && <ul>{gisReport.failedSamples.map((sample: any, index: any) => <li key={`${index}-${sample}`}>{sample}</li>)}</ul>}
              </div>}
            />}

            {gisInfo && <Card className="gis-card metadata-card" title={<div className="card-heading"><span className="card-icon slate"><Braces size={16} /></span><div><b>数据集元数据</b><small>{gisInfo.format} · 驱动 {gisInfo.driver}</small></div></div>}>
              <div className="metadata-table-wrap"><Suspense fallback={<Spin size="small" />}>
                <LazyDataTable
                  size="small" pagination={false} rowKey="name" dataSource={selectedGisLayerInfo?.fields ?? []}
                  columns={[{ title: "字段名", dataIndex: "name" }, { title: "类型", dataIndex: "type", render: (value: any) => <Tag>{value}</Tag> }, { title: "可为空", dataIndex: "nullable", render: (value: any) => value ? "是" : "否" }]}
                />
              </Suspense></div>
              <div className="metadata-foot"><span><Layers3 size={14} /> 图层 {gisInfo.layers.length} · 当前 {selectedGisLayerInfo?.name ?? "—"}</span><span><Braces size={14} /> 几何 {selectedGisLayerInfo?.geometryType ?? "无"}</span><span><Globe2 size={14} /> CRS {crsLabel(selectedGisLayerInfo?.crs ?? null)}</span><span>Extent {selectedGisLayerInfo?.extent ? `${selectedGisLayerInfo.extent.minX.toFixed(3)}, ${selectedGisLayerInfo.extent.minY.toFixed(3)} → ${selectedGisLayerInfo.extent.maxX.toFixed(3)}, ${selectedGisLayerInfo.extent.maxY.toFixed(3)}` : "—"}</span></div>
            </Card>}
          </section>}
        </main>
      </div>

      <footer className="statusbar"><div className="status-left"><span className="status-ready"><Check size={12} /></span><span>{activeConnection ? `${activeConnection.name} · ${activeConnection.database ?? activeConnection.path ?? activeConnection.endpoint ?? "已配置"}` : "未连接数据库"}</span>{activeConnection && <span className="status-host">{activeConnection.path ?? activeConnection.endpoint ?? `${activeConnection.host}:${activeConnection.port}`}</span>}</div><div className="status-right"><span>{queryBusy || gisBusy || gisValidationBusy || dataBusy ? <><Spin size="small" /> 正在处理</> : "就绪"}</span><span className="status-separator" /><span>Core Service</span><span className="status-separator" /><span>GDAL / OGR</span></div></footer>

      {inspectedTable && <Suspense fallback={null}><TableStructureModal
        table={inspectedTable}
        columns={tableColumnsQuery.data ?? []}
        loading={tableColumnsQuery.isLoading}
        error={tableColumnsQuery.error ? errorText(tableColumnsQuery.error) : undefined}
        onClose={() => setInspectedTable(undefined)}
      /></Suspense>}

      {connectionModalMounted && <Suspense fallback={null}><ConnectionFormModal
        open={connectionModal}
        editingConnection={editingConnection}
        error={connectionSaveError}
        desktopEngines={desktopEngines}
        engineLabels={engineLabels}
        defaultPorts={defaultPorts}
        onCancel={() => { setConnectionSaveError(undefined); setConnectionModal(false); }}
        onSave={(values) => { void saveConnection({ ...values, id: editingConnection?.id }); }}
      /></Suspense>}

      {aiPanelMounted && <Suspense fallback={null}><AiAssistantPanel
        open={aiPanelOpen}
        connectionId={activeId}
        connectionName={activeConnection?.name}
        engine={activeConnection?.engine}
        connections={connections.map((item: any) => ({ id: item.id, name: item.name, engine: item.engine }))}
        onConnectionChange={(id) => { setActiveId(id); setQueryFailure(undefined); setAiSelectedSql(undefined); }}
        schema={defaultSchema}
        schemas={schemasQuery.data ?? []}
        sql={sql}
        selectedSql={aiSelectedSql}
        failure={queryFailure}
        initialTask={aiInitialTask}
        settingsRevision={aiSettingsRevision}
        onClose={() => setAiPanelOpen(false)}
        onOpenSettings={() => setAiSettingsOpen(true)}
        onInsertSql={insertAssistantSql}
      /></Suspense>}
      {queryHistoryMounted && <Suspense fallback={null}><QueryHistoryDrawer
        open={queryHistoryOpen}
        sql={sql}
        connection={activeConnection ? { id: activeConnection.id, name: activeConnection.name, engine: activeConnection.engine } : undefined}
        connections={connections.map(({ id, name, engine }) => ({ id, name, engine }))}
        onClose={() => setQueryHistoryOpen(false)}
        onRestore={(source) => {
          setSql(source.sql);
          const savedConnection = source.connectionId ? connections.find((item: any) => item.id === source.connectionId) : undefined;
          if (savedConnection) {
            setActiveId(savedConnection.id);
            setQueryFailure(undefined);
          } else if (source.connectionId) {
            message.info("原连接已不存在；SQL 已载入，请选择其他数据库连接后再执行。");
          }
        }}
      /></Suspense>}
      {activeConnection && activeConnection.engine !== "mongodb" && objectSearchMounted && <Suspense fallback={null}><DatabaseObjectSearchModal
        key={activeConnection.id}
        open={objectSearchOpen}
        connectionId={activeConnection.id}
        connectionName={activeConnection.name}
        schemas={schemasQuery.data ?? []}
        currentSchema={defaultSchema}
        schemasLoading={schemasQuery.isLoading}
        schemasError={Boolean(schemasQuery.error)}
        onClose={() => setObjectSearchOpen(false)}
        onOpenTable={(table) => {
          setObjectSearchOpen(false);
          setPage("query");
          setSql(buildTablePreviewSql(activeConnection.engine, table.schema, table.name));
        }}
      /></Suspense>}
      {editingDataTable && <Suspense fallback={null}><TableDataEditorModal
        key={`${editingDataTable.connectionId}:${editingDataTable.table.schema}.${editingDataTable.table.name}`}
        connectionId={editingDataTable.connectionId}
        engine={editingDataTable.engine}
        table={editingDataTable.table}
        onClose={() => setEditingDataTable(undefined)}
      /></Suspense>}
      {transferSource && <Suspense fallback={null}><TableTransferModal
        open
        sourceConnectionId={transferSource.connectionId}
        sourceConnectionName={transferSource.connectionName}
        sourceTable={transferSource.table}
        connections={connections}
        onClose={() => setTransferSource(undefined)}
        onTransfer={(target) => transferTableData(transferSource, target)}
      /></Suspense>}
      {aiSettingsMounted && <Suspense fallback={null}><AiSettingsModal
        open={aiSettingsOpen}
        onClose={() => setAiSettingsOpen(false)}
        onSaved={() => setAiSettingsRevision((revision) => revision + 1)}
      /></Suspense>}
    </div>
  );
}