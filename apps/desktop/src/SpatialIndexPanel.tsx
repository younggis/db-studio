// Phase 3: spatial index diagnostic panel. Shown for a selected connection and
// table; calls the shared Core diagnostic and displays review-only SQL.
import { useEffect, useState } from "react";
import { Alert, Button, Drawer, Input, Select, Space, Table, Tag, Typography, message } from "antd";
import { Database } from "lucide-react";
import { diagnoseSpatialIndex, type SpatialIndexDiagnostic } from "@db-studio/core";
import type { ColumnInfo, DatabaseEngine, TableInfo } from "@db-studio/shared";

const { Text } = Typography;

interface SpatialIndexPanelProps {
  open: boolean;
  onClose: () => void;
  connectionId?: string;
  engine?: DatabaseEngine;
  schemas: string[];
}

export default function SpatialIndexPanel({ open, onClose, connectionId, engine, schemas }: SpatialIndexPanelProps) {
  const [schema, setSchema] = useState<string>();
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [table, setTable] = useState<string>();
  const [diagnostic, setDiagnostic] = useState<SpatialIndexDiagnostic>();
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (open && !schema && schemas.length) setSchema(schemas[0]); }, [open, schemas, schema]);

  async function loadTables() {
    if (!connectionId || !schema) return;
    setBusy(true);
    try {
      setTables(await window.dbStudio.database.tables(connectionId, schema));
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : "读取表清单失败。");
    } finally { setBusy(false); }
  }

  useEffect(() => { if (open) void loadTables(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [open, connectionId, schema]);

  async function diagnose() {
    if (!connectionId || !engine || !schema || !table) return;
    setBusy(true);
    try {
      const columns: ColumnInfo[] = await window.dbStudio.database.columns(connectionId, table, schema);
      setDiagnostic(diagnoseSpatialIndex({ engine, schema, table, columns }));
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : "读取字段失败。");
    } finally { setBusy(false); }
  }

  async function copySuggestion() {
    if (!diagnostic?.suggestionSql) return;
    try { await navigator.clipboard.writeText(diagnostic.suggestionSql); message.success("建议 SQL 已复制，未执行。"); }
    catch { message.error("复制失败，请手动选择。"); }
  }

  return (
    <Drawer
      title={<span><Database size={16} /> 空间索引诊断</span>}
      open={open}
      onClose={onClose}
      width={640}
      destroyOnHidden
    >
      <Alert
        showIcon
        type="info"
        className="ai-panel-alert"
        message="只诊断，不执行"
        description="本面板根据表结构生成建议 SQL，供你核对后手动执行；不会运行 EXPLAIN、DDL 或任何写操作。"
      />
      <Space direction="vertical" style={{ width: "100%" }} size={12}>
        <label className="field-label">Schema
          <Select value={schema} onChange={setSchema} options={schemas.map((item) => ({ value: item, label: item }))} style={{ width: "100%" }} />
        </label>
        <Space.Compact style={{ width: "100%" }}>
          <Select
            value={table}
            onChange={setTable}
            placeholder="选择要诊断的表"
            loading={busy}
            style={{ width: "100%" }}
            options={tables.map((item) => ({ value: item.name, label: `${item.schema}.${item.name}` }))}
          />
          <Button type="primary" loading={busy} disabled={!table || !engine} onClick={() => void diagnose()}>诊断</Button>
        </Space.Compact>
        {!engine && <Alert type="warning" message="请先选择一个数据库连接。" />}
        {diagnostic && <>
          <Alert
            showIcon
            type={diagnostic.severity === "warning" ? "warning" : "info"}
            message={diagnostic.message}
            description={<ul>{diagnostic.reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul>}
          />
          <Space size={8}>
            {diagnostic.spatialColumns.map((column) => <Tag color="cyan" key={column}>{column}</Tag>)}
          </Space>
          {diagnostic.suggestionSql && <>
            <Text strong>建议 SQL（只展示，不执行）</Text>
            <Input.TextArea value={diagnostic.suggestionSql} readOnly autoSize={{ minRows: 6, maxRows: 14 }} />
            <Button icon={<Database size={13} />} onClick={() => void copySuggestion()}>复制建议 SQL</Button>
          </>}
        </>}
      </Space>
    </Drawer>
  );
}
