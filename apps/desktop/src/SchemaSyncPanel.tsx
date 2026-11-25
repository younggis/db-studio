// Structure sync workspace: preview schema differences between two connections
// and apply the selected DDL statements to the target.
import { useEffect, useState } from "react";
import { Alert, Button, Checkbox, Drawer, Select, Space, Table, Tag, Typography, message } from "antd";
import { Play, RefreshCw } from "lucide-react";
import type { DatabaseEngine } from "@db-studio/shared";

const { Text } = Typography;

type Statement = {
  id: string;
  kind: string;
  table: string;
  reason: string;
  sql: string;
  risk: "low" | "medium" | "high";
  selected: boolean;
};

interface SchemaSyncPanelProps {
  open: boolean;
  onClose: () => void;
  activeId?: string;
}

export default function SchemaSyncPanel({ open, onClose, activeId }: SchemaSyncPanelProps) {
  const [connections, setConnections] = useState<Array<{ id: string; name: string; engine: DatabaseEngine }>>([]);
  const [sourceId, setSourceId] = useState("");
  const [sourceSchema, setSourceSchema] = useState("");
  const [targetId, setTargetId] = useState("");
  const [targetSchema, setTargetSchema] = useState("");
  const [sourceSchemas, setSourceSchemas] = useState<string[]>([]);
  const [targetSchemas, setTargetSchemas] = useState<string[]>([]);
  const [includeDrops, setIncludeDrops] = useState(false);
  const [statements, setStatements] = useState<Statement[]>([]);
  const [busy, setBusy] = useState(false);
  const [applied, setApplied] = useState<string>();

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
    window.dbStudio.database.schemas(sourceId)
      .then((items) => { if (!cancelled) { setSourceSchemas(items); setSourceSchema((current) => current || items[0] || ""); } })
      .catch(() => { if (!cancelled) setSourceSchemas([]); });
    return () => { cancelled = true; };
  }, [sourceId]);

  useEffect(() => {
    if (!targetId) return;
    let cancelled = false;
    window.dbStudio.database.schemas(targetId)
      .then((items) => { if (!cancelled) { setTargetSchemas(items); setTargetSchema((current) => current || items[0] || ""); } })
      .catch(() => { if (!cancelled) setTargetSchemas([]); });
    return () => { cancelled = true; };
  }, [targetId]);

  async function preview() {
    if (!sourceId || !targetId || !sourceSchema || !targetSchema) { message.warning("请选择源与目标连接及 Schema。"); return; }
    setBusy(true); setStatements([]); setApplied(undefined);
    try {
      const output = await window.dbStudio.sync.preview(sourceId, sourceSchema, targetId, targetSchema, { includeDrops });
      setStatements(output as Statement[]);
      if (output.length === 0) message.success("两个 Schema 结构一致，无需同步。");
    } catch (error) { message.error(error instanceof Error ? error.message : "预览差异失败。"); }
    finally { setBusy(false); }
  }

  async function applySelected() {
    const selected = statements.filter((statement) => statement.selected);
    if (!selected.length) { message.warning("请至少选择一条语句。"); return; }
    setBusy(true); setApplied(undefined);
    try {
      const output = await window.dbStudio.sync.apply(targetId, selected.map((statement) => ({ sql: statement.sql })));
      setApplied(`成功 ${output.applied} 条，失败 ${output.failed.length} 条`);
      if (output.failed.length) message.warning(`有 ${output.failed.length} 条语句执行失败`);
      else message.success(`已应用 ${output.applied} 条语句`);
      await preview();
    } catch (error) { message.error(error instanceof Error ? error.message : "应用失败。"); }
    finally { setBusy(false); }
  }

  const riskColor = (risk: Statement["risk"]) => risk === "high" ? "red" : risk === "medium" ? "orange" : "green";

  return (
    <Drawer title="结构同步" width={860} open={open} onClose={onClose}>
      <div className="dbtools-sync-grid">
        <div className="dbtools-sync-col">
          <b>源（作为目标结构的基准）</b>
          <Select value={sourceId || undefined} onChange={(value) => { setSourceId(value); setSourceSchema(""); }}
            options={connections.map((item) => ({ value: item.id, label: `${item.name} · ${item.engine}` }))} placeholder="源连接" />
          <Select value={sourceSchema || undefined} onChange={setSourceSchema}
            options={sourceSchemas.map((item) => ({ value: item, label: item }))} placeholder="源 Schema" />
        </div>
        <div className="dbtools-sync-col">
          <b>目标（将被修改）</b>
          <Select value={targetId || undefined} onChange={(value) => { setTargetId(value); setTargetSchema(""); }}
            options={connections.map((item) => ({ value: item.id, label: `${item.name} · ${item.engine}` }))} placeholder="目标连接" />
          <Select value={targetSchema || undefined} onChange={setTargetSchema}
            options={targetSchemas.map((item) => ({ value: item, label: item }))} placeholder="目标 Schema" />
        </div>
      </div>
      <Space style={{ margin: "12px 0" }}>
        <Checkbox checked={includeDrops} onChange={(event) => setIncludeDrops(event.target.checked)}>包含删除操作（高风险）</Checkbox>
        <Button icon={<RefreshCw size={14} />} loading={busy} onClick={() => void preview()}>预览差异</Button>
      </Space>
      {applied && <Alert showIcon type="info" message={applied} />}
      <Table<Statement>
        size="small"
        rowKey="id"
        dataSource={statements}
        loading={busy}
        pagination={false}
        scroll={{ y: 380 }}
        rowSelection={{
          selectedRowKeys: statements.filter((item) => item.selected).map((item) => item.id),
          onChange: (keys) => setStatements((current) => current.map((item) => ({ ...item, selected: keys.includes(item.id) }))),
        }}
        columns={[
          { title: "表", dataIndex: "table", width: 130, ellipsis: true },
          { title: "变更", dataIndex: "kind", width: 140, render: (value: string) => <Tag>{value.replaceAll("-", " ")}</Tag> },
          { title: "原因", dataIndex: "reason", width: 160, ellipsis: true },
          { title: "风险", dataIndex: "risk", width: 70, render: (value: Statement["risk"]) => <Tag color={riskColor(value)}>{value}</Tag> },
          { title: "SQL", dataIndex: "sql", render: (value: string) => <Text code ellipsis title={value}>{value}</Text> },
        ]}
      />
      <div className="dbtools-actions">
        <Button type="primary" className="mongo-primary" icon={<Play size={14} />} loading={busy}
          disabled={!statements.some((item) => item.selected)} onClick={() => void applySelected()}>
          应用选中语句
        </Button>
        <Text type="secondary">请逐条核对 SQL；删除类操作默认不生成。</Text>
      </div>
    </Drawer>
  );
}
