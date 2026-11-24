// Reconstructed from the embedded Re() component in MongoDocumentsPage-D9MAV3zD.js.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Alert, Button, Checkbox, Drawer, Input, Select, Tag, Typography, message } from "antd";
import { Braces, Copy, Send, X } from "lucide-react";
import type { MongoAssistantResult, MongoQueryMode, PublicAiModelSettings } from "@db-studio/ai";

const TASK_LABELS: Record<string, string> = {
  generate: "生成查询",
  repair: "解释并修复",
  explain: "解释当前查询",
};

class RequestGuard {
  private requestId: string | null = null;
  private scope = "";
  start(id: string, scope: string) { this.requestId = id; this.scope = scope; }
  cancel() { this.requestId = null; }
  finish(id: string) {
    if (this.requestId !== id) return false;
    this.requestId = null;
    return true;
  }
  isCurrent(id: string, scope: string) { return this.requestId === id && this.scope === scope; }
  isActive(id: string) { return this.requestId === id; }
  updateScope(scope: string) {
    const changed = this.scope !== scope;
    this.scope = scope;
    if (changed) this.requestId = null;
    return changed;
  }
}

export interface MongoQueryDraft {
  mode: MongoQueryMode;
  filter: string;
  projection: string;
  sort: string;
  pipeline: string;
}

interface MongoAiPanelProps {
  open: boolean;
  onClose: () => void;
  onApply: (result: { mode: MongoQueryMode; filter: string; projection: string; sort: string; pipeline: string }) => void;
  connectionId: string;
  database: string;
  collection: string;
  mode: MongoQueryMode;
  query: MongoQueryDraft;
  error?: string;
}

export default function MongoAiPanel({ open, onClose, onApply, connectionId, database, collection, mode, query, error }: MongoAiPanelProps) {
  const [settings, setSettings] = useState<PublicAiModelSettings>();
  const [modelId, setModelId] = useState<string>();
  const [task, setTask] = useState("generate");
  const [request, setRequest] = useState("");
  const [schemaHint, setSchemaHint] = useState("");
  const [includeContext, setIncludeContext] = useState(false);
  const [pending, setPending] = useState(false);
  const [streamedChars, setStreamedChars] = useState(0);
  const [result, setResult] = useState<MongoAssistantResult>();
  const scope = `${connectionId}\0${database}\0${collection}\0${mode}`;
  const guardRef = useRef<RequestGuard | null>(null);
  if (!guardRef.current) guardRef.current = new RequestGuard();
  const guard = guardRef.current;

  function cancel(clearPending = true) {
    guard.cancel();
    if (clearPending) setPending(false);
  }

  useLayoutEffect(() => {
    if (guard.updateScope(scope)) {
      setResult(undefined);
      setPending(false);
    }
  }, [guard, scope]);

  useLayoutEffect(() => {
    if (!open) cancel();
    return () => guard.cancel();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, guard]);

  useEffect(() => {
    if (!open) return;
    setIncludeContext(false);
    setResult(undefined);
    setTask("generate");
    setRequest("");
    setSchemaHint("");
    setPending(false);
    window.dbStudio.ai.settings().then((next) => {
      setSettings(next);
      setModelId(next.defaultChatModelId ?? next.chatModels.find((item) => item.enabled)?.id);
    }).catch((cause: unknown) => {
      message.error(cause instanceof Error ? cause.message : "读取 AI 设置失败。");
    });
  }, [open]);

  useEffect(() => window.dbStudio.ai.onDelta(({ requestId, delta }) => {
    if (guard.isActive(requestId)) setStreamedChars((value) => value + delta.length);
  }), [guard]);

  const model = settings?.chatModels.find((item) => item.id === modelId && item.enabled);
  const hasQuery = !!(query.filter.trim() || query.projection.trim() || query.sort.trim() || query.pipeline.trim());
  const canRun = !!(settings?.enabled && model && !pending && database && collection && includeContext
    && (task === "generate" ? request.trim() : hasQuery) && (task !== "repair" || error?.trim()));

  async function run(nextTask = task) {
    if (!database || !collection) { message.warning("请先选择 MongoDB 数据库和 Collection。"); return; }
    if (!model) { message.warning("请先在 AI 设置中启用一个 Chat 模型。"); return; }
    if (!includeContext) { message.warning("请先确认本次发送到模型的 MongoDB 查询上下文。"); return; }
    if (nextTask === "generate" && !request.trim()) { message.warning("请输入查询需求。"); return; }
    if (nextTask === "repair" && !error?.trim()) { message.warning("请先运行查询，并提供 MongoDB 错误信息。"); return; }
    if (nextTask !== "generate" && !hasQuery) { message.warning("请先编写或生成一个 MongoDB 查询。"); return; }
    const id = crypto.randomUUID();
    guard.start(id, scope);
    setPending(true);
    setStreamedChars(0);
    setResult(undefined);
    try {
      const response = await window.dbStudio.ai.runMongo({
        requestId: id,
        connectionId,
        database,
        collection,
        modelId: model.id,
        task: nextTask as "generate" | "repair" | "explain",
        mode,
        request: request.trim(),
        includeContext,
        schemaHint: schemaHint.trim() || undefined,
        query: nextTask === "generate" ? undefined : query,
        error: nextTask === "repair" ? { message: error ?? "" } : undefined,
      });
      if (!guard.isCurrent(id, scope)) return;
      setResult(response);
    } catch (cause) {
      if (!guard.isCurrent(id, scope)) return;
      message.error(cause instanceof Error ? cause.message : "MongoDB AI 请求失败。");
    } finally {
      if (guard.finish(id)) setPending(false);
    }
  }

  function applyResult(next: MongoAssistantResult) {
    return {
      mode: next.mode,
      filter: next.filter ? JSON.stringify(next.filter, null, 2) : "",
      projection: next.projection ? JSON.stringify(next.projection, null, 2) : "",
      sort: next.sort ? JSON.stringify(next.sort, null, 2) : "",
      pipeline: next.pipeline ? JSON.stringify(next.pipeline, null, 2) : "",
    };
  }

  function draftText(next: MongoAssistantResult): string {
    return JSON.stringify(next.mode === "find"
      ? { filter: next.filter ?? {}, ...(next.projection ? { projection: next.projection } : {}), ...(next.sort ? { sort: next.sort } : {}) }
      : { pipeline: next.pipeline ?? [] }, null, 2);
  }

  async function copyDraft() {
    if (!result || result.task === "explain") return;
    try {
      await navigator.clipboard.writeText(draftText(result));
      message.success("查询草稿已复制。");
    } catch {
      message.error("复制失败，请手动选择结果内容。");
    }
  }

  return (
    <Drawer
      title={
        <div className="mongo-ai-title">
          <span><Braces size={15} /> AI MongoDB 查询助手</span>
          <Tag bordered={false} color="cyan">JSON 草稿</Tag>
        </div>
      }
      open={open}
      onClose={onClose}
      styles={{ wrapper: { width: 570 } }}
      destroyOnClose={false}
      className="mongo-ai-drawer"
      extra={pending ? <Button size="small" icon={<X size={13} />} onClick={() => cancel()}>取消请求</Button> : null}
    >
      <div className="mongo-ai-body">
        <div className="mongo-ai-scope">
          <span>目标</span><b>{database || "未选择数据库"}</b><i>/</i><b>{collection || "未选择 Collection"}</b>
          <small>{mode === "find" ? "Find" : "Aggregate"}</small>
        </div>
        <div className="mongo-ai-form-grid">
          <label>操作
            <Select value={task} onChange={setTask} options={Object.entries(TASK_LABELS).map(([value, label]) => ({ value, label }))} />
          </label>
          <label>Chat 模型
            <Select
              value={modelId}
              onChange={setModelId}
              loading={!settings}
              placeholder="选择已启用模型"
              options={(settings?.chatModels ?? []).filter((item) => item.enabled).map((item) => ({ value: item.id, label: `${item.name} · ${item.model}` }))}
            />
          </label>
          {task !== "explain" && <label className="wide">查询需求
            <Input.TextArea
              value={request}
              onChange={(event) => setRequest(event.target.value)}
              autoSize={{ minRows: 3, maxRows: 6 }}
              maxLength={6000}
              showCount
              disabled={pending}
              placeholder={task === "repair" ? "可补充希望保留的查询行为" : "例如：筛选过去 30 天内的有效订单，按金额倒序返回前 20 条"}
            />
          </label>}
          <label className="wide">可选字段提示
            <Input.TextArea
              value={schemaHint}
              onChange={(event) => setSchemaHint(event.target.value)}
              autoSize={{ minRows: 2, maxRows: 5 }}
              maxLength={8000}
              showCount
              disabled={pending}
              placeholder="仅填写字段名与类型等结构提示；不会读取文档样本。"
            />
          </label>
        </div>
        <Alert
          showIcon
          type="info"
          className="mongo-ai-privacy"
          message="本次请求的数据范围"
          description="勾选后会把需求、数据库与 Collection 名称、可选字段提示，以及解释/修复所需的当前查询和错误信息发送给所选模型。不读取文档内容、连接串或数据库凭据。生成结果只显示在此处，不会执行。"
        />
        <Checkbox checked={includeContext} onChange={(event) => setIncludeContext(event.target.checked)} disabled={pending}>
          允许将上述 MongoDB 查询上下文发送至所选模型
        </Checkbox>
        {settings && !settings.enabled && <Alert showIcon type="warning" message="AI 助手尚未启用，请先完成 AI 模型设置。" />}
        <div className="mongo-ai-run-row">
          <Button type="primary" icon={<Send size={14} />} loading={pending} disabled={!canRun} onClick={() => void run()}>
            {pending ? "正在请求模型" : TASK_LABELS[task]}
          </Button>
          {task === "repair" && error && <Tag className="mongo-ai-error-ref">已附加最近一次 MongoDB 查询错误</Tag>}
        </div>
        {pending && <div className="mongo-ai-stream"><span className="mongo-ai-pulse" />正在接收结构化结果 · {streamedChars.toLocaleString()} 字符</div>}
        {error && <div className="mongo-ai-error-preview"><b>最近一次错误</b><span>{error}</span></div>}
        {result && (
          <section className="mongo-ai-result">
            <div className="mongo-ai-result-head">
              <div><small>MODEL RESPONSE</small><b>{TASK_LABELS[result.task]}</b></div>
              <Tag color="green" bordered={false}>{result.mode === "find" ? "Find" : "Aggregate"}</Tag>
            </div>
            <p>{result.explanation}</p>
            {result.assumptions.length > 0 && (
              <div className="mongo-ai-notes"><b>假设</b>{result.assumptions.map((item, index) => <span key={index}>· {item}</span>)}</div>
            )}
            {result.warnings.length > 0 && (
              <Alert showIcon type="warning" message="需要人工核对" description={<ul>{result.warnings.map((item, index) => <li key={index}>{item}</li>)}</ul>} />
            )}
            {result.task !== "explain" && <pre className="mongo-ai-json-preview">{draftText(result)}</pre>}
            <div className="mongo-ai-result-actions">
              {result.task !== "explain" && <FragmentLike>
                <Button size="small" icon={<Copy size={13} />} onClick={() => void copyDraft()}>复制草稿</Button>
                <Button size="small" type="primary" icon={<Send size={13} />} onClick={() => { onApply(applyResult(result)); onClose(); }}>应用到查询框</Button>
              </FragmentLike>}
              <Button size="small" icon={<Braces size={13} />} onClick={() => void run(result.task)}>重新生成</Button>
            </div>
            <Typography.Text type="secondary" className="mongo-ai-no-execute">应用仅填充 Filter / Projection / Sort / Pipeline，不会运行查询。</Typography.Text>
          </section>
        )}
        {!result && !pending && (
          <div className="mongo-ai-empty">
            <Braces size={18} /><b>查询结构由你审核</b><span>生成结果不会自动应用或执行；你可以先检查 JSON 和模型列出的假设。</span>
          </div>
        )}
      </div>
    </Drawer>
  );
}

// React.Fragment alias keeps the JSX close to the compiled structure.
function FragmentLike({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
