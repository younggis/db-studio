// Source-ized SQL workspace built entirely from the shared Workbench primitives.
// Mounted by SqlWorkbenchOverlay over the compiled .query-workspace; reuses the
// same window.dbStudio IPC so query/AI/history behaviour is unchanged.
import { useEffect, useMemo, useRef, useState } from "react";
import { Input, Select, Space, message } from "antd";
import {
  Braces, CirclePlay, Database, Download, History, Play, RotateCw, Save, Search, Sparkles, Table2,
} from "lucide-react";
import type { ColumnInfo, DatabaseEngine, QueryResult, TableInfo } from "@db-studio/shared";
import {
  WbWorkbench, WbToolbar, WbToolbarGroup, WbToolButton, WbTreeSidebar,
  WbTabContainer, WbDataTable, WbStatusBar, WbInspector,
} from "./workbench/Workbench";
import AiAssistantPanel from "./AiAssistantPanel";
import QueryHistoryDrawer from "./QueryHistoryDrawer";
import DatabaseObjectTree from "./DatabaseObjectTree";
import type { DataNode } from "antd/es/tree";
import type { Key } from "react";

type Connection = { id: string; name: string; engine: DatabaseEngine };

export default function SqlWorkbenchPage() {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [connectionId, setConnectionId] = useState("");
  const [schemas, setSchemas] = useState<string[]>([]);
  const [schema, setSchema] = useState("");
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [expandedKeys, setExpandedKeys] = useState<Key[]>([]);
  const [sql, setSql] = useState("SELECT 1 AS value");
  const [result, setResult] = useState<QueryResult>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [aiOpen, setAiOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [inspected, setInspected] = useState<TableInfo>();
  const [columns, setColumns] = useState<ColumnInfo[]>([]);
  const [activeTab, setActiveTab] = useState("query");
  const sqlRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    window.dbStudio.connections.list().then((items) => {
      const list = items.map((item) => ({ id: item.id, name: item.name, engine: item.engine as DatabaseEngine }));
      setConnections(list);
      setConnectionId((current) => current || list[0]?.id || "");
    }).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!connectionId) return;
    window.dbStudio.database.schemas(connectionId).then((items) => {
      setSchemas(items);
      setSchema((current) => current || (items.includes("public") ? "public" : items[0]) || "");
    }).catch(() => setSchemas([]));
  }, [connectionId]);

  useEffect(() => {
    if (!connectionId || !schema) return;
    window.dbStudio.database.tables(connectionId, schema).then((items) => {
      setTables(items);
      setExpandedKeys([connectionId, `${connectionId}:${schema}`]);
    }).catch(() => setTables([]));
  }, [connectionId, schema]);

  const treeData = useMemo<DataNode[]>(() => connections.map((c) => ({
    key: c.id,
    title: c.name,
    icon: <Database size={13} />,
    children: c.id === connectionId ? [{
      key: `${c.id}:${schema || "public"}`,
      title: schema || "public",
      icon: <Database size={13} />,
      children: tables.map((t) => ({
        key: `${c.id}:${t.schema || schema}.${t.name}`,
        title: t.name,
        icon: <Table2 size={13} />,
      })),
    }] : undefined,
  })), [connections, connectionId, schema, tables]); // eslint-disable-line react-hooks/exhaustive-deps

  async function inspect(table: TableInfo) {
    if (!connectionId) return;
    setInspected(table);
    try { setColumns(await window.dbStudio.database.columns(connectionId, table.name, table.schema)); }
    catch { setColumns([]); }
  }

  async function runQuery() {
    if (!connectionId || !sql.trim()) return;
    setBusy(true); setError(undefined);
    try {
      const data = await window.dbStudio.database.query(connectionId, sql);
      setResult(data);
      setActiveTab("results");
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }

  function insertSql(text: string) {
    setSql((current) => current.trimEnd() + "\n" + text + "\n");
    sqlRef.current?.focus();
  }

  const columnsDefs = useMemo(() => (result?.columns ?? []).map((name) => ({
    title: <span className="result-column">{name}</span>,
    dataIndex: name,
    key: name,
    ellipsis: true,
    width: 160,
    render: (value: unknown) => (
      <span className={typeof value === "number" ? "numeric-value" : "mongo-cell"} title={String(value ?? "")}>
        {typeof value === "object" ? JSON.stringify(value) : String(value ?? "")}
      </span>
    ),
  })), [result]);

  const rows = useMemo(() => (result?.rows ?? []).map((row, index) => ({ ...row, key: index })), [result]);

  return (
    <WbWorkbench
      className="sql-workbench wb-app sql-wb"
      toolbar={
        <WbToolbar className="panel-toolbar">
          <WbToolbarGroup>
            <Select value={connectionId || undefined} onChange={setConnectionId} style={{ width: 220 }}
              options={connections.map((c) => ({ value: c.id, label: `${c.name} · ${c.engine}` }))} />
            <Select value={schema || undefined} onChange={setSchema} style={{ width: 160 }}
              options={schemas.map((s) => ({ value: s, label: s }))} />
          </WbToolbarGroup>
          <span className="toolbar-actions"><WbToolbarGroup>
            <WbToolButton icon={<Play size={14} />} label="执行查询" onClick={() => void runQuery()} loading={busy} />
            <WbToolButton icon={<Save size={14} />} tooltip="保存 SQL" onClick={() => void window.dbStudio.files.saveSql(null, sql)} />
            <WbToolButton icon={<Download size={14} />} tooltip="导出结果" onClick={() => result && void window.dbStudio.files.saveResult("csv", result.rows.map((r) => Object.values(r).join(",")).join("\n"))} />
            <WbToolButton icon={<Sparkles size={14} />} label="AI 助手" onClick={() => setAiOpen(true)} />
            <WbToolButton icon={<History size={14} />} label="历史" onClick={() => setHistoryOpen(true)} />
            <WbToolButton icon={<RotateCw size={14} />} tooltip="刷新元数据" onClick={() => { void window.dbStudio.database.schemas(connectionId).then(setSchemas); }} />
          </WbToolbarGroup></span>
        </WbToolbar>
      }
      sidebar={
        <DatabaseObjectTree
          data={treeData}
          loading={false}
          onSearch={() => undefined}
          onRefresh={() => { void window.dbStudio.database.schemas(connectionId).then(setSchemas); }}
          onSelect={() => undefined}
        />
      }
      inspector={
        <WbInspector open={!!inspected} title={inspected ? `${inspected.schema}.${inspected.name}` : "表结构"} onClose={() => setInspected(undefined)}>
          <WbDataTable rowKey="name" dataSource={columns.map((c) => ({ ...c, key: c.name }))} pagination={false} size="small"
            columns={[
              { title: "字段", dataIndex: "name" },
              { title: "类型", dataIndex: "dataType", render: (v: string) => <span className="result-column">{v}</span> },
              { title: "非空", dataIndex: "nullable", render: (v: boolean) => v ? "否" : "是" },
            ]} />
        </WbInspector>
      }
      statusbar={<WbStatusBar left={error ?? "就绪"} right={`${result?.rows.length ?? 0} 行 · ${connectionId}`} />}
    >
      <WbTabContainer
        activeKey={activeTab}
        onChange={setActiveTab}
        items={[
          { key: "query", label: <span><Braces size={13} /> SQL 编辑器</span>, children: (
            <div className="wb-sql-editor">
              <textarea ref={sqlRef} value={sql} onChange={(e) => setSql(e.target.value)} spellCheck={false}
                placeholder="SELECT * FROM table" aria-label="SQL 编辑器" />
            </div>
          ) },
          { key: "results", label: <span><Table2 size={13} /> 查询结果</span>, children: (
            <div className="wb-results">
              {error && <div className="wb-error">{error}</div>}
              <WbDataTable rowKey="key" columns={columnsDefs} dataSource={rows} pagination={false} size="small" scroll={{ x: "max-content" }} />
            </div>
          ) },
        ]}
      />
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
    </WbWorkbench>
  );
}
