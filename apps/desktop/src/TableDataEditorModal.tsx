// Reconstructed from vendor chunk TableDataEditorModal-DFx3XkPz.js.
import { useEffect, useMemo, useState } from "react";
import { Alert, Button, Empty, Input, Modal, Space, Spin, Tag, Tooltip, Typography, message } from "antd";
import { RefreshCw } from "lucide-react";
import type { ColumnInfo, DatabaseEngine, TableInfo, TableRowChange } from "@db-studio/shared";
import LazyDataTable from "./LazyDataTable";
import {
  buildTablePreviewSql,
  buildTableRowChange,
  changedEditableColumns,
  isEditableColumn,
  isSupportedPrimaryKey,
} from "./table-data-edit";

const { Text } = Typography;

interface TableDataEditorModalProps {
  connectionId: string;
  engine: DatabaseEngine;
  table: TableInfo;
  onClose: () => void;
}

interface PendingChange {
  rowIndex: number;
  original: Record<string, unknown>;
  edited: Record<string, unknown>;
  changedColumns: ColumnInfo[];
}

interface RowChangeWithContext extends PendingChange {
  rowChange: TableRowChange;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function displayValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().replace(/Z$/, "");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function renderCell(value: unknown) {
  if (value === null || value === undefined) return <Tag>NULL</Tag>;
  if (typeof value === "boolean") return <Tag color={value ? "green" : "default"}>{String(value)}</Tag>;
  return <span className={typeof value === "number" ? "numeric-value" : ""}>{displayValue(value)}</span>;
}

export default function TableDataEditorModal({ connectionId, engine, table, onClose }: TableDataEditorModalProps) {
  const [draft, setDraft] = useState<Record<string, unknown>[]>([]);
  const [saving, setSaving] = useState(false);
  const [commitFailed, setCommitFailed] = useState(false);
  const [columns, setColumns] = useState<ColumnInfo[]>([]);
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState<unknown>();
  const [revision, setRevision] = useState(0);

  async function loadColumns(): Promise<boolean> {
    setFetching(true);
    try {
      const next = await window.dbStudio.database.columns(connectionId, table.name, table.schema);
      setColumns(next);
      setError(undefined);
      setRevision((value) => value + 1);
      return true;
    } catch (cause) {
      setError(cause);
      return false;
    } finally {
      setFetching(false);
      setLoading(false);
    }
  }

  async function loadRows(): Promise<boolean> {
    setFetching(true);
    try {
      const result = await window.dbStudio.database.query(connectionId, buildTablePreviewSql(engine, table.schema, table.name));
      setRows(result.rows as Record<string, unknown>[]);
      setError(undefined);
      setRevision((value) => value + 1);
      return true;
    } catch (cause) {
      setError(cause);
      return false;
    } finally {
      setFetching(false);
      setLoading(false);
    }
  }

  useEffect(() => {
    setLoading(true);
    void Promise.all([loadColumns(), loadRows()]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, engine, table.schema, table.name]);

  useEffect(() => {
    setDraft(rows.map((row) => ({ ...row })));
    setCommitFailed(false);
  }, [revision]); // eslint-disable-line react-hooks/exhaustive-deps

  const primaryKeys = columns.filter((column) => column.primaryKey);
  const editable = table.type === "table" && primaryKeys.length > 0 && primaryKeys.every(isSupportedPrimaryKey);
  const visibleRows = draft.length === rows.length ? draft : rows;

  const pending = useMemo(() => {
    if (draft.length !== rows.length || !columns.length) return [];
    return rows.flatMap((original, rowIndex) => {
      const edited = draft[rowIndex];
      const changedColumns = changedEditableColumns(columns, original, edited);
      return changedColumns.length ? [{ rowIndex, original, edited, changedColumns }] : [];
    });
  }, [columns, draft, rows]);

  const tableRows = visibleRows.map((row, rowIndex) => ({ ...row, key: rowIndex, rowIndex }));

  const gridColumns = columns.map((column) => ({
    title: (
      <span className="table-editor-column-title">
        {column.name}{column.primaryKey && <Tag color="gold">主键</Tag>}
      </span>
    ),
    dataIndex: column.name,
    key: column.name,
    width: 230,
    ellipsis: true,
    render: (_value: unknown, record: Record<string, unknown> & { rowIndex: number }) => {
      const rowIndex = record.rowIndex;
      const row = visibleRows[rowIndex] ?? record;
      const value = Object.hasOwn(row, column.name) ? row[column.name] : _value;
      if (!editable || !isEditableColumn(column)) return renderCell(value);
      return (
        <Input
          size="small"
          value={displayValue(value)}
          aria-label={`${table.schema}.${table.name} · 第 ${rowIndex + 1} 行 · ${column.name}`}
          onChange={(event) => {
            const next = event.target.value;
            setCommitFailed(false);
            setDraft((current) => current.map((item, index) => index === rowIndex ? { ...item, [column.name]: next } : item));
          }}
          addonAfter={column.nullable ? (
            <Button
              type="text"
              size="small"
              aria-label={`将 ${column.name} 设为 NULL`}
              onClick={() => {
                setCommitFailed(false);
                setDraft((current) => current.map((item, index) => index === rowIndex ? { ...item, [column.name]: null } : item));
              }}
            >NULL</Button>
          ) : undefined}
        />
      );
    },
  }));

  function collectChanges(): RowChangeWithContext[] {
    return pending.flatMap((item) => {
      const rowChange = buildTableRowChange(columns, item.original, item.edited);
      return rowChange ? [{ ...item, rowChange }] : [];
    });
  }

  async function save(changes: RowChangeWithContext[]) {
    setSaving(true);
    try {
      const result = await window.dbStudio.database.updateRows(connectionId, {
        schema: table.schema,
        table: table.name,
        changes: changes.map((item) => item.rowChange),
      });
      const affected = result.reduce((sum, item) => sum + item.rowCount, 0);
      if (await loadRows()) {
        setCommitFailed(false);
        message.success(`已在一个事务中保存 ${changes.length} 行；数据库报告影响 ${affected} 行。`);
      } else {
        setCommitFailed(true);
        message.warning(`事务已提交 ${changes.length} 行，但重新读取失败；请刷新核对当前值。`);
      }
    } catch (cause) {
      setCommitFailed(true);
      message.error(`批量更新失败；数据库已尝试回滚，未保存草稿仍保留。若连接在提交阶段中断，请先刷新核对数据再重试。${describeError(cause)}`);
    } finally {
      setSaving(false);
    }
  }

  function requestSave() {
    try {
      const changes = collectChanges();
      if (!changes.length) return;
      Modal.confirm({
        title: `保存 ${changes.length} 行修改？`,
        content: "主进程会重新核验表、主键和字段，并在一个事务中用参数化 SQL 保存；任一行失败则整批回滚。主键只用于定位，不会被编辑。",
        okText: "保存修改",
        cancelText: "继续编辑",
        onOk: () => { void save(changes); },
      });
    } catch (cause) {
      message.error(describeError(cause));
    }
  }

  function requestClose() {
    if (!pending.length) { onClose(); return; }
    Modal.confirm({
      title: "放弃未保存的修改？",
      content: "尚未保存的表格编辑会丢失。",
      okText: "放弃修改",
      okButtonProps: { danger: true },
      cancelText: "继续编辑",
      onOk: onClose,
    });
  }

  function requestRefresh() {
    const reload = async () => {
      const [columnsOk, rowsOk] = await Promise.all([loadColumns(), loadRows()]);
      if (columnsOk && rowsOk) setCommitFailed(false);
    };
    if (!pending.length) { void reload(); return; }
    Modal.confirm({
      title: "放弃草稿并重新读取？",
      content: "此操作会丢弃当前未保存的修改，并从数据库重新读取字段和数据。",
      okText: "重新读取",
      okButtonProps: { danger: true },
      cancelText: "继续编辑",
      onOk: () => { void reload(); },
    });
  }

  const isLoading = loading || fetching;
  const readError = error;

  return (
    <Modal
      title={<div className="modal-title"><div><b>表格数据</b><span>{`${table.schema}.${table.name} · ${engine}`}</span></div></div>}
      open
      onCancel={requestClose}
      width={1120}
      destroyOnHidden
      footer={
        <div className="table-editor-footer">
          <Text type="secondary">
            {pending.length ? `待保存 ${pending.length} 行` : `最多显示 ${rows.length} 行`}
            {editable ? " · 主键只用于定位行" : " · 当前表只读"}
            {commitFailed ? " · 上次提交失败，请刷新核对或修正草稿" : ""}
          </Text>
          <Space>
            <Button disabled={!pending.length || saving} onClick={() => { setDraft(rows.map((row) => ({ ...row }))); setCommitFailed(false); }}>还原修改</Button>
            <Button type="primary" disabled={!editable || !pending.length} loading={saving} onClick={requestSave}>保存修改</Button>
          </Space>
        </div>
      }
    >
      <div className="table-editor-toolbar">
        <Text type="secondary">读取前 100 行。修改仅在点击“保存修改”并确认后写入数据库。</Text>
        <Tooltip title={pending.length ? "重新读取会丢弃草稿" : "重新读取字段和数据"}>
          <Button
            size="small"
            icon={<RefreshCw size={13} />}
            loading={fetching}
            disabled={saving || !!(pending.length && !commitFailed)}
            onClick={requestRefresh}
          >刷新</Button>
        </Tooltip>
      </div>
      {table.type === "view"
        ? <Alert showIcon type="info" message="视图以只读方式打开。" />
        : columns.length > 0 && primaryKeys.length === 0
          ? <Alert showIcon type="warning" message="未发现主键，无法安全定位要修改的行；当前以只读方式打开。" />
          : null}
      {readError
        ? <Alert showIcon type="error" message="读取表格数据失败" description={describeError(readError)} />
        : isLoading
          ? <div className="object-search-state"><Spin /><Text type="secondary">正在读取字段和数据…</Text></div>
          : rows.length === 0
            ? <Empty description="表中没有可显示的数据" />
            : <LazyDataTable
                size="small"
                rowKey="key"
                className="table-data-editor-grid"
                columns={gridColumns}
                dataSource={tableRows}
                scroll={{ x: "max-content", y: "min(54vh, 520px)" }}
                pagination={{ pageSize: 25, showSizeChanger: false, showTotal: (total: number, range: number[]) => `${range[0]}~${range[1]} / ${total}` }}
              />}
    </Modal>
  );
}
