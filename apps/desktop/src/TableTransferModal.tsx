// Reconstructed from vendor chunk TableTransferModal-Dh5FnMvf.js.
// npm antd is used; data loading is local (the vendor react-query instance is
// a different module and cannot share the app's QueryClientProvider).
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Modal, Select, Space, Spin, Typography, message } from "antd";
import type { ColumnInfo, TableInfo } from "@db-studio/shared";

const { Text } = Typography;

interface TargetConnection {
  id: string;
  name: string;
  engine: string;
  database?: string;
  user?: string;
}

interface TransferResult {
  insertedRows: number;
  columns: unknown[];
}

interface TableTransferModalProps {
  open: boolean;
  sourceConnectionId: string;
  sourceConnectionName: string;
  sourceTable: TableInfo;
  connections: TargetConnection[];
  onClose: () => void;
  onTransfer: (target: {
    connectionId: string;
    schema: string;
    table: string;
    columnMappings: Array<{ sourceColumn: string; targetColumn: string }>;
  }) => Promise<TransferResult>;
}

interface ResourceState<T> {
  data?: T;
  loading: boolean;
  error?: unknown;
}

function useResource<T>(load: () => Promise<T>, enabled: boolean, deps: unknown[]) {
  const [state, setState] = useState<ResourceState<T>>({ loading: false });
  useEffect(() => {
    if (!enabled) { setState({ loading: false }); return; }
    let cancelled = false;
    setState({ loading: true });
    load().then((data) => {
      if (!cancelled) setState({ data, loading: false });
    }).catch((error: unknown) => {
      if (!cancelled) setState({ error, loading: false });
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return {
    data: state.data,
    error: state.error,
    isLoading: state.loading,
    isError: state.error !== undefined,
    isSuccess: state.data !== undefined && state.error === undefined,
  };
}

function defaultSchema(connection: TargetConnection | undefined, schemas: string[]): string | undefined {
  if (!connection || !schemas.length) return undefined;
  const preferred = connection.engine === "sqlite" ? "main"
    : connection.engine === "mysql" || connection.engine === "mariadb" ? connection.database
    : connection.engine === "sqlserver" ? "dbo"
    : connection.engine === "oracle" ? connection.user?.toUpperCase()
    : "public";
  return preferred && schemas.includes(preferred) ? preferred : schemas[0];
}

export default function TableTransferModal({
  open,
  sourceConnectionId,
  sourceConnectionName,
  sourceTable,
  connections,
  onClose,
  onTransfer,
}: TableTransferModalProps) {
  const targets = useMemo(() => connections.filter((item) => item.id !== sourceConnectionId && item.engine !== "mongodb"), [connections, sourceConnectionId]);
  const targetKey = targets.map((item) => item.id).join("\0");
  const [targetId, setTargetId] = useState<string>();
  const [schema, setSchema] = useState<string>();
  const [tableValue, setTableValue] = useState("");
  const [mappings, setMappings] = useState<Record<string, string>>({});
  const autoMapKey = useRef("");
  const [busy, setBusy] = useState(false);
  const target = targets.find((item) => item.id === targetId);

  const schemasQuery = useResource(
    () => window.dbStudio.database.schemas(targetId!),
    !!(open && targetId),
    [open, targetId],
  );
  const schemas = schemasQuery.data ?? [];
  const effectiveSchema = schema && schemas.includes(schema) ? schema : defaultSchema(target, schemas);

  const tablesQuery = useResource(
    () => window.dbStudio.database.tables(targetId!, effectiveSchema!),
    !!(open && targetId && effectiveSchema),
    [open, targetId, effectiveSchema],
  );
  const tableOptions = (tablesQuery.data ?? [])
    .filter((item) => item.type === "table")
    .map((item) => ({ value: `${item.schema}\0${item.name}`, label: item.name }));

  const [targetSchemaName, targetTableName] = tableValue.split("\0");

  const sourceColumnsQuery = useResource(
    () => window.dbStudio.database.columns(sourceConnectionId, sourceTable.name, sourceTable.schema),
    !!open,
    [open, sourceConnectionId, sourceTable.schema, sourceTable.name],
  );
  const targetColumnsQuery = useResource(
    () => window.dbStudio.database.columns(targetId!, targetTableName, targetSchemaName),
    !!(open && targetId && targetSchemaName && targetTableName),
    [open, targetId, targetSchemaName, targetTableName],
  );
  const sourceColumns: ColumnInfo[] = sourceColumnsQuery.data ?? [];
  const targetColumns: ColumnInfo[] = targetColumnsQuery.data ?? [];
  const targetColumnOptions = targetColumns.map((column) => ({ value: column.name, label: `${column.name} · ${column.dataType}` }));

  useEffect(() => {
    if (!open) return;
    setTargetId((current) => targets.some((item) => item.id === current) ? current : targets[0]?.id);
    setSchema(undefined);
    setTableValue("");
  }, [open, sourceConnectionId, targetKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { setTableValue(""); }, [targetId, effectiveSchema]);
  useEffect(() => { setMappings({}); autoMapKey.current = ""; }, [targetId, effectiveSchema, tableValue]);

  useEffect(() => {
    if (!tableValue || !sourceColumnsQuery.isSuccess || !targetColumnsQuery.isSuccess) return;
    const key = `${targetId}\0${tableValue}`;
    if (autoMapKey.current === key) return;
    autoMapKey.current = key;
    const byLowercase = new Map<string, ColumnInfo[]>();
    for (const column of targetColumns) {
      const lowered = column.name.toLocaleLowerCase("en-US");
      byLowercase.set(lowered, [...(byLowercase.get(lowered) ?? []), column]);
    }
    const next: Record<string, string> = {};
    for (const column of sourceColumns) {
      const exact = targetColumns.find((item) => item.name === column.name);
      const candidates = byLowercase.get(column.name.toLocaleLowerCase("en-US")) ?? [];
      if (exact) next[column.name] = exact.name;
      else if (candidates.length === 1) next[column.name] = candidates[0].name;
    }
    setMappings(next);
  }, [targetId, tableValue, sourceColumns, sourceColumnsQuery.isSuccess, targetColumns, targetColumnsQuery.isSuccess]);

  async function handleTransfer() {
    if (!targetId || !effectiveSchema || !tableValue) return;
    const [schemaName, tableName] = tableValue.split("\0");
    if (!schemaName || !tableName) return;
    setBusy(true);
    try {
      const columnMappings = Object.entries(mappings)
        .filter((entry) => !!entry[1])
        .map(([sourceColumn, targetColumn]) => ({ sourceColumn, targetColumn }));
      const result = await onTransfer({ connectionId: targetId, schema: schemaName, table: tableName, columnMappings });
      message.success(`已传输 ${result.insertedRows} 行到 ${tableName}（${result.columns.length} 列）`);
      onClose();
    } catch (error) {
      message.error(error instanceof Error ? error.message : "跨库传输失败。");
    } finally {
      setBusy(false);
    }
  }

  const canSubmit = !!targetId && !!effectiveSchema && !!tableValue && !busy
    && sourceColumnsQuery.isSuccess && targetColumnsQuery.isSuccess
    && Object.values(mappings).some(Boolean);

  return (
    <Modal rootClassName="wb-surface"
      open={open}
      title="传输表数据"
      okText="追加数据"
      cancelText="取消"
      confirmLoading={busy}
      okButtonProps={{ disabled: !canSubmit }}
      onCancel={onClose}
      onOk={() => { void handleTransfer(); }}
      destroyOnHidden
    >
      <Space direction="vertical" size={16} className="table-transfer-form" style={{ width: "100%" }}>
        <Text type="secondary">{`来源：${sourceConnectionName} · ${sourceTable.schema}.${sourceTable.name}`}</Text>
        {targets.length === 0
          ? <Alert showIcon type="info" message="没有可用的目标连接" description="请先保存另一个关系型数据库连接。" />
          : <Fragment>
              <label className="field-label" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                目标连接
                <Select
                  style={{ width: "100%" }}
                  value={targetId}
                  placeholder="选择目标连接"
                  options={targets.map((item) => ({ value: item.id, label: `${item.name} · ${item.engine}` }))}
                  onChange={(value) => { setTargetId(value); setSchema(undefined); setTableValue(""); }}
                />
              </label>
              <label className="field-label" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                目标 Schema
                <Select
                  style={{ width: "100%" }}
                  value={effectiveSchema}
                  placeholder="选择目标 Schema"
                  loading={schemasQuery.isLoading}
                  disabled={!targetId || schemasQuery.isError || schemas.length === 0}
                  options={schemas.map((item) => ({ value: item, label: item }))}
                  onChange={(value) => { setSchema(value); setTableValue(""); }}
                  notFoundContent={schemasQuery.isError ? "读取 Schema 失败" : "没有可用 Schema"}
                />
              </label>
              <label className="field-label" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                已有目标表
                <Select
                  style={{ width: "100%" }}
                  value={tableValue || undefined}
                  placeholder="选择要追加数据的表"
                  loading={tablesQuery.isLoading}
                  disabled={!effectiveSchema || tablesQuery.isError}
                  options={tableOptions}
                  showSearch
                  optionFilterProp="label"
                  onChange={setTableValue}
                  notFoundContent={tablesQuery.isLoading ? <Spin size="small" /> : tablesQuery.isError ? "读取表清单失败" : "没有可传输的目标表"}
                />
              </label>
              {!!tableValue && <Fragment>
                <Text strong>字段映射</Text>
                {sourceColumnsQuery.isError || targetColumnsQuery.isError
                  ? <Alert showIcon type="error" message="读取源表或目标表字段失败，无法配置映射。" />
                  : sourceColumnsQuery.isLoading || targetColumnsQuery.isLoading
                    ? <Spin size="small" />
                    : <Space direction="vertical" size={8} style={{ width: "100%" }}>
                        {sourceColumns.map((column) => (
                          <div
                            className="field-label"
                            key={column.name}
                            style={{ display: "grid", gridTemplateColumns: "minmax(120px, 1fr) minmax(180px, 1.4fr)", gap: 8, alignItems: "center" }}
                          >
                            <Text ellipsis title={`${column.name} · ${column.dataType}`}>{`${column.name} · ${column.dataType}`}</Text>
                            <Select
                              allowClear
                              showSearch
                              optionFilterProp="label"
                              value={mappings[column.name]}
                              placeholder="跳过此源字段"
                              options={targetColumnOptions}
                              onChange={(value) => {
                                if (value && Object.entries(mappings).some(([name, mapped]) => name !== column.name && mapped === value)) {
                                  message.warning("一个目标字段只能映射一个源字段。");
                                  return;
                                }
                                setMappings((current) => ({ ...current, [column.name]: value }));
                              }}
                            />
                          </div>
                        ))}
                      </Space>}
                <Alert
                  showIcon
                  type="info"
                  message="可跳过不需要的源字段；目标表未映射的必填字段仍需有默认值。"
                  description="当前跨库传输按数据库驱动绑定值，不会自动转换不兼容的数据类型。"
                />
              </Fragment>}
              {schemasQuery.isError && <Alert showIcon type="error" message="读取目标 Schema 失败" />}
              {tablesQuery.isError && <Alert showIcon type="error" message="读取目标表清单失败" />}
              <Alert showIcon type="warning" message="只追加，不会清空目标表。" description="源表需有主键。映射后字段数据按页提交；后续页面失败时，之前提交的页面会保留。" />
            </Fragment>}
      </Space>
    </Modal>
  );
}
