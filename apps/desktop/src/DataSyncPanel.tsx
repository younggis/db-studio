// Row-level data sync between two SQL tables. Preview compares row counts and
// columns; run reuses the existing paged, type-aware table transfer engine.
import { useEffect, useState } from "react";
import { Alert, Button, Drawer, Radio, Select, Space, Table, Tag, Typography, message } from "antd";
import { Play, RefreshCw } from "lucide-react";
import type { DatabaseEngine } from "@db-studio/shared";

const { Text } = Typography;

type Snapshot = {
  rowCount: number;
  columns: Array<{ name: string; dataType: string; primaryKey: boolean }>;
};

interface DataSyncPanelProps {
  open: boolean;
  onClose: () => void;
  activeId?: string;
}

export default function DataSyncPanel({ open, onClose, activeId }: DataSyncPanelProps) {
  const [connections, setConnections] = useState<Array<{ id: string; name: string; engine: DatabaseEngine }>>([]);
  const [sourceId, setSourceId] = useState("");
  const [sourceSchema, setSourceSchema] = useState("");
  const [sourceTable, setSourceTable] = useState("");
  const [targetId, setTargetId] = useState("");
  const [targetSchema, setTargetSchema] = useState("");
  const [targetTable, setTargetTable] = useState("");
  const [sourceSchemas, setSourceSchemas] = useState<string[]>([]);
  const [targetSchemas, setTargetSchemas] = useState<string[]>([]);
  const [sourceTables, setSourceTables] = useState<string[]>([]);
  const [targetTables, setTargetTables] = useState<string[]>([]);
  const [mode, setMode] = useState<"append" | "replace">("replace");
  const [preview, setPreview] = useState<{ source: Snapshot; target: Snapshot }>();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string>();

  useEffect(() => {
    if (!open) return;
    window.dbStudio.connections.list().then((items) => {
      const sql = items.filter((item) => item.engine !== "mongodb")
        .map((item) => ({ id: item.id, name: item.name, engine: item.engine as DatabaseEngine }));
      setConnections(sql);
      setSourceId((current) => current || activeId || sql[0]?.id || "");
      setTargetId((current) => current || sql.find((item) => item.id !== (activeId || sql[0]?.id))?.id || sql[0]?.id || "");
    }).catch(() => undefined);
  }, [open, activeId]);

  useEffect(() => {
    if (!sourceId) return;
    let cancelled = false;
    window.dbStudio.database.schemas(sourceId).then((items) => {
      if (cancelled) return;
      setSourceSchemas(items); setSourceSchema((current) => current || items[0] || "");
    }).catch(() => { if (!cancelled) setSourceSchemas([]); });
    return () => { cancelled = true; };
  }, [sourceId]);

  useEffect(() => {
    if (!targetId) return;
    let cancelled = false;
    window.dbStudio.database.schemas(targetId).then((items) => {
      if (cancelled) return;
      setTargetSchemas(items); setTargetSchema((current) => current || items[0] || "");
    }).catch(() => { if (!cancelled) setTargetSchemas([]); });
    return () => { cancelled = true; };
  }, [targetId]);

  useEffect(() => {
    if (!sourceId || !sourceSchema) return;
    let cancelled = false;
    window.dbStudio.database.tables(sourceId, sourceSchema).then((tables) => {
      if (cancelled) return;
      setSourceTables(tables.filter((table) => table.type === "table").map((table) => table.name));
      setSourceTable("");
    }).catch(() => { if (!cancelled) setSourceTables([]); });
    return () => { cancelled = true; };
  }, [sourceId, sourceSchema]);

  useEffect(() => {
    if (!targetId || !targetSchema) return;
    let cancelled = false;
    window.dbStudio.database.tables(targetId, targetSchema).then((tables) => {
      if (cancelled) return;
      setTargetTables(tables.filter((table) => table.type === "table").map((table) => table.name));
      setTargetTable("");
    }).catch(() => { if (!cancelled) setTargetTables([]); });
    return () => { cancelled = true; };
  }, [targetId, targetSchema]);

  async function runPreview() {
    if (!sourceId || !sourceTable || !targetId || !targetTable) { message.warning("请选择源表与目标表。"); return; }
    setBusy(true); setPreview(undefined); setResult(undefined);
    try {
      setPreview(await window.dbStudio.sync.dataPreview(sourceId, sourceSchema, sourceTable, targetId, targetSchema, targetTable));
    } catch (error) { message.error(error instanceof Error ? error.message : "预览失败。"); }
    finally { setBusy(false); }
  }

  async function runSync() {
    if (!preview) { message.warning("请先预览数据差异。"); return; }
    setBusy(true); setResult(undefined);
    try {
      const output = await window.dbStudio.sync.dataRun(sourceId, sourceSchema, sourceTable, targetId, targetSchema, targetTable, mode, 500);
      setResult(`已读取 ${output.sourceRows} 行，写入 ${output.insertedRows} 行（${mode === "replace" ? "替换" : "追加"}模式）`);
      message.success("数据同步完成");
      await runPreview();
    } catch (error) { message.error(error instanceof Error ? error.message : "同步失败。"); }
    finally { setBusy(false); }
  }

  const columnRows = preview
    ? [...new Set([...preview.source.columns.map((column) => column.name), ...preview.target.columns.map((column) => column.name)])]
      .map((name) => {
        const source = preview.source.columns.find((column) => column.name === name);
        const target = preview.target.columns.find((column) => column.name === name);
        return { name, sourceType: source?.dataType ?? "—", targetType: target?.dataType ?? "—", status: !source ? "目标独有" : !target ? "源独有" : source.dataType !== target.dataType ? "类型不同" : "一致" };
      })
    : [];

  return (
    <Drawer
      title="数据同步"
      width={820}
      open={open}
      onClose={onClose}
      maskClosable={true}
      keyboard={true}
      rootClassName="wb-app-drawer"
    >
      <div className="dbtools-sync-grid">
        <div className="dbtools-sync-col">
          <b>源表</b>
          <Select value={sourceId || undefined} onChange={(value) => { setSourceId(value); setSourceSchema(""); }}
            options={connections.map((item) => ({ value: item.id, label: `${item.name} · ${item.engine}` }))} placeholder="源连接" />
          <Select value={sourceSchema || undefined} onChange={(value) => { setSourceSchema(value); setSourceTable(""); }}
            options={sourceSchemas.map((item) => ({ value: item, label: item }))} placeholder="源 Schema" />
          <Select value={sourceTable || undefined} onChange={setSourceTable}
            options={sourceTables.map((item) => ({ value: item, label: item }))} placeholder="源表" showSearch />
        </div>
        <div className="dbtools-sync-col">
          <b>目标表</b>
          <Select value={targetId || undefined} onChange={(value) => { setTargetId(value); setTargetSchema(""); }}
            options={connections.map((item) => ({ value: item.id, label: `${item.name} · ${item.engine}` }))} placeholder="目标连接" />
          <Select value={targetSchema || undefined} onChange={(value) => { setTargetSchema(value); setTargetTable(""); }}
            options={targetSchemas.map((item) => ({ value: item, label: item }))} placeholder="目标 Schema" />
          <Select value={targetTable || undefined} onChange={setTargetTable}
            options={targetTables.map((item) => ({ value: item, label: item }))} placeholder="目标表" showSearch />
        </div>
      </div>
      <Space style={{ margin: "12px 0" }}>
        <Radio.Group value={mode} onChange={(event) => setMode(event.target.value)} optionType="button" buttonStyle="solid">
          <Radio.Button value="replace">替换目标数据</Radio.Button>
          <Radio.Button value="append">追加到目标</Radio.Button>
        </Radio.Group>
        <Button icon={<RefreshCw size={14} />} loading={busy} onClick={() => void runPreview()}>预览差异</Button>
      </Space>
      {preview && (
        <>
          <Alert showIcon type="info" message={`源 ${preview.source.rowCount} 行 · 目标 ${preview.target.rowCount} 行`} />
          <Table
            size="small" rowKey="name" dataSource={columnRows} pagination={false} scroll={{ y: 260 }}
            columns={[
              { title: "字段", dataIndex: "name", width: 160 },
              { title: "源类型", dataIndex: "sourceType", width: 160 },
              { title: "目标类型", dataIndex: "targetType", width: 160 },
              { title: "状态", dataIndex: "status", render: (value: string) => <Tag color={value === "一致" ? "green" : "orange"}>{value}</Tag> },
            ]}
          />
        </>
      )}
      {result && <Alert showIcon type="success" message={result} />}
      <div className="dbtools-actions">
        <Button type="primary" className="mongo-primary" icon={<Play size={14} />} loading={busy} disabled={!preview} onClick={() => void runSync()}>开始同步</Button>
        <Text type="secondary">替换模式会先清空目标表；同步使用主键游标分批读取，保留字段类型转换。</Text>
      </div>
    </Drawer>
  );
}
