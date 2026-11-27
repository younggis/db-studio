// Source-ized SQL workspace built entirely from the shared Workbench primitives.
// Mounted by SqlWorkbenchOverlay over the compiled .query-workspace; reuses the
// same window.dbStudio IPC so query/AI/history behaviour is unchanged.
import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { Dropdown, Select, Tabs, message } from "antd";
import type { MenuProps } from "antd";
import {
  Braces, Database, Download, History, MapPinned, Play, Plus, RotateCw, Save, Sparkles, Table2,
} from "lucide-react";
import type { ColumnInfo, DatabaseEngine, QueryResult, TableInfo } from "@db-studio/shared";
import {
  formatSelectionAsPlainText,
  formatSelectionAsCsv,
  formatSelectionAsJson,
  formatSelectionAsInsert,
  formatSelectionWithHeaders,
  calculateSelectionStats,
  isSelectionTooLarge,
} from "@db-studio/shared";
import {
  WbWorkbench, WbToolbar, WbToolbarGroup, WbToolButton,
  WbDataTable, WbStatusBar, WbInspector,
} from "./workbench/Workbench";
import AiAssistantPanel from "./AiAssistantPanel";
import QueryHistoryDrawer from "./QueryHistoryDrawer";
import DatabaseObjectTree from "./DatabaseObjectTree";
import GeometryCell from "./GeometryCell";
import QueryMetricsBar from "./QueryMetricsBar";
import CopyContextMenu from "./CopyContextMenu";
import SpatialResultPanel from "./SpatialResultPanel";
import PanelErrorBoundary from "./PanelErrorBoundary";
import { useTableSelection } from "./hooks/useTableSelection";
import type { DataNode } from "antd/es/tree";

type Connection = { id: string; name: string; engine: DatabaseEngine };

// A query window owns its SQL text, database context and execution state, so
// switching windows never overwrites another window's work and the single
// object browser simply follows the active window (Navicat-style).
type QueryTab = {
  id: string;
  title: string;
  sql: string;
  connectionId: string;
  schema: string;
  result?: QueryResult;
  error?: string;
  busy: boolean;
  inspected?: TableInfo;
  columns: ColumnInfo[];
};

export default function SqlWorkbenchPage() {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [schemas, setSchemas] = useState<string[]>([]);
  const [tables, setTables] = useState<TableInfo[]>([]);
  // Multiple query windows: only the active window's state is surfaced below.
  const [queryTabs, setQueryTabs] = useState<QueryTab[]>([
    {
      id: "q1", title: "查询 1", sql: "SELECT 1 AS value",
      connectionId: "", schema: "", busy: false, columns: [],
    },
  ]);
  const [activeQueryId, setActiveQueryId] = useState("q1");
  const nextQueryId = useRef(2);
  const activeQuery = queryTabs.find((tab) => tab.id === activeQueryId) ?? queryTabs[0];
  const sql = activeQuery?.sql ?? "";
  const connectionId = activeQuery?.connectionId ?? "";
  const schema = activeQuery?.schema ?? "";
  const inspected = activeQuery?.inspected;
  const columns = activeQuery?.columns ?? [];
  const result = activeQuery?.result;
  const busy = activeQuery?.busy ?? false;
  const error = activeQuery?.error;

  function patchActive(patch: Partial<QueryTab>) {
    setQueryTabs((tabs) => tabs.map((tab) =>
      tab.id === activeQueryId ? { ...tab, ...patch } : tab));
  }
  function patchQuery(id: string, patch: Partial<QueryTab>) {
    setQueryTabs((tabs) => tabs.map((tab) =>
      tab.id === id ? { ...tab, ...patch } : tab));
  }
  const [aiOpen, setAiOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [spatialOpen, setSpatialOpen] = useState(false);
  const [contextMenuCell, setContextMenuCell] = useState<{ row: number; col: number } | null>(null);
  const sqlRef = useRef<HTMLTextAreaElement>(null);

  // Editor and results are stacked vertically, with a draggable splitter.
  const [editorShare, setEditorShare] = useState(() => {
    try {
      const raw = localStorage.getItem("db-studio:sql-editor-share");
      const value = raw === null ? NaN : Number(raw);
      return Number.isFinite(value) ? Math.min(0.8, Math.max(0.2, value)) : 0.45;
    } catch { return 0.45; }
  });
  const [draggingSplit, setDraggingSplit] = useState(false);
  const splitRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    try { localStorage.setItem("db-studio:sql-editor-share", String(editorShare)); } catch { /* ignore */ }
  }, [editorShare]);
  useEffect(() => {
    if (!draggingSplit) return;
    const move = (event: PointerEvent) => {
      const host = splitRef.current?.parentElement;
      if (!host) return;
      const rect = host.getBoundingClientRect();
      setEditorShare(Math.min(0.8, Math.max(0.2, (event.clientY - rect.top) / rect.height)));
    };
    const stop = () => setDraggingSplit(false);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
  }, [draggingSplit]);

  // Table selection state
  const {
    selectedCells,
    handleCellClick,
    handleCellMouseDown,
    handleCellMouseEnter,
    handleMouseUp,
    clearSelection,
    selectRow,
    selectColumn,
    isSelected,
    getSelectedData,
  } = useTableSelection({
    rowCount: result?.rows.length ?? 0,
    colCount: result?.columns.length ?? 0,
  });

  function resetSelectionState() {
    clearSelection();
    setContextMenuCell(null);
  }

  function newQuery() {
    const id = `q${nextQueryId.current++}`;
    const current = queryTabs.find((tab) => tab.id === activeQueryId);
    setQueryTabs((tabs) => [...tabs, {
      id,
      title: `查询 ${tabs.length + 1}`,
      sql: "",
      connectionId: current?.connectionId ?? "",
      schema: current?.schema ?? "",
      busy: false,
      columns: [],
    }]);
    setActiveQueryId(id);
    resetSelectionState();
  }

  function closeQuery(id: string) {
    const index = queryTabs.findIndex((tab) => tab.id === id);
    if (index < 0) return;
    let next = queryTabs.filter((tab) => tab.id !== id);
    if (next.length === 0) {
      const current = queryTabs.find((tab) => tab.id === activeQueryId);
      next = [{
        id: `q${nextQueryId.current++}`, title: "查询 1", sql: "",
        connectionId: current?.connectionId ?? "", schema: current?.schema ?? "",
        busy: false, columns: [],
      }];
    }
    setQueryTabs(next);
    if (activeQueryId === id) setActiveQueryId(next[Math.min(index, next.length - 1)].id);
    resetSelectionState();
  }

  function switchQuery(id: string) {
    if (id === activeQueryId) return;
    setActiveQueryId(id);
    resetSelectionState();
  }

  // Keyboard shortcut: Ctrl+C to copy (registered after handleCopy is declared)
  // This placeholder is overwritten by the real useEffect below the copy handlers
  useEffect(() => {
    window.dbStudio.connections.list().then((items) => {
      const list = items.map((item) => ({ id: item.id, name: item.name, engine: item.engine as DatabaseEngine }));
      setConnections(list);
      const first = list[0]?.id ?? "";
      setQueryTabs((tabs) => tabs.map((tab) =>
        tab.connectionId ? tab : { ...tab, connectionId: first }));
    }).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!connectionId) return;
    const queryId = activeQueryId;
    window.dbStudio.database.schemas(connectionId).then((items) => {
      setSchemas(items);
      setQueryTabs((tabs) => tabs.map((tab) => {
        if (tab.id !== queryId || (tab.schema && items.includes(tab.schema))) return tab;
        const fallback = items.includes("public") ? "public" : (items[0] ?? "");
        return fallback === tab.schema ? tab : { ...tab, schema: fallback, inspected: undefined, columns: [] };
      }));
    }).catch(() => setSchemas([]));
  }, [connectionId]);

  useEffect(() => {
    if (!connectionId || !schema) return;
    window.dbStudio.database.tables(connectionId, schema).then(setTables).catch(() => setTables([]));
  }, [connectionId, schema]);

  // The left connection list is shared compiled chrome. Selecting a card there
  // updates the active query window's database context, so the object browser
  // (which follows the active window) changes with it.
  const lastSelectedCard = useRef<string | undefined>(undefined);
  useEffect(() => {
    const sync = () => {
      const name = document.querySelector(".connection-card.selected .connection-name b")?.textContent?.trim();
      if (!name || name === lastSelectedCard.current) return;
      lastSelectedCard.current = name;
      const match = connections.find((item) => name.includes(item.name));
      if (!match) return;
      setQueryTabs((tabs) => tabs.map((tab) =>
        tab.id === activeQueryId && tab.connectionId !== match.id
          ? { ...tab, connectionId: match.id, schema: "", inspected: undefined, columns: [] }
          : tab));
    };
    const observer = new MutationObserver(sync);
    observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ["class"], childList: true });
    sync();
    return () => observer.disconnect();
  }, [connections, activeQueryId]);

  // Navicat-style object tree: only the selected connection's schema/tables.
  // (Connection selection lives in the leftmost compiled connection panel.)
  const activeConnection = connections.find((c) => c.id === connectionId);
  const treeData = useMemo<DataNode[]>(() => {
    if (!connectionId) return [];
    const rootKey = `obj:${connectionId}`;
    const schemaKey = `obj:${connectionId}:${schema || "public"}`;
    return [{
      key: rootKey,
      title: activeConnection?.name ?? "当前连接",
      icon: <Database size={13} />,
      children: [{
        key: schemaKey,
        title: schema || "public",
        icon: <Database size={13} />,
        // navicatTransform wraps these table nodes in a "Tables" group.
        children: tables.map((t) => ({
          key: `${connectionId}:${t.schema || schema}.${t.name}`,
          title: t.name,
          icon: <Table2 size={13} />,
        })),
      }],
    }];
  }, [connectionId, schema, tables, activeConnection?.name]); // eslint-disable-line react-hooks/exhaustive-deps

  async function inspect(table: TableInfo) {
    if (!connectionId) return;
    const queryId = activeQueryId;
    patchQuery(queryId, { inspected: table, columns: [] });
    try {
      const cols = await window.dbStudio.database.columns(connectionId, table.name, table.schema);
      patchQuery(queryId, { columns: cols });
    } catch { patchQuery(queryId, { columns: [] }); }
  }

  async function runQuery(sqlText = sql) {
    if (!connectionId || !sqlText.trim()) return;
    // The query belongs to the window where it was started, even if the user
    // switches windows while it is running.
    const queryId = activeQueryId;
    patchQuery(queryId, { sql: sqlText, busy: true, error: undefined });
    clearSelection();
    try {
      const data = await window.dbStudio.database.query(connectionId, sqlText);
      patchQuery(queryId, { result: data, busy: false });
    } catch (cause) {
      patchQuery(queryId, {
        error: cause instanceof Error ? cause.message : String(cause),
        busy: false,
      });
    }
  }

  function refreshMetadata() {
    if (!connectionId) return;
    void window.dbStudio.database.schemas(connectionId).then(setSchemas);
    void window.dbStudio.database.tables(connectionId, schema).then(setTables).catch(() => setTables([]));
  }

  // Navicat-style object-browser context menu. Keys come from treeData:
  // obj:<connection>, obj:<connection>:<schema>, <connection>:<schema>.<table>.
  function getTreeNodeMenuItems(node: DataNode): MenuProps["items"] {
    const key = String(node.key ?? "");
    const refresh = { key: "refresh", label: "刷新", onClick: refreshMetadata };
    const connection = connections.find((item) => item.id === connectionId);
    if (key === `obj:${connectionId}`) return [
      { key: "new-query", label: "新建 SQL 查询", onClick: newQuery },
      {
        key: "test", label: "测试连接",
        onClick: () => {
          void window.dbStudio.connections.test(connectionId)
            .then((result) => message.success(`连接成功 · ${result.database}`))
            .catch(() => message.error("连接失败"));
        },
      },
      { type: "divider" },
      refresh,
    ];
    if (key === `obj:${connectionId}:${schema || "public"}`) return [
      { key: "new-query", label: "新建 SQL 查询", onClick: newQuery },
      refresh,
    ];
    const table = tables.find((item) => key === `${connectionId}:${item.schema || schema}.${item.name}`);
    if (table) {
      const qualified = `${table.schema || schema}.${table.name}`;
      return [
        {
          key: "preview", label: "查询前 100 条",
          onClick: () => {
            const sqlText = connection?.engine === "sqlserver"
              ? `SELECT TOP 100 * FROM ${qualified}`
              : `SELECT * FROM ${qualified} LIMIT 100`;
            void runQuery(sqlText);
          },
        },
        { key: "fields", label: "查看字段", onClick: () => { void inspect(table); } },
        { key: "copy-name", label: "复制表名", onClick: () => { void navigator.clipboard.writeText(qualified); } },
        { type: "divider" },
        refresh,
      ];
    }
    return [refresh];
  }

  function insertSql(text: string) {
    const queryId = activeQueryId;
    setQueryTabs((tabs) => tabs.map((tab) =>
      tab.id === queryId ? { ...tab, sql: `${tab.sql.trimEnd()}\n${text}\n` } : tab));
    sqlRef.current?.focus();
  }

  // Copy selected cells to clipboard
  const handleCopy = useCallback(async (format: 'plain' | 'csv' | 'json' | 'insert') => {
    if (!result || selectedCells.size === 0) return;

    const data = getSelectedData(result.rows, result.columns);
    if (data.length === 0) return;

    const stats = calculateSelectionStats(data);
    if (isSelectionTooLarge(stats)) {
      message.warning(`选择内容过大（${stats.cellCount} 个单元格），请缩小选择范围`);
      return;
    }

    let text = '';
    // Find selected columns
    const selectedColIndices = new Set<number>();
    for (const key of selectedCells) {
      const col = parseInt(key.split(',')[1] ?? '0', 10);
      selectedColIndices.add(col);
    }
    const selectedCols = Array.from(selectedColIndices).sort((a, b) => a - b).map(i => result.columns[i] ?? '');

    switch (format) {
      case 'plain':   text = formatSelectionAsPlainText(data); break;
      case 'csv':     text = formatSelectionAsCsv(data); break;
      case 'json':    text = formatSelectionAsJson(data, selectedCols); break;
      case 'insert':  text = formatSelectionAsInsert(data, selectedCols, 'table'); break;
    }

    await navigator.clipboard.writeText(text);
    message.success(`已复制 ${stats.rowCount} 行 × ${stats.colCount} 列`);
  }, [result, selectedCells, getSelectedData]);

  const handleCopyWithHeaders = useCallback(async () => {
    if (!result || selectedCells.size === 0) return;
    const data = getSelectedData(result.rows, result.columns);
    const selectedColIndices = new Set<number>();
    for (const key of selectedCells) {
      const col = parseInt(key.split(',')[1] ?? '0', 10);
      selectedColIndices.add(col);
    }
    const selectedCols = Array.from(selectedColIndices).sort((a, b) => a - b).map(i => result.columns[i] ?? '');
    const text = formatSelectionWithHeaders(data, selectedCols);
    await navigator.clipboard.writeText(text);
    message.success('已复制（含列名）');
  }, [result, selectedCells, getSelectedData]);

  const handleCopyRow = useCallback(async () => {
    if (!result || !contextMenuCell) return;
    const row = result.rows[contextMenuCell.row];
    if (!row) return;
    const values = result.columns.map(col => {
      const v = row[col];
      return v === null || v === undefined ? '' : String(v);
    });
    await navigator.clipboard.writeText(values.join('\t'));
    message.success('已复制整行');
  }, [result, contextMenuCell]);

  const handleCopyColumn = useCallback(async () => {
    if (!result || !contextMenuCell) return;
    const colName = result.columns[contextMenuCell.col];
    if (!colName) return;
    const values = result.rows.map(row => {
      const v = row[colName];
      return v === null || v === undefined ? '' : String(v);
    });
    await navigator.clipboard.writeText(values.join('\n'));
    message.success(`已复制 "${colName}" 列 (${values.length} 行)`);
  }, [result, contextMenuCell]);

  const handleCopyColumnName = useCallback(async () => {
    if (!result || !contextMenuCell) return;
    const colName = result.columns[contextMenuCell.col];
    if (!colName) return;
    await navigator.clipboard.writeText(colName);
    message.success(`已复制列名 "${colName}"`);
  }, [result, contextMenuCell]);

  // Ctrl+C copies the selected result cells as long as focus is not in a text field.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (!(e.ctrlKey || e.metaKey) || e.key !== 'c' || selectedCells.size === 0) return;
      const active = document.activeElement;
      if (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement) return;
      e.preventDefault();
      void handleCopy('plain');
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selectedCells, handleCopy]);

  const columnsDefs = useMemo(() => {
    const metadata = result?.columnMetadata;
    return (result?.columns ?? []).map((name, index) => {
      const columnMeta = metadata?.[index];
      const isGeometry = columnMeta?.geometryType !== undefined;

      return {
        title: (
          <span
            className="result-column"
            style={{ cursor: 'pointer', userSelect: 'none' }}
            onClick={() => selectColumn(index)}
          >
            {name}
            {columnMeta?.geometryType && (
              <span style={{ marginLeft: 4, fontSize: 11, color: '#1890ff' }}>
                ({columnMeta.geometryType})
              </span>
            )}
          </span>
        ),
        dataIndex: name,
        key: name,
        ellipsis: !isGeometry,
        width: isGeometry ? 200 : 160,
        onCell: (_record: any, rowIndex?: number) => ({
          onClick: (e: React.MouseEvent) => {
            if (rowIndex !== undefined) handleCellClick(rowIndex, index, e.ctrlKey || e.metaKey, e.shiftKey);
          },
          onMouseDown: (e: React.MouseEvent) => {
            if (rowIndex !== undefined && e.buttons === 1 && !e.ctrlKey && !e.shiftKey) {
              handleCellMouseDown(rowIndex, index);
            }
          },
          onMouseEnter: () => {
            if (rowIndex !== undefined) handleCellMouseEnter(rowIndex, index);
          },
          onMouseUp: handleMouseUp,
          onContextMenu: (e: React.MouseEvent) => {
            e.preventDefault();
            if (rowIndex !== undefined) {
              setContextMenuCell({ row: rowIndex, col: index });
              // Ensure at least the right-clicked cell is selected
              if (rowIndex !== undefined && !isSelected(rowIndex, index)) {
                handleCellClick(rowIndex, index, false, false);
              }
            }
          },
          style: {
            backgroundColor: rowIndex !== undefined && isSelected(rowIndex, index)
              ? 'rgba(24,144,255,0.12)'
              : undefined,
            outline: rowIndex !== undefined && isSelected(rowIndex, index)
              ? '1px inset rgba(24,144,255,0.5)'
              : undefined,
            cursor: 'default',
            userSelect: 'none' as const,
          },
        }),
        render: (value: unknown, _record: any, rowIndex: number) => {
          if (isGeometry && columnMeta) {
            return (
              <GeometryCell
                value={value as Buffer | string | null}
                column={columnMeta}
                rowIndex={rowIndex}
                onOpenFullMap={(geometry, col) => {
                  message.info(`几何类型: ${geometry.geometry.type}, SRID: ${geometry.properties?.srid ?? 'N/A'}`);
                }}
              />
            );
          }
          return (
            <span className={typeof value === "number" ? "numeric-value" : "mongo-cell"} title={String(value ?? "")}>
              {typeof value === "object" ? JSON.stringify(value) : String(value ?? "")}
            </span>
          );
        },
      };
    });
  }, [result, isSelected, handleCellClick, handleCellMouseDown, handleCellMouseEnter, handleMouseUp, selectColumn]);

  const rows = useMemo(() => (result?.rows ?? []).map((row, index) => ({ ...row, key: index })), [result]);

  return (
    <WbWorkbench
      className="sql-workbench wb-app sql-wb"
      toolbar={
        <WbToolbar className="panel-toolbar">
          <WbToolbarGroup>
            <Select value={connectionId || undefined} aria-label="当前查询连接"
              onChange={(id) => patchActive({ connectionId: id, schema: "", inspected: undefined, columns: [] })}
              style={{ width: 220 }}
              options={connections.map((c) => ({ value: c.id, label: `${c.name} · ${c.engine}` }))} />
            <Select value={schema || undefined} aria-label="当前查询 Schema"
              onChange={(value) => patchActive({ schema: value, inspected: undefined, columns: [] })}
              style={{ width: 160 }}
              options={schemas.map((s) => ({ value: s, label: s }))} />
          </WbToolbarGroup>
          <span className="toolbar-actions"><WbToolbarGroup>
            <WbToolButton icon={<Plus size={14} />} label="新建查询" tooltip="再开一个 SQL 编辑窗口" onClick={newQuery} />
            <WbToolButton icon={<Play size={14} />} label="执行查询" onClick={() => void runQuery()} loading={busy} />
            <WbToolButton icon={<Save size={14} />} tooltip="保存 SQL" onClick={() => void window.dbStudio.files.saveSql(null, sql)} />
            <WbToolButton icon={<Download size={14} />} tooltip="导出结果" onClick={() => result && void window.dbStudio.files.saveResult("csv", result.rows.map((r) => Object.values(r).join(",")).join("\n"))} />
            <WbToolButton icon={<MapPinned size={14} />} ariaLabel="空间结果预览" tooltip="空间结果预览（最多 5000 行）" disabled={!result} onClick={() => setSpatialOpen(true)} />
            <WbToolButton icon={<Sparkles size={14} />} label="AI 助手" onClick={() => setAiOpen(true)} />
            <WbToolButton icon={<History size={14} />} label="历史" onClick={() => setHistoryOpen(true)} />
            <WbToolButton icon={<RotateCw size={14} />} tooltip="刷新元数据" onClick={refreshMetadata} />
          </WbToolbarGroup></span>
        </WbToolbar>
      }
      sidebar={
        <DatabaseObjectTree
          data={treeData}
          loading={false}
          onSearch={() => undefined}
          onRefresh={refreshMetadata}
          getContextMenuItems={getTreeNodeMenuItems}
          onSelect={(keys) => {
            const key = String(keys[0] ?? "");
            const table = tables.find((item) => key === `${connectionId}:${item.schema || schema}.${item.name}`);
            if (table) void inspect(table);
          }}
        />
      }
      inspector={
        <WbInspector open={!!inspected} title={inspected ? `${inspected.schema}.${inspected.name}` : "表结构"} onClose={() => patchActive({ inspected: undefined })}>
          <WbDataTable rowKey="name" dataSource={columns.map((c) => ({ ...c, key: c.name }))} pagination={false} size="small"
            columns={[
              { title: "字段", dataIndex: "name" },
              { title: "类型", dataIndex: "dataType", render: (v: string) => <span className="result-column">{v}</span> },
              { title: "非空", dataIndex: "nullable", render: (v: boolean) => v ? "否" : "是" },
            ]} />
        </WbInspector>
      }
      statusbar={<WbStatusBar left={error ?? "就绪"} right={`${schema ? `${schema} · ` : ""}${selectedCells.size > 0 ? `选中 ${selectedCells.size} 个 · ` : ""}${result?.rows.length ?? 0} 行 · ${connectionId}`} />}
    >
      <div className="wb-sql-split">
        <section className="wb-sql-pane wb-sql-pane-editor" style={{ flex: `${editorShare} 1 0%` }}>
          <div className="wb-pane-head"><Braces size={13} /> SQL 编辑器</div>
          <div className="wb-sql-editor">
            <Tabs
              className="wb-query-tabs"
              type="editable-card"
              size="small"
              activeKey={activeQueryId}
              onChange={switchQuery}
              onEdit={(keyOrEvent, action) => {
                if (action === "add") newQuery();
                else closeQuery(String(keyOrEvent));
              }}
              items={queryTabs.map((tab) => {
                const connectionName = connections.find((item) => item.id === tab.connectionId)?.name;
                return {
                  key: tab.id,
                  closable: true,
                  label: (
                    <span title={`${connectionName ?? "未选择连接"} · ${tab.schema || "未选择 Schema"}`}>
                      {tab.title}
                      {connectionName && <small className="wb-query-tab-context">{connectionName}</small>}
                    </span>
                  ),
                };
              })}
            />
            <textarea ref={sqlRef} value={sql} onChange={(e) => patchActive({ sql: e.target.value })} spellCheck={false}
              placeholder="SELECT * FROM table" aria-label="SQL 编辑器" />
          </div>
        </section>

        <div
          ref={splitRef}
          className={`wb-sql-splitter${draggingSplit ? " is-dragging" : ""}`}
          role="separator"
          aria-label="调整编辑器与结果区高度"
          aria-orientation="horizontal"
          tabIndex={0}
          title="拖动调整编辑器与结果区高度；方向键微调，Shift + 方向键大幅调整"
          onPointerDown={(event) => { event.preventDefault(); setDraggingSplit(true); }}
          onKeyDown={(event) => {
            if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
            event.preventDefault();
            const delta = event.shiftKey ? 0.1 : 0.02;
            setEditorShare((current) => Math.min(0.8, Math.max(0.2,
              current + (event.key === "ArrowUp" ? -delta : delta))));
          }}
        ><span /></div>

        <section className="wb-sql-pane wb-sql-pane-results" style={{ flex: `${1 - editorShare} 1 0%` }}>
          <div className="wb-pane-head"><Table2 size={13} /> 查询结果</div>
          <div
            className="wb-results"
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
          >
            {result?.metrics && <QueryMetricsBar metrics={result.metrics} />}
            {error && <div className="wb-error">{error}</div>}
            <Dropdown
              trigger={['contextMenu']}
              dropdownRender={() => (
                <CopyContextMenu
                  hasSelection={selectedCells.size > 0}
                  selectionStats={calculateSelectionStats(
                    result && selectedCells.size > 0
                      ? getSelectedData(result.rows, result.columns)
                      : []
                  )}
                  onCopy={(fmt) => void handleCopy(fmt)}
                  onCopyWithHeaders={() => void handleCopyWithHeaders()}
                  onCopyRow={() => void handleCopyRow()}
                  onCopyColumn={() => void handleCopyColumn()}
                  onCopyColumnName={() => void handleCopyColumnName()}
                  contextCell={contextMenuCell ?? undefined}
                />
              )}
            >
              <div>
                <WbDataTable
                  rowKey="key"
                  columns={columnsDefs}
                  dataSource={rows}
                  pagination={false}
                  size="small"
                  scroll={{ x: "max-content" }}
                />
              </div>
            </Dropdown>
            {selectedCells.size > 0 && (
              <div className="wb-selection-bar">
                <span>已选择 {selectedCells.size} 个单元格</span>
                <span className="wb-selection-hint">Ctrl+C 复制 | 右键更多选项</span>
                <button type="button" onClick={clearSelection}>清除选择</button>
              </div>
            )}
          </div>
        </section>
      </div>
      <AiAssistantPanel
        open={aiOpen} connectionId={connectionId} engine={connections.find((c) => c.id === connectionId)?.engine}
        connections={connections} schema={schema} schemas={schemas} sql={sql} selectedSql={sql}
        settingsRevision={0} onClose={() => setAiOpen(false)} onOpenSettings={() => message.info("请在工具栏模型设置中配置")}
        onInsertSql={insertSql}
      />
      <QueryHistoryDrawer
        open={historyOpen} sql={sql}
        connection={connections.find((c) => c.id === connectionId)}
        connections={connections}
        onClose={() => setHistoryOpen(false)} onRestore={(source) => insertSql(source.sql)}
      />
      <PanelErrorBoundary onReset={() => setSpatialOpen(false)}>
        <SpatialResultPanel open={spatialOpen} result={result} onClose={() => setSpatialOpen(false)} />
      </PanelErrorBoundary>
    </WbWorkbench>
  );
}
