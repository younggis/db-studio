// Visual table designer: edit columns/indexes/foreign keys, preview the DDL and apply it.
import { useEffect, useState } from "react";
import { Alert, Button, Checkbox, Drawer, Input, Radio, Select, Space, Table, Typography, message } from "antd";
import { Columns3, Play, Plus, RefreshCw, Trash2 } from "lucide-react";
import type { DatabaseEngine } from "@db-studio/shared";

const { Text } = Typography;

type Column = { name: string; dataType: string; nullable: boolean; defaultValue: string | null; primaryKey: boolean };
type Index = { name: string; columns: string; unique: boolean };
type ForeignKey = { name: string; columns: string; referencedSchema: string; referencedTable: string; referencedColumns: string };

interface TableDesignerPanelProps {
  open: boolean;
  onClose: () => void;
  activeId?: string;
}

export default function TableDesignerPanel({ open, onClose, activeId }: TableDesignerPanelProps) {
  const [connections, setConnections] = useState<Array<{ id: string; name: string; engine: DatabaseEngine }>>([]);
  const [connectionId, setConnectionId] = useState("");
  const [schema, setSchema] = useState("");
  const [schemas, setSchemas] = useState<string[]>([]);
  const [mode, setMode] = useState<"create" | "alter">("create");
  const [tableName, setTableName] = useState("");
  const [tables, setTables] = useState<string[]>([]);
  const [columns, setColumns] = useState<Column[]>([
    { name: "id", dataType: "INTEGER", nullable: false, defaultValue: null, primaryKey: true },
  ]);
  const [indexes, setIndexes] = useState<Index[]>([]);
  const [foreignKeys, setForeignKeys] = useState<ForeignKey[]>([]);
  const [sql, setSql] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string>();

  useEffect(() => {
    if (!open) return;
    window.dbStudio.connections.list().then((items) => {
      const sqlConns = items.filter((item) => item.engine !== "mongodb")
        .map((item) => ({ id: item.id, name: item.name, engine: item.engine as DatabaseEngine }));
      setConnections(sqlConns);
      setConnectionId((current) => current || activeId || sqlConns[0]?.id || "");
    }).catch(() => undefined);
  }, [open, activeId]);

  useEffect(() => {
    if (!connectionId) return;
    let cancelled = false;
    window.dbStudio.database.schemas(connectionId).then((items) => {
      if (cancelled) return;
      setSchemas(items); setSchema((current) => current || items[0] || "");
    }).catch(() => { if (!cancelled) setSchemas([]); });
    return () => { cancelled = true; };
  }, [connectionId]);

  useEffect(() => {
    if (!connectionId || !schema) return;
    let cancelled = false;
    window.dbStudio.database.tables(connectionId, schema).then((items) => {
      if (cancelled) return;
      setTables(items.filter((item) => item.type === "table").map((item) => item.name));
    }).catch(() => { if (!cancelled) setTables([]); });
    return () => { cancelled = true; };
  }, [connectionId, schema]);

  async function loadExisting(name: string) {
    if (!name) return;
    const loaded = await window.dbStudio.database.columns(connectionId, name, schema);
    setColumns(loaded.map((column) => ({
      name: column.name, dataType: column.dataType, nullable: column.nullable,
      defaultValue: column.defaultValue, primaryKey: column.primaryKey,
    })));
    setSql([]); setResult(undefined);
  }

  function updateColumn(index: number, patch: Partial<Column>) {
    setColumns((current) => current.map((column, i) => i === index ? { ...column, ...patch } : column));
  }

  async function preview() {
    if (!connectionId || !schema || !tableName.trim() || !columns.length) { message.warning("请填写表名并至少保留一列。"); return; }
    setBusy(true); setSql([]); setResult(undefined);
    try {
      const table = {
        name: tableName.trim(),
        columns: columns.filter((column) => column.name.trim()).map((column) => ({
          name: column.name.trim(), dataType: column.dataType.trim() || "TEXT",
          nullable: column.nullable, defaultValue: column.defaultValue, primaryKey: column.primaryKey,
        })),
        indexes: indexes.filter((index) => index.name.trim() && index.columns.trim()).map((index) => ({
          name: index.name.trim(), columns: index.columns.split(",").map((value) => value.trim()).filter(Boolean), unique: index.unique,
        })),
        foreignKeys: foreignKeys.filter((fk) => fk.name.trim() && fk.columns.trim() && fk.referencedTable.trim()).map((fk) => ({
          name: fk.name.trim(), columns: fk.columns.split(",").map((value) => value.trim()).filter(Boolean),
          referencedSchema: fk.referencedSchema.trim() || undefined,
          referencedTable: fk.referencedTable.trim(),
          referencedColumns: fk.referencedColumns.split(",").map((value) => value.trim()).filter(Boolean),
        })),
      };
      if (!table.columns.length) { message.warning("请至少填写一个有效字段名。"); return; }
      setSql(await window.dbStudio.designer.preview(connectionId, schema, mode, table));
    } catch (error) { message.error(error instanceof Error ? error.message : "生成 DDL 失败。"); }
    finally { setBusy(false); }
  }

  async function apply() {
    if (!sql.length) { message.warning("请先预览 DDL。"); return; }
    setBusy(true); setResult(undefined);
    try {
      const output = await window.dbStudio.designer.apply(connectionId, sql.map((statement) => ({ sql: statement })));
      setResult(`成功 ${output.applied} 条，失败 ${output.failed.length} 条`);
      if (output.failed.length) message.warning(`有 ${output.failed.length} 条失败`);
      else message.success("DDL 已应用");
    } catch (error) { message.error(error instanceof Error ? error.message : "应用失败。"); }
    finally { setBusy(false); }
  }

  return (
    <Drawer
      title="表设计器"
      width={900}
      open={open}
      onClose={onClose}
      maskClosable={true}
      keyboard={true}
      rootClassName="wb-app-drawer"
    >
      <div className="dbtools-sync-grid">
        <div className="dbtools-sync-col">
          <b>连接与 Schema</b>
          <Select value={connectionId || undefined} onChange={(value) => { setConnectionId(value); setSchema(""); }}
            options={connections.map((item) => ({ value: item.id, label: `${item.name} · ${item.engine}` }))} placeholder="连接" />
          <Select value={schema || undefined} onChange={setSchema}
            options={schemas.map((item) => ({ value: item, label: item }))} placeholder="Schema" />
        </div>
        <div className="dbtools-sync-col">
          <b>模式与表名</b>
          <Radio.Group value={mode} onChange={(event) => { setMode(event.target.value); setTableName(""); setSql([]); }} optionType="button" buttonStyle="solid">
            <Radio.Button value="create">新建表</Radio.Button>
            <Radio.Button value="alter">修改表</Radio.Button>
          </Radio.Group>
          {mode === "alter" ? (
            <Select value={tableName || undefined} onChange={(value) => { setTableName(value); void loadExisting(value); }}
              options={tables.map((item) => ({ value: item, label: item }))} placeholder="选择已有表" showSearch />
          ) : (
            <Input value={tableName} onChange={(event) => setTableName(event.target.value)} placeholder="新表名" />
          )}
        </div>
      </div>

      <div className="dbtools-section-title"><Columns3 size={14} /> 字段</div>
      <Table
        size="small" rowKey={(_, index) => String(index)} dataSource={columns} pagination={false}
        columns={[
          { title: "字段名", dataIndex: "name", width: 150, render: (value: string, _r, index: number) => <Input size="small" value={value} onChange={(e) => updateColumn(index, { name: e.target.value })} /> },
          { title: "类型", dataIndex: "dataType", width: 170, render: (value: string, _r, index: number) => <Input size="small" value={value} onChange={(e) => updateColumn(index, { dataType: e.target.value })} /> },
          { title: "默认值", dataIndex: "defaultValue", width: 130, render: (value: string | null, _r, index: number) => <Input size="small" value={value ?? ""} onChange={(e) => updateColumn(index, { defaultValue: e.target.value || null })} /> },
          { title: "可空", dataIndex: "nullable", width: 60, render: (value: boolean, _r, index: number) => <Checkbox checked={value} onChange={(e) => updateColumn(index, { nullable: e.target.checked })} /> },
          { title: "主键", dataIndex: "primaryKey", width: 60, render: (value: boolean, _r, index: number) => <Checkbox checked={value} onChange={(e) => updateColumn(index, { primaryKey: e.target.checked })} /> },
          { title: "", width: 40, render: (_v, _r, index: number) => <Button type="text" size="small" danger icon={<Trash2 size={13} />} onClick={() => setColumns((current) => current.filter((_, i) => i !== index))} /> },
        ]}
      />
      <Button size="small" icon={<Plus size={13} />} style={{ marginTop: 8 }}
        onClick={() => setColumns((current) => [...current, { name: "", dataType: "TEXT", nullable: true, defaultValue: null, primaryKey: false }])}>
        添加字段
      </Button>

      <div className="dbtools-section-title">索引</div>
      {indexes.map((index, i) => (
        <Space key={i} size={6} style={{ marginBottom: 6 }}>
          <Input size="small" placeholder="索引名" value={index.name} onChange={(e) => setIndexes((cur) => cur.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} style={{ width: 150 }} />
          <Input size="small" placeholder="字段（逗号分隔）" value={index.columns} onChange={(e) => setIndexes((cur) => cur.map((x, j) => j === i ? { ...x, columns: e.target.value } : x))} style={{ width: 200 }} />
          <Checkbox checked={index.unique} onChange={(e) => setIndexes((cur) => cur.map((x, j) => j === i ? { ...x, unique: e.target.checked } : x))}>UNIQUE</Checkbox>
          <Button type="text" size="small" danger icon={<Trash2 size={13} />} onClick={() => setIndexes((cur) => cur.filter((_, j) => j !== i))} />
        </Space>
      ))}
      <Button size="small" icon={<Plus size={13} />} onClick={() => setIndexes((cur) => [...cur, { name: "", columns: "", unique: false }])}>添加索引</Button>

      <div className="dbtools-section-title">外键</div>
      {foreignKeys.map((fk, i) => (
        <Space key={i} size={6} style={{ marginBottom: 6, flexWrap: "wrap" }}>
          <Input size="small" placeholder="约束名" value={fk.name} onChange={(e) => setForeignKeys((cur) => cur.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} style={{ width: 130 }} />
          <Input size="small" placeholder="本表字段" value={fk.columns} onChange={(e) => setForeignKeys((cur) => cur.map((x, j) => j === i ? { ...x, columns: e.target.value } : x))} style={{ width: 120 }} />
          <Input size="small" placeholder="目标 Schema" value={fk.referencedSchema} onChange={(e) => setForeignKeys((cur) => cur.map((x, j) => j === i ? { ...x, referencedSchema: e.target.value } : x))} style={{ width: 110 }} />
          <Input size="small" placeholder="目标表" value={fk.referencedTable} onChange={(e) => setForeignKeys((cur) => cur.map((x, j) => j === i ? { ...x, referencedTable: e.target.value } : x))} style={{ width: 120 }} />
          <Input size="small" placeholder="目标字段" value={fk.referencedColumns} onChange={(e) => setForeignKeys((cur) => cur.map((x, j) => j === i ? { ...x, referencedColumns: e.target.value } : x))} style={{ width: 120 }} />
          <Button type="text" size="small" danger icon={<Trash2 size={13} />} onClick={() => setForeignKeys((cur) => cur.filter((_, j) => j !== i))} />
        </Space>
      ))}
      <Button size="small" icon={<Plus size={13} />} onClick={() => setForeignKeys((cur) => [...cur, { name: "", columns: "", referencedSchema: "", referencedTable: "", referencedColumns: "" }])}>添加外键</Button>

      <div className="dbtools-actions">
        <Button icon={<RefreshCw size={14} />} loading={busy} onClick={() => void preview()}>预览 DDL</Button>
        <Button type="primary" className="mongo-primary" icon={<Play size={14} />} loading={busy} disabled={!sql.length} onClick={() => void apply()}>执行 DDL</Button>
      </div>
      {sql.length > 0 && <pre className="dbtools-sql">{sql.join("\n\n")}</pre>}
      {result && <Alert showIcon type="info" message={result} />}
      <Text type="secondary" className="dbtools-hint">修改模式只生成新增字段、新索引和新外键；改列类型/删列需要手工处理。</Text>
    </Drawer>
  );
}
