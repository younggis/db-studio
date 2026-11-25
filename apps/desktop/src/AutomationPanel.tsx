// Automation jobs: schedule backups or SQL statements, run them now, and review status.
import { useEffect, useState } from "react";
import { Alert, Button, Checkbox, Drawer, Input, InputNumber, Select, Space, Table, Tag, Typography, message } from "antd";
import { AlarmClock, Play, Plus, RefreshCw, Trash2 } from "lucide-react";
import type { DatabaseEngine } from "@db-studio/shared";

const { Text } = Typography;

type Job = {
  id: string;
  name: string;
  type: "backup" | "query";
  connectionId: string;
  schema?: string;
  sql?: string;
  outputPath?: string;
  includeData?: boolean;
  intervalMinutes: number;
  enabled: boolean;
  createdAt: string;
  lastRunAt?: string;
  lastStatus?: "success" | "failed";
  lastError?: string;
};

export default function AutomationPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [connections, setConnections] = useState<Array<{ id: string; name: string; engine: DatabaseEngine }>>([]);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Partial<Job>>({});
  const [busy, setBusy] = useState(false);

  async function refresh() {
    try { setJobs(await window.dbStudio.automation.list()); }
    catch (error) { message.error(error instanceof Error ? error.message : "读取任务失败。"); }
  }

  useEffect(() => {
    if (!open) return;
    void refresh();
    window.dbStudio.connections.list().then((items) => {
      setConnections(items.map((item) => ({ id: item.id, name: item.name, engine: item.engine as DatabaseEngine })));
    }).catch(() => undefined);
  }, [open]);

  async function save() {
    setBusy(true);
    try {
      setJobs(await window.dbStudio.automation.save(draft));
      setEditing(false); setDraft({});
      message.success("任务已保存");
    } catch (error) { message.error(error instanceof Error ? error.message : "保存失败。"); }
    finally { setBusy(false); }
  }

  async function remove(id: string) {
    setJobs(await window.dbStudio.automation.remove(id));
  }

  async function runNow(id: string) {
    setBusy(true);
    try {
      const job = await window.dbStudio.automation.run(id);
      message[job.lastStatus === "success" ? "success" : "warning"](
        job.lastStatus === "success" ? "任务执行成功" : `任务失败：${job.lastError ?? "未知错误"}`,
      );
      await refresh();
    } catch (error) { message.error(error instanceof Error ? error.message : "执行失败。"); }
    finally { setBusy(false); }
  }

  function startEdit(job?: Job) {
    setDraft(job ? { ...job } : {
      name: "", type: "backup", connectionId: connections[0]?.id ?? "",
      schema: "public", includeData: true, intervalMinutes: 60, enabled: true,
    });
    setEditing(true);
  }

  return (
    <Drawer title="自动化调度" width={840} open={open} onClose={onClose}>
      <Space style={{ marginBottom: 12 }}>
        <Button icon={<Plus size={14} />} onClick={() => startEdit()}>新建任务</Button>
        <Button icon={<RefreshCw size={14} />} onClick={() => void refresh()}>刷新</Button>
        <Text type="secondary">应用运行时每 30 秒检查一次到期任务。</Text>
      </Space>
      <Table<Job>
        rowKey="id" size="small" dataSource={jobs} pagination={false} loading={busy}
        columns={[
          { title: "名称", dataIndex: "name", width: 140, ellipsis: true },
          { title: "类型", dataIndex: "type", width: 80, render: (value: string) => <Tag color={value === "backup" ? "blue" : "green"}>{value === "backup" ? "备份" : "查询"}</Tag> },
          { title: "间隔", dataIndex: "intervalMinutes", width: 90, render: (value: number) => value > 0 ? `${value} 分钟` : "手动" },
          { title: "状态", dataIndex: "enabled", width: 70, render: (value: boolean) => <Tag color={value ? "success" : "default"}>{value ? "启用" : "停用"}</Tag> },
          { title: "上次执行", dataIndex: "lastRunAt", render: (value?: string, record?: Job) => value ? <span>{new Date(value).toLocaleString()} <Tag color={record?.lastStatus === "success" ? "green" : "red"}>{record?.lastStatus}</Tag></span> : "—" },
          { title: "操作", width: 150, render: (_v, record) => <Space size={2}>
            <Button type="link" size="small" icon={<Play size={13} />} loading={busy} onClick={() => void runNow(record.id)}>执行</Button>
            <Button type="link" size="small" onClick={() => startEdit(record)}>编辑</Button>
            <Button type="link" size="small" danger icon={<Trash2 size={13} />} onClick={() => void remove(record.id)} />
          </Space> },
        ]}
      />

      {editing && (
        <div className="dbtools-automation-form">
          <div className="dbtools-section-title"><AlarmClock size={14} /> {draft.id ? "编辑任务" : "新建任务"}</div>
          <div className="dbtools-row"><span className="dbtools-label">名称</span><Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="任务名称" style={{ width: 260 }} /></div>
          <div className="dbtools-row"><span className="dbtools-label">类型</span><Select value={draft.type} onChange={(value) => setDraft({ ...draft, type: value })}
            options={[{ value: "backup", label: "备份" }, { value: "query", label: "SQL 查询" }]} style={{ width: 160 }} /></div>
          <div className="dbtools-row"><span className="dbtools-label">连接</span><Select value={draft.connectionId || undefined} onChange={(value) => setDraft({ ...draft, connectionId: value })}
            options={connections.map((item) => ({ value: item.id, label: item.name }))} style={{ width: 260 }} /></div>
          {draft.type === "backup" ? (
            <>
              <div className="dbtools-row"><span className="dbtools-label">Schema</span><Input value={draft.schema} onChange={(e) => setDraft({ ...draft, schema: e.target.value })} style={{ width: 200 }} /></div>
              <div className="dbtools-row"><span className="dbtools-label">输出路径</span><Input value={draft.outputPath} onChange={(e) => setDraft({ ...draft, outputPath: e.target.value })} placeholder="留空自动写入 userData/backups" style={{ width: 320 }} /></div>
              <div className="dbtools-row"><span className="dbtools-label">包含数据</span><Checkbox checked={draft.includeData !== false} onChange={(e) => setDraft({ ...draft, includeData: e.target.checked })} /></div>
            </>
          ) : (
            <div className="dbtools-row"><span className="dbtools-label">SQL</span><Input.TextArea rows={3} value={draft.sql} onChange={(e) => setDraft({ ...draft, sql: e.target.value })} placeholder="SELECT 1" style={{ width: 420 }} /></div>
          )}
          <div className="dbtools-row"><span className="dbtools-label">间隔</span><InputNumber min={0} max={43200} value={draft.intervalMinutes} onChange={(value) => setDraft({ ...draft, intervalMinutes: value ?? 0 })} addonAfter="分钟" /></div>
          <div className="dbtools-row"><span className="dbtools-label">启用</span><Checkbox checked={draft.enabled !== false} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} /></div>
          <div className="dbtools-actions">
            <Button type="primary" className="mongo-primary" icon={<Plus size={14} />} loading={busy} onClick={() => void save()}>保存</Button>
            <Button onClick={() => { setEditing(false); setDraft({}); }}>取消</Button>
          </div>
          {draft.lastError && <Alert showIcon type="error" message="上次执行错误" description={draft.lastError} />}
        </div>
      )}
    </Drawer>
  );
}
