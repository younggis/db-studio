// Logical backup / restore workspace. Uses the shared database IPC so the
// dump is engine-specific SQL and restore replays it through the same adapter.
import { useEffect, useState } from "react";
import { Alert, Button, Checkbox, Drawer, Select, Tabs, Typography, message } from "antd";
import { Download, FileUp, Play } from "lucide-react";

const { Text } = Typography;

interface BackupPanelProps {
  open: boolean;
  onClose: () => void;
  connectionId?: string;
  connectionName?: string;
}

export default function BackupPanel({ open, onClose, connectionId, connectionName }: BackupPanelProps) {
  const [schemas, setSchemas] = useState<string[]>([]);
  const [schema, setSchema] = useState("");
  const [includeData, setIncludeData] = useState(true);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string>();
  const [restoreFile, setRestoreFile] = useState<{ path: string; content: string }>();
  const [restoreResult, setRestoreResult] = useState<{ applied: number; failed: Array<{ sql: string; error: string }> }>();

  useEffect(() => {
    if (!open || !connectionId) return;
    let cancelled = false;
    window.dbStudio.database.schemas(connectionId)
      .then((items) => { if (!cancelled) { setSchemas(items); setSchema((current) => current || items[0] || ""); } })
      .catch(() => { if (!cancelled) setSchemas([]); });
    return () => { cancelled = true; };
  }, [open, connectionId]);

  async function createBackup() {
    if (!connectionId || !schema) { message.warning("请选择连接和 Schema。"); return; }
    setBusy(true); setResult(undefined);
    try {
      const output = await window.dbStudio.backup.create(connectionId, schema, { includeData });
      if (output) setResult(`已备份 ${output.tableCount} 张表、${output.rowCount} 行 → ${output.path}`);
      else setResult("已取消保存。");
    } catch (error) { message.error(error instanceof Error ? error.message : "备份失败。"); }
    finally { setBusy(false); }
  }

  async function pickRestoreFile() {
    const file = await window.dbStudio.files.openSql();
    if (!file) return;
    setRestoreFile(file);
    setRestoreResult(undefined);
  }

  async function runRestore() {
    if (!connectionId || !restoreFile) { message.warning("请选择备份文件。"); return; }
    setBusy(true); setRestoreResult(undefined);
    try {
      const output = await window.dbStudio.backup.restore(connectionId, restoreFile.content);
      setRestoreResult(output);
      if (output.failed.length === 0) message.success(`恢复完成，已执行 ${output.applied} 条语句`);
      else message.warning(`执行 ${output.applied} 条，失败 ${output.failed.length} 条`);
    } catch (error) { message.error(error instanceof Error ? error.message : "恢复失败。"); }
    finally { setBusy(false); }
  }

  return (
    <Drawer
      title="备份 / 恢复"
      width={640}
      open={open}
      onClose={onClose}
      maskClosable={true}
      keyboard={true}
      rootClassName="wb-app-drawer"
    >
      <div className="dbtools-form">
        <div className="dbtools-row">
          <span className="dbtools-label">连接</span>
          <Text strong>{connectionName ?? "请选择连接"}</Text>
        </div>
        <div className="dbtools-row">
          <span className="dbtools-label">Schema</span>
          <Select value={schema || undefined} onChange={setSchema} style={{ width: 240 }}
            options={schemas.map((item) => ({ value: item, label: item }))} placeholder="选择 Schema" />
        </div>
      </div>
      <Tabs items={[
        {
          key: "backup",
          label: "创建备份",
          children: <>
            <Checkbox checked={includeData} onChange={(event) => setIncludeData(event.target.checked)}>包含表数据（生成 INSERT 语句）</Checkbox>
            <div className="dbtools-actions">
              <Button type="primary" className="mongo-primary" icon={<Download size={14} />} loading={busy} disabled={!schema} onClick={() => void createBackup()}>选择路径并备份</Button>
            </div>
            {result && <Alert showIcon type="success" message={result} />}
            <p className="dbtools-hint">生成的 SQL 备份包含原字段类型、主键、外键与数据，可在同引擎的空 Schema 中恢复。</p>
          </>,
        },
        {
          key: "restore",
          label: "从备份恢复",
          children: <>
            <div className="dbtools-actions">
              <Button icon={<FileUp size={14} />} onClick={() => void pickRestoreFile()}>选择 SQL 备份文件</Button>
            </div>
            {restoreFile && <Text type="secondary">{restoreFile.path} · {Math.round(restoreFile.content.length / 1024)} KB</Text>}
            <div className="dbtools-actions">
              <Button type="primary" className="mongo-primary" icon={<Play size={14} />} loading={busy} disabled={!restoreFile || !connectionId} onClick={() => void runRestore()}>恢复到当前连接</Button>
            </div>
            {restoreResult && <Alert showIcon type={restoreResult.failed.length ? "warning" : "success"}
              message={`成功 ${restoreResult.applied} 条，失败 ${restoreResult.failed.length} 条`}
              description={restoreResult.failed.length
                ? <div className="dbtools-error-list">{restoreResult.failed.slice(0, 5).map((item, index) => <div key={index}>{item.error} · {item.sql}</div>)}</div>
                : undefined} />}
            <p className="dbtools-hint">恢复会按备份文件中的语句顺序执行；建议先在空 Schema 中验证。</p>
          </>,
        },
      ]} />
    </Drawer>
  );
}
