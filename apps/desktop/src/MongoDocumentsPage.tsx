// MongoDB documents page — Compass-inspired compact UI.
// Mounted by MongoPageOverlay over the compiled .mongo-workspace. All data goes
// through window.dbStudio.mongo / .connections — no business logic is bypassed.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Alert, Button, Drawer, Dropdown, Input, InputNumber, Modal, Popconfirm, Segmented,
  Space, Spin, Table, Tag, Tooltip, Typography, message, type MenuProps,
} from "antd";
import {
  Braces, ChevronDown, Copy, Database, Download, FileJson, FileUp, Info,
  Layers3, ListTree, MapPin, Pencil, Play, RefreshCw, Search, Table2,
  Trash2, Upload,
} from "lucide-react";
import LazyDataTable from "./LazyDataTable";
import MongoAiPanel, { type MongoQueryDraft } from "./MongoAiPanel";
import JsonMiniEditor from "./JsonMiniEditor";
import GisPreviewMap from "./GisPreviewMap";
import type { MongoQueryMode } from "@db-studio/ai";

const { Text } = Typography;

type ViewMode = "tree" | "table" | "map";

const QUERY_TEMPLATES = [
  { label: "全部文档", filter: "{}", hint: "返回集合中的所有文档" },
  { label: "字段筛选", filter: '{"status":"active"}', hint: "按字段值精确匹配" },
  {
    label: "空间查询 $geoWithin",
    filter: '{"geometry":{"$geoWithin":{"$geometry":{"type":"Polygon","coordinates":[[[0,0],[0,1],[1,1],[1,0],[0,0]]]}}}}',
    hint: "查询落在多边形内的 GeoJSON 要素",
  },
];

function parseObject(text: string, label: string): Record<string, unknown> | undefined {
  if (!text.trim()) return undefined;
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} 必须是 JSON 对象。`);
  return value as Record<string, unknown>;
}

function formatValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function describeError(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

interface LabeledSelectProps {
  icon: ReactNode;
  label: string;
  value?: string;
  options: string[];
  placeholder: string;
  loading?: boolean;
  onChange: (value: string) => void;
  className?: string;
}

function LabeledSelect({ icon, label, value, options, placeholder, loading, onChange, className }: LabeledSelectProps) {
  return (
    <div className={`mongo-labeled-select ${className ?? ""}`}>
      <span className="mongo-labeled-prefix">{icon}<span>{label}</span></span>
      <select
        className="mongo-native-select"
        value={value ?? ""}
        disabled={loading}
        onChange={(event) => onChange(event.target.value)}
        aria-label={label}
      >
        <option value="">{placeholder}</option>
        {options.map((option) => <option key={option} value={option}>{option}</option>)}
      </select>
      <ChevronDown size={13} className="mongo-select-caret" />
    </div>
  );
}

function JsonTree({ name, value, depth = 0 }: { name?: string; value: unknown; depth?: number }) {
  const isObject = value !== null && typeof value === "object";
  if (!isObject) {
    const cls = value === null ? "jv-null" : typeof value === "number" || typeof value === "boolean" ? "jv-num" : "jv-str";
    return (
      <div className="jtree-leaf" style={{ paddingLeft: depth * 16 }}>
        {name !== undefined && <span className="jtree-key">{name}</span>}
        <span className={`jtree-value ${cls}`}>{formatValue(value)}</span>
      </div>
    );
  }
  const entries: Array<[string, unknown]> = Array.isArray(value)
    ? value.map((item, index) => [String(index), item])
    : Object.entries(value as Record<string, unknown>);
  return (
    <details className="jtree-node" open={depth < 1} style={{ marginLeft: depth * 16 }}>
      <summary>
        {name !== undefined && <span className="jtree-key">{name}</span>}
        <span className="jtree-bracket">{Array.isArray(value) ? "[" : "{"}</span>
        <span className="jtree-count">{entries.length}</span>
        <span className="jtree-bracket">{Array.isArray(value) ? "]" : "}"}</span>
      </summary>
      <div className="jtree-children">
        {entries.map(([key, child]) => <JsonTree key={key} name={key} value={child} depth={depth + 1} />)}
      </div>
    </details>
  );
}

function DocActions({ onCopy, onEdit, onDelete }: { onCopy: () => void; onEdit: () => void; onDelete: () => void }) {
  return (
    <span className="mongo-doc-actions" onClick={(event) => event.stopPropagation()}>
      <Tooltip title="复制文档"><Button type="text" size="small" icon={<Copy size={13} />} onClick={onCopy} aria-label="复制文档" /></Tooltip>
      <Tooltip title="编辑文档"><Button type="text" size="small" icon={<Pencil size={13} />} onClick={onEdit} aria-label="编辑文档" /></Tooltip>
      <Popconfirm title="删除该文档？" description="此操作不可撤销。" okText="删除" cancelText="取消" okButtonProps={{ danger: true }} onConfirm={onDelete}>
        <Tooltip title="删除文档"><Button type="text" size="small" danger icon={<Trash2 size={13} />} aria-label="删除文档" /></Tooltip>
      </Popconfirm>
    </span>
  );
}

interface MongoDocumentsPageProps {
  connectionId: string;
  defaultDatabase?: string;
}

export default function MongoDocumentsPage({ connectionId, defaultDatabase }: MongoDocumentsPageProps) {
  const [database, setDatabase] = useState(defaultDatabase ?? "");
  const [collection, setCollection] = useState("");
  const [filterText, setFilterText] = useState("{}");
  const [projectionText, setProjectionText] = useState("");
  const [sortText, setSortText] = useState("");
  const [pipelineText, setPipelineText] = useState('[{"$limit":100}]');
  const [mode, setMode] = useState<MongoQueryMode>("find");
  const [viewMode, setViewMode] = useState<ViewMode>("tree");
  const [filterExpanded, setFilterExpanded] = useState(false);
  const [projectionExpanded, setProjectionExpanded] = useState(false);
  const [sortExpanded, setSortExpanded] = useState(false);
  const [pipelineExpanded, setPipelineExpanded] = useState(false);
  const [skip, setSkip] = useState(0);
  const [limit, setLimit] = useState(100);
  const [documents, setDocuments] = useState<Array<Record<string, unknown>>>([]);
  const [busy, setBusy] = useState(false);
  const [queryError, setQueryError] = useState<string>();
  const [indexesOpen, setIndexesOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [geometryField, setGeometryField] = useState("geometry");
  const [editingDoc, setEditingDoc] = useState<Record<string, unknown> | null>(null);
  const [editText, setEditText] = useState("");

  const [databases, setDatabases] = useState<string[]>([]);
  const [collections, setCollections] = useState<string[]>([]);
  const [indexes, setIndexes] = useState<Array<Record<string, unknown>>>([]);
  const [metaLoading, setMetaLoading] = useState(false);
  const [metaError, setMetaError] = useState<unknown>();

  async function loadDatabases() {
    setMetaLoading(true);
    try {
      setDatabases(await window.dbStudio.mongo.databases(connectionId));
      setMetaError(undefined);
    } catch (cause) { setMetaError(cause); } finally { setMetaLoading(false); }
  }

  async function loadCollections() {
    if (!database) return;
    setMetaLoading(true);
    try {
      setCollections(await window.dbStudio.mongo.collections(connectionId, database));
      setMetaError(undefined);
    } catch (cause) { setMetaError(cause); } finally { setMetaLoading(false); }
  }

  async function loadIndexes() {
    if (!database || !collection) return;
    setMetaLoading(true);
    try {
      setIndexes(await window.dbStudio.mongo.indexes(connectionId, database, collection));
      setMetaError(undefined);
    } catch (cause) { setMetaError(cause); } finally { setMetaLoading(false); }
  }

  useEffect(() => {
    setDatabase(defaultDatabase ?? "");
    setCollection("");
    setDocuments([]);
    setSkip(0);
    void loadDatabases();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, defaultDatabase]);

  useEffect(() => { if (!database && databases.length > 0) setDatabase(databases[0]); }, [database, databases]);
  useEffect(() => { void loadCollections(); }, [database]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (collection && !collections.includes(collection)) setCollection("");
    if (!collection && collections.length > 0) setCollection(collections[0]);
  }, [collection, collections]);
  useEffect(() => { if (indexesOpen) void loadIndexes(); }, [indexesOpen, database, collection]); // eslint-disable-line react-hooks/exhaustive-deps

  const databaseOptions = defaultDatabase ? [...new Set([defaultDatabase, ...databases])] : databases;

  async function runFind(nextSkip = skip) {
    if (!database || !collection) { message.warning("请选择数据库和 Collection。"); return; }
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) { message.warning("每页数量必须在 1 到 1000 之间。"); return; }
    try {
      const filter = parseObject(filterText, "Filter") ?? {};
      const projection = parseObject(projectionText, "Projection");
      const sort = parseObject(sortText, "Sort");
      setBusy(true);
      setQueryError(undefined);
      setSkip(nextSkip);
      const json = await window.dbStudio.mongo.find(connectionId, database, collection, { filter, projection, sort, skip: nextSkip, limit });
      setDocuments(JSON.parse(json) as Array<Record<string, unknown>>);
    } catch (cause) {
      const text = describeError(cause, "MongoDB 查询失败。");
      setQueryError(text);
      message.error(text);
    } finally { setBusy(false); }
  }

  async function runAggregate() {
    if (!database || !collection) { message.warning("请选择数据库和 Collection。"); return; }
    try {
      const pipeline: unknown = JSON.parse(pipelineText);
      if (!Array.isArray(pipeline) || pipeline.some((item) => !item || typeof item !== "object" || Array.isArray(item))) {
        throw new Error("Aggregate Pipeline 必须是 JSON 对象数组。");
      }
      setBusy(true);
      setQueryError(undefined);
      const json = await window.dbStudio.mongo.aggregate(connectionId, database, collection, pipeline as Record<string, unknown>[], limit);
      setDocuments(JSON.parse(json) as Array<Record<string, unknown>>);
      setSkip(0);
    } catch (cause) {
      const text = describeError(cause, "MongoDB 查询失败。");
      setQueryError(text);
      message.error(text);
    } finally { setBusy(false); }
  }

  async function refresh() { if (mode === "find") await runFind(skip); else await runAggregate(); }

  async function importJson() {
    if (!database || !collection) { message.warning("请选择目标数据库和 Collection。"); return; }
    setBusy(true);
    try {
      const result = await window.dbStudio.mongo.import(connectionId, database, collection);
      if (!result) return;
      message.success(`已导入 ${result.insertedCount} 个文档到 ${collection}`);
      await refresh();
    } catch (cause) { message.error(describeError(cause, "导入失败。")); } finally { setBusy(false); }
  }

  async function importGeoJson() {
    if (!database || !collection) { message.warning("请选择目标数据库和 Collection。"); return; }
    setBusy(true);
    try {
      const result = await window.dbStudio.mongo.importGeoJson(connectionId, database, collection, geometryField.trim() || "geometry");
      if (!result) return;
      message.success(`已导入 ${result.insertedCount} 个 GeoJSON 要素到 ${collection}`);
      await refresh();
    } catch (cause) { message.error(describeError(cause, "导入 GeoJSON 失败。")); } finally { setBusy(false); }
  }

  async function exportJson() {
    if (!database || !collection) { message.warning("请选择源数据库和 Collection。"); return; }
    try {
      const filter = parseObject(filterText, "Filter");
      const result = await window.dbStudio.mongo.export(connectionId, database, collection, filter);
      if (result) message.success(`已导出 ${result.documentCount} 个文档 · ${result.path}`);
    } catch (cause) { message.error(describeError(cause, "导出失败。")); }
  }

  async function exportGeoJson() {
    if (!database || !collection) { message.warning("请选择源数据库和 Collection。"); return; }
    try {
      const filter = parseObject(filterText, "Filter");
      const result = await window.dbStudio.mongo.exportGeoJson(connectionId, database, collection, geometryField.trim() || "geometry", filter);
      if (result) message.success(`已导出 ${result.featureCount} 个 GeoJSON 要素 · ${result.path}`);
    } catch (cause) { message.error(describeError(cause, "导出 GeoJSON 失败。")); }
  }

  async function create2dsphere() {
    if (!database || !collection || !geometryField.trim()) return;
    try {
      const result = await window.dbStudio.mongo.createTwoDSphereIndex(connectionId, database, collection, geometryField.trim());
      message.success(`已创建空间索引 ${result}`);
      await loadIndexes();
    } catch (cause) { message.error(describeError(cause, "创建索引失败。")); }
  }

  async function copyDoc(doc: Record<string, unknown>) {
    try {
      await navigator.clipboard.writeText(JSON.stringify(doc, null, 2));
      message.success("文档 JSON 已复制");
    } catch { message.error("复制失败，请检查浏览器剪贴板权限。"); }
  }

  function openEdit(doc: Record<string, unknown>) {
    setEditingDoc(doc);
    setEditText(JSON.stringify(doc, null, 2));
  }

  async function saveEdit() {
    if (!editingDoc || !database || !collection) return;
    if (editingDoc._id === undefined) { message.warning("该文档缺少 _id，无法定位。"); return; }
    try {
      const filterJson = JSON.stringify({ _id: editingDoc._id });
      const count = await window.dbStudio.mongo.replaceDocument(connectionId, database, collection, filterJson, editText);
      if (count === 0) { message.warning("未找到匹配的文档，可能已被删除。"); return; }
      message.success(`已更新 ${count} 个文档`);
      setEditingDoc(null);
      await refresh();
    } catch (cause) { message.error(describeError(cause, "保存修改失败。")); }
  }

  async function deleteDoc(doc: Record<string, unknown>) {
    if (!database || !collection) return;
    if (doc._id === undefined) { message.warning("该文档缺少 _id，无法定位。"); return; }
    try {
      const filterJson = JSON.stringify({ _id: doc._id });
      const count = await window.dbStudio.mongo.deleteDocument(connectionId, database, collection, filterJson);
      message.success(`已删除 ${count} 个文档`);
      await refresh();
    } catch (cause) { message.error(describeError(cause, "删除失败。")); }
  }

  function applyTemplate(filter: string) {
    setMode("find");
    setFilterText(filter);
    setFilterExpanded(true);
    setSkip(0);
    requestAnimationFrame(() => { void runFindWithFilter(filter); });
  }

  async function runFindWithFilter(filter: string) {
    if (!database || !collection) return;
    try {
      setBusy(true);
      setQueryError(undefined);
      const json = await window.dbStudio.mongo.find(connectionId, database, collection, {
        filter: parseObject(filter, "Filter") ?? {}, skip: 0, limit,
      });
      setDocuments(JSON.parse(json) as Array<Record<string, unknown>>);
      setSkip(0);
    } catch (cause) {
      const text = describeError(cause, "MongoDB 查询失败。");
      setQueryError(text);
      message.error(text);
    } finally { setBusy(false); }
  }

  function applyAiQuery(next: MongoQueryDraft) {
    setMode(next.mode);
    setFilterText(next.filter);
    setProjectionText(next.projection);
    setSortText(next.sort);
    setPipelineText(next.pipeline);
    setSkip(0);
  }

  const importItems: MenuProps["items"] = [
    { key: "json", label: "导入 JSON", icon: <FileJson size={14} /> },
    { key: "geojson", label: "导入 GeoJSON", icon: <Upload size={14} /> },
  ];
  const exportItems: MenuProps["items"] = [
    { key: "json", label: "导出 JSON", icon: <FileJson size={14} /> },
    { key: "geojson", label: "导出 GeoJSON", icon: <Download size={14} /> },
  ];

  const geoFeatures = useMemo(
    () => documents
      .filter((doc) => doc[geometryField] && typeof doc[geometryField] === "object")
      .map((doc) => ({ geometry: doc[geometryField] })),
    [documents, geometryField],
  );

  const indexColumns = [
    { title: "名称", dataIndex: "name", key: "name" },
    { title: "字段", dataIndex: "key", key: "key", render: (value: unknown) => JSON.stringify(value) },
    { title: "空间", dataIndex: "twoDSphere", key: "twoDSphere", render: (value: unknown) => value ? <Tag color="cyan">2dsphere</Tag> : "—" },
    { title: "唯一", dataIndex: "unique", key: "unique", render: (value: unknown) => value ? "是" : "否" },
  ];

  const columns = useMemo(() => [
    ...[...new Set(documents.flatMap((doc) => Object.keys(doc)))].map((name) => ({
      title: <span className="result-column">{name}</span>,
      dataIndex: name,
      key: name,
      width: name === "_id" ? 200 : 170,
      ellipsis: true,
      render: (value: unknown) => (
        <Text className={typeof value === "number" ? "numeric-value" : "mongo-cell"} title={formatValue(value)}>{formatValue(value)}</Text>
      ),
    })),
    {
      title: "操作",
      key: "__actions",
      width: 116,
      fixed: "right" as const,
      render: (_value: unknown, record: Record<string, unknown> & { __rowKey: string }) => {
        const doc = documents.find((item) => `${formatValue(item._id)}-${documents.indexOf(item)}` === record.__rowKey) ?? record;
        return <DocActions
          onCopy={() => void copyDoc(doc)}
          onEdit={() => openEdit(doc)}
          onDelete={() => void deleteDoc(doc)}
        />;
      },
    },
  ], [documents]); // eslint-disable-line react-hooks/exhaustive-deps

  const rows = useMemo(() => documents.map((doc, index) => ({ ...doc, __rowKey: `${formatValue(doc._id)}-${index}` })), [documents]);
  const aiQuery: MongoQueryDraft = { mode, filter: filterText, projection: projectionText, sort: sortText, pipeline: pipelineText };

  const renderBody = () => {
    if (busy) return <div className="mongo-loading"><Spin /> 正在读取文档</div>;
    if (documents.length === 0) {
      return (
        <div className="mongo-empty">
          <Braces size={26} />
          <b>{collection ? "运行查询以查看文档" : "请选择数据库与 Collection"}</b>
          <span>点击下方模板快速填入 Filter，或从上方查询区开始。</span>
          <div className="mongo-template-row">
            {QUERY_TEMPLATES.map((template) => (
              <Tooltip key={template.label} title={template.hint}>
                <button className="mongo-template" onClick={() => applyTemplate(template.filter)}>
                  <code>{template.label}</code>
                </button>
              </Tooltip>
            ))}
          </div>
        </div>
      );
    }
    if (viewMode === "table") {
      return <LazyDataTable size="small" className="query-table mongo-table" rowKey="__rowKey" columns={columns} dataSource={rows} scroll={{ x: "max-content", y: "calc(100vh - 470px)" }} pagination={false} />;
    }
    if (viewMode === "map") {
      return (
        <div className="mongo-map-view">
          {geoFeatures.length === 0 ? (
            <div className="mongo-map-empty"><MapPin size={22} /><span>当前文档没有可预览的 GeoJSON 几何。请检查几何字段名：</span><Input size="small" value={geometryField} onChange={(e) => setGeometryField(e.target.value)} style={{ width: 160 }} /></div>
          ) : (
            <>
              <div className="mongo-map-meta"><span>几何字段</span><Input size="small" value={geometryField} onChange={(e) => setGeometryField(e.target.value)} style={{ width: 160 }} /><span>{geoFeatures.length} 个要素</span></div>
              <GisPreviewMap features={geoFeatures} coordinateReference="EPSG:4326" onExtentChange={() => undefined} />
            </>
          )}
        </div>
      );
    }
    return (
      <div className="mongo-tree-view">
        {documents.map((doc, index) => (
          <div className="mongo-doc-tree" key={`${formatValue(doc._id)}-${index}`}>
            <DocActions
              onCopy={() => void copyDoc(doc)}
              onEdit={() => openEdit(doc)}
              onDelete={() => void deleteDoc(doc)}
            />
            <JsonTree value={doc} />
          </div>
        ))}
      </div>
    );
  };

  return (
    <section className="mongo-page">
      <div className="mongo-topbar">
        <div className="mongo-topbar-left">
          <LabeledSelect
            icon={<Database size={13} />}
            label="Database:"
            value={database}
            options={databaseOptions}
            placeholder={metaLoading ? "加载中…" : "选择数据库"}
            loading={metaLoading}
            className="mongo-db-select"
            onChange={(value) => { setDatabase(value); setCollection(""); setDocuments([]); }}
          />
          <LabeledSelect
            icon={<Layers3 size={13} />}
            label="Collection:"
            value={collection}
            options={collections}
            placeholder="选择集合"
            loading={metaLoading}
            className="mongo-coll-select"
            onChange={(value) => { setCollection(value); setDocuments([]); }}
          />
          <Segmented
            className="mongo-mode-switch"
            value={mode}
            onChange={(value) => setMode(value as MongoQueryMode)}
            options={[{ value: "find", label: "Find" }, { value: "aggregate", label: "Aggregate" }]}
          />
        </div>
        <div className="mongo-topbar-right">
          <Tooltip title="支持 GeoJSON FeatureCollection 导入；Filter 可用 $geoWithin / $geoIntersects 等空间运算符。">
            <Button type="text" size="small" icon={<Info size={14} />} aria-label="查询提示" className="mongo-info-btn" />
          </Tooltip>
          <Tooltip title="查看或创建 2dsphere 索引">
            <span><Button icon={<ListTree size={14} />} disabled={!collection} onClick={() => setIndexesOpen(true)}>索引</Button></span>
          </Tooltip>
          <Button icon={<Braces size={14} />} onClick={() => setAiOpen(true)}>AI 助手</Button>
          <Dropdown menu={{ items: importItems, onClick: ({ key }) => { if (key === "json") void importJson(); else void importGeoJson(); } }}>
            <Button icon={<FileUp size={14} />} disabled={!collection}>导入 <ChevronDown size={12} /></Button>
          </Dropdown>
          <Dropdown menu={{ items: exportItems, onClick: ({ key }) => { if (key === "json") void exportJson(); else void exportGeoJson(); } }}>
            <Button icon={<Download size={14} />} disabled={!collection}>导出 <ChevronDown size={12} /></Button>
          </Dropdown>
          <Button icon={<RefreshCw size={14} />} onClick={() => { void loadDatabases(); void loadCollections(); }}>刷新</Button>
          <Button type="primary" className="mongo-primary" icon={<Play size={14} />} loading={busy} disabled={!collection} onClick={() => void (mode === "find" ? runFind(0) : runAggregate())}>
            {mode === "find" ? "执行 Find" : "执行 Pipeline"}
          </Button>
        </div>
      </div>

      <section className="mongo-query-panel">
        {mode === "find" ? (
          <div className="mongo-editor-grid">
            <JsonMiniEditor label="Filter" value={filterText} onChange={setFilterText} expanded={filterExpanded} onExpandedChange={setFilterExpanded} placeholder='{"status":"active"}' />
            <JsonMiniEditor label="Projection" value={projectionText} onChange={setProjectionText} expanded={projectionExpanded} onExpandedChange={setProjectionExpanded} placeholder='{"_id":0,"name":1}' />
            <JsonMiniEditor label="Sort" value={sortText} onChange={setSortText} expanded={sortExpanded} onExpandedChange={setSortExpanded} placeholder='{"createdAt":-1}' />
          </div>
        ) : (
          <JsonMiniEditor label="Aggregate Pipeline" value={pipelineText} onChange={setPipelineText} arrayMode expanded={pipelineExpanded} onExpandedChange={setPipelineExpanded} placeholder='[{"$match":{}},{"$limit":100}]' />
        )}
      </section>

      <section className="mongo-results-panel">
        <div className="mongo-results-toolbar">
          <div className="mongo-results-title"><Search size={15} /> 查询结果 <Tag bordered={false}>{documents.length}</Tag></div>
          <div className="mongo-results-controls">
            <Segmented
              size="small"
              className="mongo-view-switch"
              value={viewMode}
              onChange={(value) => setViewMode(value as ViewMode)}
              options={[
                { value: "tree", label: <span><Braces size={13} /> 树形视图</span> },
                { value: "table", label: <span><Table2 size={13} /> 表格视图</span> },
                { value: "map", label: <span><MapPin size={13} /> 空间地图</span> },
              ]}
            />
            <span className="mongo-ctrl-divider" />
            {mode === "find" && <>
              <Text type="secondary" className="mongo-ctrl-label">跳过</Text>
              <InputNumber size="small" min={0} max={1_000_000} value={skip} onChange={(value) => setSkip(value ?? 0)} className="mongo-num-sm" />
              <Text type="secondary" className="mongo-ctrl-label">每页</Text>
              <InputNumber size="small" min={1} max={1000} value={limit} onChange={(value) => setLimit(value ?? 100)} className="mongo-num-sm" />
              <Button size="small" disabled={skip === 0} onClick={() => void runFind(Math.max(0, skip - limit))}>上一页</Button>
              <Button size="small" disabled={documents.length < limit} onClick={() => void runFind(skip + limit)}>下一页</Button>
            </>}
          </div>
        </div>
        {(queryError || metaError !== undefined) && (
          <Alert showIcon type="error" className="mongo-error" message="MongoDB 查询失败"
            description={queryError ?? describeError(metaError, "未知错误")} />
        )}
        <div className="mongo-results-body">{renderBody()}</div>
      </section>

      <Drawer title={`${collection || "Collection"} 索引`} open={indexesOpen} onClose={() => setIndexesOpen(false)} width={640}>
        <Space.Compact style={{ width: "100%", marginBottom: 16 }}>
          <Input value={geometryField} onChange={(event) => setGeometryField(event.target.value)} placeholder="GeoJSON 字段路径" aria-label="GeoJSON 字段路径" />
          <Button type="primary" className="mongo-primary" onClick={() => void create2dsphere()} loading={metaLoading}>创建 2dsphere</Button>
        </Space.Compact>
        {metaError !== undefined && <Alert showIcon type="error" message="读取索引失败" description={describeError(metaError, "未知错误")} />}
        <Table size="small" rowKey="name" columns={indexColumns} dataSource={indexes} loading={metaLoading} pagination={false} />
      </Drawer>

      <Modal
        title="编辑文档"
        open={editingDoc !== null}
        onCancel={() => setEditingDoc(null)}
        onOk={() => void saveEdit()}
        okText="保存修改"
        cancelText="取消"
        width={720}
        destroyOnClose
      >
        <div className="mongo-edit-hint">文档以 EJSON 展示；_id 用于定位文档，保存时不会修改。修改前请确认字段值类型正确。</div>
        <JsonMiniEditor label="文档 JSON" value={editText} onChange={setEditText} expanded />
      </Modal>

      <MongoAiPanel
        open={aiOpen}
        onClose={() => setAiOpen(false)}
        onApply={applyAiQuery}
        connectionId={connectionId}
        database={database}
        collection={collection}
        mode={mode}
        query={aiQuery}
        error={queryError}
      />
    </section>
  );
}
