// Redesigned GIS data exchange page (import/export), mounted as an overlay
// replacing the compiled .gis-workspace. All state is local; all data goes
// through window.dbStudio.gis / .database / .files — no business logic changed.
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert, AutoComplete, Button, Collapse, Input, InputNumber, Segmented, Select,
  Space, Spin, Table, Tag, Typography, message,
} from "antd";
import {
  ArrowDownToLine, ArrowUpFromLine, ChevronDown, Database, FileUp, FolderOpen,
  Layers3, MapPin, Play, RefreshCw, Upload,
} from "lucide-react";
import type {
  GisAttributePreview, GisDatasetInfo, GisFieldMapping, GisLayerInfo, GisOperationReport,
  GisSpatialExtent,
} from "@db-studio/gis";
import type { DatabaseEngine, TableInfo } from "@db-studio/shared";
import GisPreviewMap from "./GisPreviewMap";

const { Text, Title } = Typography;

const CRS_OPTIONS = [
  { value: "EPSG:4326", label: "EPSG:4326", desc: "WGS 84 · 经纬度" },
  { value: "EPSG:3857", label: "EPSG:3857", desc: "Web Mercator" },
  { value: "EPSG:4490", label: "EPSG:4490", desc: "CGCS2000 · 经纬度" },
];
const EXPORT_FORMATS = [
  { value: ".gpkg", label: "GeoPackage" },
  { value: ".geojson", label: "GeoJSON" },
  { value: ".shp", label: "Shapefile" },
  { value: ".kml", label: "KML" },
  { value: ".tab", label: "MapInfo TAB" },
];
type Mode = "import" | "export";

interface ConnectionChoice { id: string; name: string; engine: DatabaseEngine; }

export default function GisExchangePage() {
  const [mode, setMode] = useState<Mode>("import");
  const [connections, setConnections] = useState<ConnectionChoice[]>([]);

  // import state
  const [filePath, setFilePath] = useState("");
  const [dragging, setDragging] = useState(false);
  const [info, setInfo] = useState<GisDatasetInfo>();
  const [layerName, setLayerName] = useState("");
  const [preview, setPreview] = useState<GisAttributePreview>();
  const [importConn, setImportConn] = useState<string>();
  const [targetTable, setTargetTable] = useState("");
  const [importMode, setImportMode] = useState<"create" | "append" | "overwrite">("create");
  const [sourceCrs, setSourceCrs] = useState("");
  const [targetCrs, setTargetCrs] = useState("");
  const [fieldMappings, setFieldMappings] = useState<GisFieldMapping[]>([]);
  const [makeValid, setMakeValid] = useState(false);
  const [createSpatialIndex, setCreateSpatialIndex] = useState(false);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<GisOperationReport>();

  // export state
  const [exportConn, setExportConn] = useState<string>();
  const [exportTables, setExportTables] = useState<TableInfo[]>([]);
  const [sourceTable, setSourceTable] = useState("");
  const [exportFormat, setExportFormat] = useState(".gpkg");
  const [outputPath, setOutputPath] = useState("");
  const [advanced, setAdvanced] = useState<string[]>([]);

  const opRef = useRef<string | null>(null);

  useEffect(() => {
    window.dbStudio.connections.list().then((items) => {
      const choices = items
        .filter((item) => ["postgres", "sqlite", "mysql", "mariadb", "sqlserver", "oracle"].includes(item.engine))
        .map((item) => ({ id: item.id, name: item.name, engine: item.engine as DatabaseEngine }));
      setConnections(choices);
      setImportConn((c) => c ?? choices[0]?.id);
      setExportConn((c) => c ?? choices[0]?.id);
    }).catch(() => undefined);
  }, []);

  const importConnInfo = connections.find((c) => c.id === importConn);
  const exportConnInfo = connections.find((c) => c.id === exportConn);

  async function pickFile() {
    const path = await window.dbStudio.files.openVector();
    if (path) await loadFile(path);
  }
  async function loadFile(path: string) {
    setFilePath(path);
    setBusy(true);
    try {
      const dataset = await window.dbStudio.gis.inspect(path);
      setInfo(dataset);
      const first = dataset.layers[0];
      setLayerName(first?.name ?? "");
      setSourceCrs(first?.crs ?? "");
      setTargetTable(suggestTable(first?.name));
      if (first) {
        const p = await window.dbStudio.gis.preview(path, { sourceLayer: first.name, limit: 8 });
        setPreview(p);
        setFieldMappings((p.fields ?? []).map((f) => ({ source: f.name, target: f.name })));
      }
    } catch (e) { message.error(e instanceof Error ? e.message : "读取文件失败。"); }
    finally { setBusy(false); }
  }
  function suggestTable(name?: string) {
    const base = (name ?? "imported_data").toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "imported_data";
    const safe = /^[a-z_]/.test(base) ? base : `layer_${base}`;
    return `public.${safe.slice(0, 56)}`;
  }

  async function loadExportTables() {
    if (!exportConn) return;
    const tables = await window.dbStudio.database.tables(exportConn);
    setExportTables(tables.filter((t) => t.type === "table"));
  }
  useEffect(() => { if (mode === "export" && exportConn) void loadExportTables(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [mode, exportConn]);

  async function doImport() {
    if (!importConn || !filePath || !targetTable.trim()) { message.warning("请选择文件、连接并填写目标表。"); return; }
    const op = crypto.randomUUID();
    opRef.current = op;
    setBusy(true); setReport(undefined);
    try {
      const result = await window.dbStudio.gis.import(importConn, filePath, targetTable.trim(), {
        mode: importMode,
        sourceLayer: layerName || undefined,
        sourceCrs: sourceCrs || undefined,
        targetCrs: targetCrs || undefined,
        fieldMappings,
        makeValid,
        createSpatialIndex,
      }, op);
      setReport(result.report);
      if (result.ok) message.success(`导入完成 · ${result.report.successfulFeatures ?? "未知"} 个要素`);
      else message.error(result.error);
    } catch (e) { message.error(e instanceof Error ? e.message : "导入失败。"); }
    finally { setBusy(false); opRef.current = null; }
  }

  async function doExport() {
    if (!exportConn || !sourceTable || !outputPath.trim()) { message.warning("请选择源表并填写输出路径。"); return; }
    const op = crypto.randomUUID();
    opRef.current = op;
    setBusy(true);
    try {
      const schema = sourceTable.includes(".") ? sourceTable.split(".")[0] : "public";
      const table = sourceTable.includes(".") ? sourceTable.split(".").slice(1).join(".") : sourceTable;
      const result = await window.dbStudio.gis.export(exportConn, `${schema}.${table}`, outputPath.trim(), {
        datasetCreationOptions: [], layerCreationOptions: [],
      }, op);
      if (result.ok) message.success(`导出完成 · ${result.dataset.layers[0]?.featureCount ?? "未知"} 个要素`);
      else message.error(result.error);
    } catch (e) { message.error(e instanceof Error ? e.message : "导出失败。"); }
    finally { setBusy(false); opRef.current = null; }
  }

  const crsOptions = useMemo(() => CRS_OPTIONS.map((o) => ({ value: o.value, label: <span className="gx-crs-option">{o.label}<small>{o.desc}</small></span> })), []);
  const layer = info?.layers.find((l) => l.name === layerName);
  const previewColumns = useMemo(() => (preview?.fields ?? []).map((f) => ({
    title: f.name, dataIndex: f.name, key: f.name, ellipsis: true, width: 140,
    render: (v: unknown) => String(v ?? ""),
  })), [preview]);

  return (
    <div className="gis-exchange">
      <div>
        <Title level={4} className="gx-title">{mode === "import" ? "导入矢量数据" : "导出矢量数据"}</Title>
        <div className="gx-subtitle">
          {mode === "import"
            ? `矢量文件 → 空间数据表${importConnInfo ? ` · 导入到 ${importConnInfo.name}` : ""}`
            : `空间数据表 → 矢量文件${exportConnInfo ? ` · 来自 ${exportConnInfo.name}` : ""}`}
        </div>
      </div>

      <Segmented
        value={mode}
        onChange={(v) => { setMode(v as Mode); setReport(undefined); }}
        options={[
          { value: "import", label: <span><ArrowDownToLine size={14} /> 导入矢量文件到数据库</span> },
          { value: "export", label: <span><ArrowUpFromLine size={14} /> 从空间数据库导出</span> },
        ]}
      />

      {mode === "import" ? (
        <>
          <section className="gx-card">
            <div className="gx-step-head"><span className="gx-step-num">1</span><span className="gx-step-title">源文件</span></div>
            <div
              className={`gx-dropzone ${dragging ? "dragover" : ""}`}
              onClick={() => void pickFile()}
              onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files[0]; if (f) void loadFile((f as File & { path?: string }).path ?? f.name); }}
            >
              <FileUp size={28} color="var(--ds-brand)" />
              {filePath ? <><b>{filePath.split(/[\\/]/).pop()}</b><span>{filePath}</span></> : <><b>点击选择或拖拽矢量文件到此处</b><span>支持 SHP · GeoJSON · KML · TAB · GPKG</span></>}
            </div>
            {info && (
              <div className="gx-field" style={{ marginTop: 12 }}>
                <label>源图层</label>
                <Select value={layerName} onChange={setLayerName} options={info.layers.map((l) => ({ value: l.name, label: `${l.name} · ${l.featureCount ?? "?"} 要素` }))} />
              </div>
            )}
          </section>

          <section className="gx-card">
            <div className="gx-step-head"><span className="gx-step-num">2</span><span className="gx-step-title">目标数据库</span></div>
            <div className="gx-row">
              <div className="gx-field"><label>连接</label><Select value={importConn} onChange={setImportConn} options={connections.map((c) => ({ value: c.id, label: `${c.name} · ${c.engine}` }))} /></div>
              <div className="gx-field"><label>目标表（schema.table）</label><Input value={targetTable} onChange={(e) => setTargetTable(e.target.value)} placeholder="public.roads" /></div>
            </div>
            <div className="gx-field"><label>导入模式</label>
              <Segmented value={importMode} onChange={(v) => setImportMode(v as typeof importMode)} options={[
                { value: "create", label: "新建表" }, { value: "append", label: "追加" }, { value: "overwrite", label: "覆盖" },
              ]} />
            </div>
          </section>

          <section className="gx-card">
            <div className="gx-step-head"><span className="gx-step-num">3</span><span className="gx-step-title">导入参数</span></div>
            <div className="gx-row">
              <div className="gx-field"><label>源 CRS</label><AutoComplete value={sourceCrs} onChange={setSourceCrs} options={crsOptions} placeholder="EPSG:4326 或留空" /></div>
              <div className="gx-field"><label>目标 CRS</label><AutoComplete value={targetCrs} onChange={setTargetCrs} options={crsOptions} placeholder="EPSG:4326 或留空" /></div>
            </div>
            <Space wrap>
              <Button type={makeValid ? "primary" : "default"} size="small" onClick={() => setMakeValid(!makeValid)}>检查几何并报告错误</Button>
              <label><input type="checkbox" checked={makeValid} onChange={(e) => setMakeValid(e.target.checked)} /> 导入前修复无效几何</label>
              <label><input type="checkbox" checked={createSpatialIndex} onChange={(e) => setCreateSpatialIndex(e.target.checked)} /> 导入后创建空间索引</label>
            </Space>
            <Collapse ghost className="gx-advanced" style={{ marginTop: 12 }} activeKey={advanced} onChange={(k) => setAdvanced(k as string[])} items={[{
              key: "advanced",
              label: <span><ChevronDown size={13} /> 高级选项（GDAL / PROJ 参数）</span>,
              children: <div className="gx-row">
                <div className="gx-field"><label>字段映射（源 → 目标）</label>
                  {fieldMappings.slice(0, 20).map((m, i) => (
                    <Space key={i} size={4} style={{ width: "100%", marginBottom: 4 }}>
                      <Input size="small" value={m.source} readOnly style={{ width: 120 }} />
                      <span>→</span>
                      <Input size="small" value={m.target} onChange={(e) => setFieldMappings((cur) => cur.map((x, j) => j === i ? { ...x, target: e.target.value } : x))} />
                    </Space>
                  ))}
                </div>
                <div><div className="gx-field"><label>ZIP 成员名编码</label><Input placeholder="默认；必要时填写 UTF-8 / CP936" /></div>
                  <div className="gx-field"><label>数据集创建选项（NAME=VALUE，每行一个）</label><Input.TextArea rows={2} placeholder="VERSION=1.2" /></div>
                  <div className="gx-field"><label>图层创建选项</label><Input.TextArea rows={2} placeholder="SPATIAL_INDEX=NO" /></div>
                </div>
              </div>,
            }]} />
            <div style={{ marginTop: 16, textAlign: "right" }}>
              <Button type="primary" className="gx-primary" icon={<Play size={15} />} loading={busy} disabled={!filePath || !targetTable.trim() || !importConn} onClick={() => void doImport()}>导入数据</Button>
            </div>
          </section>

          {layer && preview && (
            <section className="gx-card">
              <div className="gx-step-head"><span className="gx-step-num">✓</span><span className="gx-step-title">数据与字段预览</span></div>
              <div className="gx-preview-wrap">
                <Table size="small" pagination={false} dataSource={preview.rows.map((r, i) => ({ ...r, key: i }))} columns={previewColumns} scroll={{ x: "max-content" }} />
              </div>
              <div style={{ marginTop: 12 }}><GisPreviewMap features={preview.features} coordinateReference={sourceCrs || (layer.crs ?? undefined)} disabled={busy} onExtentChange={(_e: GisSpatialExtent | null) => undefined} /></div>
            </section>
          )}
          {report && <Alert showIcon type={report.status === "completed" ? "success" : report.status === "cancelled" ? "warning" : "error"} message={`导入${report.status === "completed" ? "完成" : report.status === "cancelled" ? "已取消" : "失败"}`} description={`成功 ${report.successfulFeatures ?? "未知"} / 失败 ${report.failedFeatures ?? "未知"}`} />}
        </>
      ) : (
        <>
          <section className="gx-card">
            <div className="gx-step-head"><span className="gx-step-num">1</span><span className="gx-step-title">源数据库与表</span></div>
            <div className="gx-row">
              <div className="gx-field"><label>连接</label><Select value={exportConn} onChange={(v) => { setExportConn(v); setSourceTable(""); }} options={connections.map((c) => ({ value: c.id, label: `${c.name} · ${c.engine}` }))} /></div>
              <div className="gx-field"><label>源表</label><Select value={sourceTable || undefined} onChange={setSourceTable} options={exportTables.map((t) => ({ value: `${t.schema}.${t.name}`, label: `${t.schema}.${t.name}` }))} showSearch /></div>
            </div>
            <Button size="small" icon={<RefreshCw size={13} />} onClick={() => void loadExportTables()}>刷新表清单</Button>
          </section>

          <section className="gx-card">
            <div className="gx-step-head"><span className="gx-step-num">2</span><span className="gx-step-title">导出格式与参数</span></div>
            <div className="gx-field"><label>输出格式</label>
              <div className="gx-format-pills">
                {EXPORT_FORMATS.map((f) => <span key={f.value} className={`gx-format-pill ${exportFormat === f.value ? "active" : ""}`} onClick={() => { setExportFormat(f.value); setOutputPath((p) => p ? p.replace(/\.[^.]+$/, f.value) : p); }}>{f.label}</span>)}
              </div>
            </div>
            <div className="gx-field"><label>输出路径</label>
              <Space.Compact style={{ width: "100%" }}>
                <Input value={outputPath} onChange={(e) => setOutputPath(e.target.value)} placeholder={`选择路径并保存为 ${exportFormat}`} />
                <Button icon={<FolderOpen size={13} />} onClick={async () => { const p = await window.dbStudio.files.saveVector(); if (p) setOutputPath(p); }}>选择路径</Button>
              </Space.Compact>
            </div>
            <div className="gx-row">
              <div className="gx-field"><label>输出图层名（可选）</label><Input placeholder="留空使用文件名" /></div>
              <div className="gx-field"><label>目标 CRS</label><AutoComplete options={crsOptions} placeholder="EPSG:4326 或留空" /></div>
            </div>
            <Collapse ghost className="gx-advanced" activeKey={advanced} onChange={(k) => setAdvanced(k as string[])} items={[{
              key: "advanced",
              label: <span><ChevronDown size={13} /> 高级选项（GDAL / PROJ 参数）</span>,
              children: <div className="gx-row"><div><div className="gx-field"><label>数据集创建选项</label><Input.TextArea rows={2} /></div><div className="gx-field"><label>图层创建选项</label><Input.TextArea rows={2} /></div></div><div className="gx-field"><label>坐标操作（PROJ pipeline）</label><Input.TextArea rows={3} placeholder="需同时指定目标 CRS" /></div></div>,
            }]} />
            <div style={{ marginTop: 16, textAlign: "right" }}>
              <Button type="primary" className="gx-primary" icon={<ArrowUpFromLine size={15} />} loading={busy} disabled={!sourceTable || !outputPath.trim() || !exportConn} onClick={() => void doExport()}>选择路径并导出</Button>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
