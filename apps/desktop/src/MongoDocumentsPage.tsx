// Reconstructed from vendor chunk MongoDocumentsPage-D9MAV3zD.js.
import { useEffect, useMemo, useState } from "react";
import { Alert, Button, Card, Drawer, Input, InputNumber, Select, Space, Spin, Table, Tag, Typography, message } from "antd";
import { Braces, Database, Download, FileJson, FileUp, ListTree, Play, RefreshCw, Search, Upload } from "lucide-react";
import LazyDataTable from "./LazyDataTable";
import MongoAiPanel, { type MongoQueryDraft } from "./MongoAiPanel";
import type { MongoQueryMode } from "@db-studio/ai";

const { Text } = Typography;

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
  return error instanceof Error ? error.message : fallback ?? fallback;
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
  const [skip, setSkip] = useState(0);
  const [limit, setLimit] = useState(100);
  const [documents, setDocuments] = useState<Array<Record<string, unknown>>>([]);
  const [busy, setBusy] = useState(false);
  const [queryError, setQueryError] = useState<string>();
  const [indexesOpen, setIndexesOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [geometryField, setGeometryField] = useState("geometry");

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
    try {
      const filter = parseObject(filterText, "Filter") ?? {};
      const projection = parseObject(projectionText, "Projection");
      const sort = parseObject(sortText, "Sort");
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("每页数量必须在 1 到 1000 之间。");
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

  async function importJson() {
    if (!database || !collection) { message.warning("请选择目标数据库和 Collection。"); return; }
    setBusy(true);
    try {
      const result = await window.dbStudio.mongo.import(connectionId, database, collection);
      if (!result) return;
      message.success(`已导入 ${result.insertedCount} 个文档到 ${collection}`);
      if (mode === "find") await runFind(0); else await runAggregate();
    } catch (cause) { message.error(describeError(cause, "导入失败。")); } finally { setBusy(false); }
  }

  async function exportJson() {
    if (!database || !collection) { message.warning("请选择源数据库和 Collection。"); return; }
    try {
      const filter = parseObject(filterText, "Filter");
      const result = await window.dbStudio.mongo.export(connectionId, database, collection, filter);
      if (result) message.success(`已导出 ${result.documentCount} 个文档 · ${result.path}`);
    } catch (cause) { message.error(describeError(cause, "导出失败。")); }
  }

  async function importGeoJson() {
    if (!database || !collection) { message.warning("请选择目标数据库和 Collection。"); return; }
    setBusy(true);
    try {
      const result = await window.dbStudio.mongo.importGeoJson(connectionId, database, collection, geometryField.trim() || "geometry");
      if (!result) return;
      message.success(`已导入 ${result.insertedCount} 个 GeoJSON 要素到 ${collection}`);
      if (mode === "find") await runFind(0); else await runAggregate();
    } catch (cause) { message.error(describeError(cause, "导入 GeoJSON 失败。")); } finally { setBusy(false); }
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

  function applyAiQuery(next: MongoQueryDraft) {
    setMode(next.mode);
    setFilterText(next.filter);
    setProjectionText(next.projection);
    setSortText(next.sort);
    setPipelineText(next.pipeline);
    setSkip(0);
  }

  const indexColumns = [
    { title: "名称", dataIndex: "name", key: "name" },
    { title: "字段", dataIndex: "key", key: "key", render: (value: unknown) => JSON.stringify(value) },
    { title: "空间", dataIndex: "twoDSphere", key: "twoDSphere", render: (value: unknown) => value ? <Tag color="cyan">2dsphere</Tag> : "—" },
    { title: "唯一", dataIndex: "unique", key: "unique", render: (value: unknown) => value ? "是" : "否" },
  ];

  const columns = useMemo(() => [...new Set(documents.flatMap((doc) => Object.keys(doc)))].map((name) => ({
    title: <span className="result-column">{name}</span>,
    dataIndex: name,
    key: name,
    width: name === "_id" ? 220 : 180,
    ellipsis: true,
    render: (value: unknown) => (
      <Text className={typeof value === "number" ? "numeric-value" : "mongo-cell"} title={formatValue(value)}>{formatValue(value)}</Text>
    ),
  })), [documents]);

  const rows = useMemo(() => documents.map((doc, index) => ({ ...doc, __rowKey: `${formatValue(doc._id)}-${index}` })), [documents]);

  const aiQuery: MongoQueryDraft = { mode, filter: filterText, projection: projectionText, sort: sortText, pipeline: pipelineText };

  return (
    <section className="mongo-workspace">
      <Card className="mongo-query-card" title={
        <div className="card-heading">
          <span className="card-icon teal"><Database size={17} /></span>
          <div><b>MongoDB 文档查询</b><small>Filter、Projection、Sort、Aggregate 与 JSON/EJSON</small></div>
        </div>
      }>
        <div className="mongo-toolbar">
          <Select value={database || undefined} placeholder="选择数据库" loading={metaLoading} onChange={(value) => { setDatabase(value); setCollection(""); setDocuments([]); }} options={databaseOptions.map((item) => ({ value: item, label: item }))} className="mongo-database-select" />
          <Select value={collection || undefined} placeholder="选择 Collection" loading={metaLoading} onChange={(value) => { setCollection(value); setDocuments([]); }} options={collections.map((item) => ({ value: item, label: item }))} className="mongo-collection-select" />
          <Select value={mode} onChange={setMode} options={[{ value: "find", label: "Find" }, { value: "aggregate", label: "Aggregate" }]} className="mongo-mode-select" />
          <Button icon={<Braces size={14} />} onClick={() => setAiOpen(true)}>AI 助手</Button>
          <Button icon={<ListTree size={14} />} disabled={!collection} onClick={() => setIndexesOpen(true)}>索引</Button>
          <Button icon={<RefreshCw size={14} />} onClick={() => { void loadDatabases(); void loadCollections(); }}>刷新</Button>
        </div>

        {mode === "find" ? (
          <div className="mongo-json-grid">
            <label>Filter<Input.TextArea value={filterText} onChange={(event) => setFilterText(event.target.value)} autoSize={{ minRows: 3, maxRows: 8 }} spellCheck={false} placeholder={'{"geometry":{"$geoWithin":{"$geometry":{"type":"Polygon","coordinates":[...]}}}}'} /></label>
            <label>Projection<Input.TextArea value={projectionText} onChange={(event) => setProjectionText(event.target.value)} autoSize={{ minRows: 3, maxRows: 8 }} spellCheck={false} placeholder={'{"_id":0,"name":1}'} /></label>
            <label>Sort<Input.TextArea value={sortText} onChange={(event) => setSortText(event.target.value)} autoSize={{ minRows: 3, maxRows: 8 }} spellCheck={false} placeholder={'{"createdAt":-1}'} /></label>
          </div>
        ) : (
          <label className="mongo-pipeline-label">Aggregate Pipeline<Input.TextArea value={pipelineText} onChange={(event) => setPipelineText(event.target.value)} autoSize={{ minRows: 4, maxRows: 9 }} spellCheck={false} /></label>
        )}

        <div className="mongo-action-row">
          <Space size={8}>
            {mode === "find" && <><Text type="secondary">跳过</Text><InputNumber min={0} max={1_000_000} value={skip} onChange={(value) => setSkip(value ?? 0)} /><Text type="secondary">每页</Text></>}
            <InputNumber min={1} max={1000} value={limit} onChange={(value) => setLimit(value ?? 100)} />
            <Text type="secondary">条</Text>
          </Space>
          <Space>
            <Button icon={<FileUp size={14} />} disabled={!collection} loading={busy} onClick={() => void importJson()}>导入 JSON</Button>
            <Button icon={<Upload size={14} />} disabled={!collection} loading={busy} onClick={() => void importGeoJson()}>导入 GeoJSON</Button>
            <Button icon={<FileJson size={14} />} disabled={!collection} onClick={() => void exportJson()}>导出 JSON</Button>
            <Button icon={<Download size={14} />} disabled={!collection} onClick={() => void exportGeoJson()}>导出 GeoJSON</Button>
            <Button type="primary" icon={<Play size={14} />} loading={busy} disabled={!collection} onClick={() => mode === "find" ? void runFind(0) : void runAggregate()}>{mode === "find" ? "执行 Find" : "执行 Pipeline"}</Button>
          </Space>
        </div>
        <Alert className="mongo-import-note" showIcon type="info" message="支持 GeoJSON FeatureCollection 转换；Filter 可使用 $geoWithin / $geoIntersects 等 MongoDB 空间运算符。“索引”可查看或创建 2dsphere 索引。" />
      </Card>

      <Card className="mongo-results-card" title={
        <div className="mongo-results-heading"><span><Search size={15} /> 查询结果</span><Tag bordered={false}>{documents.length} 个文档</Tag></div>
      }>
        {queryError && <Alert showIcon type="error" message="MongoDB 查询失败" description={queryError} className="mongo-error" />}
        {metaError !== undefined && <Alert showIcon type="error" message="读取 MongoDB 元数据失败" description={describeError(metaError, "未知错误")} className="mongo-error" />}
        {busy
          ? <div className="mongo-loading"><Spin /> 正在读取文档</div>
          : documents.length > 0
            ? <>
                <LazyDataTable size="small" className="query-table mongo-table" rowKey="__rowKey" columns={columns} dataSource={rows} scroll={{ x: "max-content", y: "calc(100vh - 610px)" }} pagination={false} />
                {mode === "find" && <div className="mongo-pagination">
                  <Text type="secondary">{`第 ${Math.floor(skip / Math.max(limit, 1)) + 1} 页`}</Text>
                  <Space>
                    <Button size="small" disabled={skip === 0} onClick={() => void runFind(Math.max(0, skip - limit))}>上一页</Button>
                    <Button size="small" disabled={documents.length < limit} onClick={() => void runFind(skip + limit)}>下一页</Button>
                  </Space>
                </div>}
              </>
            : <div className="mongo-empty"><Braces size={20} /><b>{collection ? "运行查询以查看文档" : "请选择数据库与 Collection"}</b><span>文档以 JSON/EJSON 字段展示，查询结果可分页浏览。</span></div>}
      </Card>

      <Drawer title={`${collection || "Collection"} 索引`} open={indexesOpen} onClose={() => setIndexesOpen(false)} styles={{ wrapper: { width: 680 } }}>
        <Space.Compact style={{ width: "100%", marginBottom: 16 }}>
          <Input value={geometryField} onChange={(event) => setGeometryField(event.target.value)} placeholder="GeoJSON 字段路径" aria-label="GeoJSON 字段路径" />
          <Button type="primary" onClick={() => void create2dsphere()} loading={metaLoading}>创建 2dsphere</Button>
        </Space.Compact>
        {metaError !== undefined && <Alert showIcon type="error" message="读取索引失败" description={describeError(metaError, "未知错误")} />}
        <Table size="small" rowKey="name" columns={indexColumns} dataSource={indexes} loading={metaLoading} pagination={false} />
      </Drawer>

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
