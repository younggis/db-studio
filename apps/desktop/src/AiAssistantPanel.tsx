// Reconstructed from vendor chunk AiAssistantPanel-DZzJ5MwT.js.
import { Fragment, lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Alert, Button, Checkbox, Divider, Drawer, Empty, Input, Modal, Progress, Select, Spin, Tag, Typography, message } from "antd";
import { Bot, Clipboard, Columns3, GitCompareArrows, RotateCw, Settings2, Sparkles, X } from "lucide-react";
import { schemaTableKey } from "@db-studio/shared/schema-table-key";
import type { PublicAiModelSettings, SqlAssistantResponse, SqlAssistantTask } from "@db-studio/ai";
import type { DatabaseEngine, TableInfo } from "@db-studio/shared";
import { createAiRequestLifecycle, createAiRequestScope } from "./ai-request-guard";

const { Text } = Typography;
const DiffEditor = lazy(() => import("@monaco-editor/react").then(({ DiffEditor }) => ({ default: DiffEditor })));

const taskLabels: Record<SqlAssistantTask, string> = {
  generate: "生成 SQL",
  repair: "修复失败 SQL",
  explain: "解释 SQL",
  "explain-plan": "解释执行计划",
  optimize: "优化建议",
  gis: "PostGIS 空间 SQL",
};
const taskNumbers: Record<SqlAssistantTask, string> = {
  generate: "01", repair: "02", explain: "03", optimize: "04", gis: "05", "explain-plan": "06",
};

interface QueryFailure {
  connectionId: string;
  sql: string;
  message: string;
  code?: string;
  position?: number;
}

interface AiAssistantPanelProps {
  open: boolean;
  connectionId?: string;
  connectionName?: string;
  engine?: DatabaseEngine;
  connections?: Array<{ id: string; name: string; engine: DatabaseEngine }>;
  onConnectionChange?: (id: string) => void;
  schema?: string;
  schemas: string[];
  sql: string;
  selectedSql?: string;
  failure?: QueryFailure;
  settingsRevision: number;
  initialTask?: SqlAssistantTask;
  onClose: () => void;
  onOpenSettings: () => void;
  onInsertSql: (sql: string) => void;
}

interface SchemaTables {
  tables?: TableInfo[];
  loading: boolean;
  error?: unknown;
}

export default function AiAssistantPanel(props: AiAssistantPanelProps) {
  const [settings, setSettings] = useState<PublicAiModelSettings>();
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [task, setTask] = useState<SqlAssistantTask>("generate");
  const [modelId, setModelId] = useState<string>();
  const [selectedSchemas, setSelectedSchemas] = useState<string[]>(() => {
    const initial = props.schema ?? props.schemas[0];
    return initial ? [initial] : [];
  });
  const [prompt, setPrompt] = useState("");
  const [executionPlan, setExecutionPlan] = useState("");
  const [includeSchema, setIncludeSchema] = useState(false);
  const [refreshSchema, setRefreshSchema] = useState(false);
  const [selectedTables, setSelectedTables] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const [indexBusy, setIndexBusy] = useState(false);
  const [indexStatus, setIndexStatus] = useState<{ kind: "success" | "error" | "info"; text: string }>();
  const [clearingIndex, setClearingIndex] = useState(false);
  const [streamedChars, setStreamedChars] = useState(0);
  const [result, setResult] = useState<SqlAssistantResponse>();
  const [originalSql, setOriginalSql] = useState("");
  const [diffOpen, setDiffOpen] = useState(false);

  const [schemaTables, setSchemaTables] = useState<Record<string, SchemaTables>>({});

  const scope = createAiRequestScope(props.connectionId, props.engine, props.schema);
  const indexScope = createAiRequestScope("schema-index", props.connectionId, ...selectedSchemas, ...selectedTables);
  const queryGuardRef = useRef<ReturnType<typeof createAiRequestLifecycle> | null>(null);
  const indexGuardRef = useRef<ReturnType<typeof createAiRequestLifecycle> | null>(null);
  if (!queryGuardRef.current) queryGuardRef.current = createAiRequestLifecycle(scope, (id) => window.dbStudio.ai.cancel(id));
  if (!indexGuardRef.current) indexGuardRef.current = createAiRequestLifecycle(indexScope, (id) => window.dbStudio.ai.cancel(id));
  const queryGuard = queryGuardRef.current;
  const indexGuard = indexGuardRef.current;

  const allTables = Object.values(schemaTables).flatMap((item) => item.tables ?? []);
  const loadingSchemas = selectedSchemas.filter((schema) => schemaTables[schema]?.loading);
  const schemaErrors = selectedSchemas
    .filter((schema) => schemaTables[schema]?.error)
    .map((schema) => ({ schema, error: schemaTables[schema].error }));
  const availableSchemas = [...new Set([props.schema, ...props.schemas].filter((value): value is string => !!value))];

  function cancelQuery(clearPending = true) {
    queryGuard.cancel();
    if (clearPending) setPending(false);
  }

  useLayoutEffect(() => {
    if (queryGuard.updateScope(scope)) {
      setPending(false); setPrompt(""); setExecutionPlan(""); setDiffOpen(false);
      indexGuard.cancel(); setIndexBusy(false);
    }
    const initial = props.schema ?? props.schemas[0];
    setSelectedSchemas(initial ? [initial] : []);
    setSelectedTables([]);
    setResult(undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryGuard, indexGuard, scope, props.schema]);

  useLayoutEffect(() => {
    if (indexGuard.updateScope(indexScope)) { setIndexBusy(false); setIndexStatus(undefined); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [indexGuard, indexScope]);

  useLayoutEffect(() => {
    if (!props.open) { cancelQuery(); setExecutionPlan(""); indexGuard.cancel(); setIndexBusy(false); setIndexStatus(undefined); }
    return () => { queryGuard.cancel(); indexGuard.cancel(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open, queryGuard, indexGuard]);

  useEffect(() => {
    if (!props.open) return;
    setTask(props.initialTask ?? "generate");
    setSettingsBusy(true);
    window.dbStudio.ai.settings().then((next) => {
      setSettings(next);
      setModelId(next.defaultChatModelId ?? next.chatModels.find((item) => item.enabled)?.id);
    }).catch((cause: unknown) => {
      message.error(cause instanceof Error ? cause.message : "读取 AI 设置失败。");
    }).finally(() => setSettingsBusy(false));
  }, [props.open, props.settingsRevision, props.initialTask]);

  useEffect(() => window.dbStudio.ai.onDelta(({ requestId, delta }) => {
    if (queryGuard.isActive(requestId)) setStreamedChars((value) => value + delta.length);
  }), [queryGuard]);

  useEffect(() => {
    if (!props.open || !props.connectionId || props.engine === "mongodb") return;
    let cancelled = false;
    const next: Record<string, SchemaTables> = {};
    for (const schema of selectedSchemas) next[schema] = { loading: true };
    setSchemaTables((current) => ({ ...current, ...next }));
    Promise.all(selectedSchemas.map(async (schema) => {
      try {
        const tables = await window.dbStudio.database.tables(props.connectionId!, schema);
        return [schema, { tables, loading: false }] as const;
      } catch (error) {
        return [schema, { loading: false, error }] as const;
      }
    })).then((entries) => {
      if (cancelled) return;
      setSchemaTables((current) => {
        const merged = { ...current };
        for (const [schema, value] of entries) merged[schema] = value;
        return merged;
      });
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open, props.connectionId, props.engine, refreshSchema, selectedSchemas.join("\0")]);

  const model = settings?.chatModels.find((item) => item.id === modelId && item.enabled);
  const effectiveSql = props.selectedSql?.trim() || props.sql;
  const needsSql = task === "repair" || task === "explain" || task === "explain-plan" || task === "optimize";
  const canRun = !!(props.connectionId && props.engine && props.engine !== "mongodb" && model && !settingsBusy
    && (!needsSql || effectiveSql.trim())
    && (task !== "explain-plan" || executionPlan.trim())
    && (!includeSchema || selectedSchemas.length > 0)
    && (!["generate", "repair", "gis"].includes(task) || (includeSchema && selectedSchemas.length > 0))
    && (task !== "gis" || (props.engine === "postgres" && selectedTables.length > 0 && selectedSchemas.length === 1))
    && (task !== "repair" || props.failure?.connectionId === props.connectionId));

  async function run(nextTask: SqlAssistantTask = task) {
    if (!props.connectionId) { message.warning("请先选择数据库连接。"); return; }
    if (!model) { message.warning("请先在 AI 设置中启用一个 Chat 模型。"); return; }
    if (includeSchema && !selectedSchemas.length) { message.warning("请至少选择一个 Schema，或关闭 Schema 同意选项。"); return; }
    if ((nextTask === "generate" || nextTask === "repair" || nextTask === "gis") && (!includeSchema || !selectedSchemas.length)) {
      message.warning("此任务需要允许发送当前匹配的表结构，以检查表和字段名称。"); return;
    }
    if (nextTask === "explain-plan" && !executionPlan.trim()) { message.warning("请粘贴由数据库客户端生成的执行计划；助手不会替你运行 EXPLAIN。"); return; }
    if (nextTask === "gis" && props.engine !== "postgres") { message.warning("PostGIS 空间 SQL 当前仅支持 PostgreSQL 连接。"); return; }
    if (nextTask === "gis" && selectedSchemas.length !== 1) { message.warning("PostGIS 空间 SQL 当前要求选择一个 Schema。"); return; }
    if (nextTask === "gis" && !selectedTables.length) { message.warning("请明确选择一个或多个空间表。"); return; }
    if (nextTask !== "explain" && nextTask !== "explain-plan" && nextTask !== "repair" && !prompt.trim()) { message.warning("请输入要完成的 SQL 需求。"); return; }
    if (needsSql && !effectiveSql.trim()) { message.warning("先在 Monaco 编辑器中选择或编写 SQL。"); return; }
    cancelQuery();
    const id = crypto.randomUUID();
    queryGuard.start(id, scope);
    setPending(true); setStreamedChars(0); setResult(undefined);
    const sql = effectiveSql;
    setOriginalSql(sql);
    try {
      const response = await window.dbStudio.ai.run({
        requestId: id,
        connectionId: props.connectionId,
        modelId: model.id,
        task: nextTask,
        request: prompt.trim(),
        schema: selectedSchemas[0],
        schemas: selectedSchemas,
        selectedTables,
        includeSchema,
        refreshSchema,
        selectedSql: needsSql ? sql : undefined,
        executionPlan: nextTask === "explain-plan" ? executionPlan.trim() : undefined,
        error: nextTask === "repair" && props.failure?.connectionId === props.connectionId
          ? { message: props.failure.message, code: props.failure.code, position: props.failure.position } : undefined,
      });
      if (!queryGuard.isCurrent(id, scope)) return;
      setResult(response);
    } catch (cause) {
      if (!queryGuard.isCurrent(id, scope)) return;
      message.error(cause instanceof Error ? cause.message : "AI 请求失败。");
    } finally {
      if (queryGuard.finish(id)) { setPending(false); setRefreshSchema(false); }
    }
  }

  async function buildIndex() {
    if (!props.connectionId || !selectedSchemas.length || !selectedTables.length) return;
    const selected = new Set(selectedTables);
    const bySchema = new Map<string, string[]>();
    for (const table of allTables) {
      const key = schemaTableKey(table.schema, table.name);
      if (!selected.has(key)) continue;
      bySchema.set(table.schema, [...(bySchema.get(table.schema) ?? []), key]);
    }
    const entries = [...bySchema.entries()];
    if (!entries.length) return;
    const id = crypto.randomUUID();
    indexGuard.start(id, indexScope);
    setIndexBusy(true); setIndexStatus(undefined);
    try {
      let tables = 0, dimensions = 0;
      for (const [schema, keys] of entries) {
        if (!indexGuard.isCurrent(id, indexScope)) return;
        const built = await window.dbStudio.ai.buildSchemaIndex(props.connectionId, schema, keys, id);
        tables += built.tableCount; dimensions = built.dimensions;
      }
      if (!indexGuard.isCurrent(id, indexScope)) return;
      const text = `已为 ${tables} 张表（${entries.length} 个 Schema）建立 ${dimensions} 维本机语义索引。`;
      setIndexStatus({ kind: "success", text }); message.success(text);
    } catch (cause) {
      if (indexGuard.isCurrent(id, indexScope)) {
        const text = cause instanceof Error ? cause.message : "建立 Schema 语义索引失败。";
        setIndexStatus({ kind: "error", text }); message.error(text);
      }
    } finally { if (indexGuard.finish(id)) setIndexBusy(false); }
  }

  function cancelIndex() {
    if (indexGuard.cancel()) {
      setIndexBusy(false);
      setIndexStatus({ kind: "info", text: "索引任务已取消；已完成的 Schema 可能已经写入本机索引。" });
    }
  }

  async function clearIndex() {
    if (!props.connectionId || !selectedSchemas.length) return;
    setClearingIndex(true);
    try {
      const results = await Promise.all(selectedSchemas.map((schema) => window.dbStudio.ai.clearSchemaIndex(props.connectionId!, schema)));
      const removed = results.reduce((sum, item) => sum + item.removedCount, 0);
      message.success(`已清除 ${selectedSchemas.length} 个 Schema 的 ${removed} 条本机向量。`);
    } catch (cause) { message.error(cause instanceof Error ? cause.message : "清除 Schema 索引失败。"); }
    finally { setClearingIndex(false); }
  }

  async function copySql() {
    if (!result?.result.sql) return;
    try { await navigator.clipboard.writeText(result.result.sql); message.success("SQL 已复制。"); }
    catch { message.error("无法访问剪贴板。"); }
  }

  function selectTask(next: SqlAssistantTask) { setTask(next); }

  const validation = result?.validation;
  const resultSql = result?.result.sql;
  const warnings = result?.result.warnings ?? [];

  return (
    <Fragment>
      <Drawer rootClassName="wb-surface"
        open={props.open}
        onClose={props.onClose}
        styles={{ wrapper: { width: 500 } }}
        destroyOnHidden
        title={<div className="ai-drawer-title"><span className="ai-drawer-mark"><Bot size={15} /></span><div><b>AI SQL Assistant</b><small>{props.connectionName ?? "未选择连接"} · {props.engine ?? "SQL"}</small></div></div>}
        extra={<Button type="text" size="small" icon={<Settings2 size={15} />} onClick={props.onOpenSettings}>模型设置</Button>}
      >
        <div className="ai-panel">
          {(props.connections?.length ?? 0) > 0 && (
            <div className="ai-connection-strip">
              <label>连接</label>
              <Select value={props.connectionId || undefined} onChange={(value) => props.onConnectionChange?.(value)} placeholder="请选择数据库连接" className="ai-model-select" disabled={pending} options={(props.connections ?? []).map((item) => ({ value: item.id, label: `${item.name} · ${item.engine}` }))} />
            </div>
          )}
          <div className="ai-model-strip">
            <span className="ai-model-live"><i />模型</span>
            {settingsBusy ? <Spin size="small" /> : (
              <Select value={modelId} onChange={setModelId} placeholder="选择已启用的模型" className="ai-model-select" options={(settings?.chatModels ?? []).filter((item) => item.enabled).map((item) => ({ value: item.id, label: <span>{item.name}<small className="ai-model-option-id">{item.model}</small></span> }))} notFoundContent={<span>尚未配置模型</span>} />
            )}
            {model && <Tag bordered={false}>{model.provider}</Tag>}
          </div>
          {!settings?.enabled && <Alert showIcon type="warning" className="ai-panel-alert" message="AI 助手尚未启用" description={<Button type="link" size="small" onClick={props.onOpenSettings}>打开模型设置</Button>} />}
          {props.engine === "mongodb" && <Alert showIcon type="info" className="ai-panel-alert" message="MongoDB 使用独立的 Filter / Aggregate 工作流，SQL 助手暂不处理文档查询。" />}

          <div className="ai-task-heading"><span>任务</span><small>AI 只生成草稿或解释，不会执行 SQL</small></div>
          <div className="ai-task-grid">
            {(Object.keys(taskLabels) as SqlAssistantTask[]).map((key) => (
              <button className={task === key ? "selected" : ""} onClick={() => selectTask(key)} key={key}>
                <span>{taskLabels[key]}</span>{taskNumbers[key]}
              </button>
            ))}
          </div>

          {task === "repair" && props.failure && props.failure.connectionId === props.connectionId && (
            <Alert showIcon type="error" className="ai-error-context" message="已附加最近一次查询错误" description={<span>{props.failure.code ? props.failure.code + " · " : ""}{props.failure.message.slice(0, 280)}</span>} />
          )}
          {task === "repair" && (!props.failure || props.failure.connectionId !== props.connectionId) && (
            <Alert showIcon type="warning" className="ai-error-context" message="需要先在当前连接执行失败的 SQL，助手不会使用其他连接的错误信息。" />
          )}

          <label className="ai-prompt-label">{task === "generate" || task === "gis" ? "你想查询什么？" : task === "repair" ? "希望修复时保留什么意图？（可选）" : "补充说明（可选）"}</label>
          <Input.TextArea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder={task === "gis" ? "例如：查询距指定点 5 公里内的建筑物" : task === "generate" ? "例如：统计最近 30 天各城市新增用户数，按数量降序取前 10 条" : "说明业务口径、期望结果或需要重点检查的部分"}
            autoSize={{ minRows: 3, maxRows: 7 }} maxLength={6000} showCount disabled={pending}
          />

          {task === "explain-plan" && (
            <Fragment>
              <Alert showIcon type="warning" className="ai-panel-alert" message="粘贴由数据库客户端生成的 EXPLAIN 计划；本应用不会运行 EXPLAIN 或 ANALYZE。" description="执行计划和当前 SQL 会发送到所选 Chat 服务用于解释，可能包含表名、索引名和估算值；发送前请移除不希望共享的内容。不要粘贴 EXPLAIN ANALYZE 的输出。" />
              <label className="ai-prompt-label">执行计划</label>
              <Input.TextArea value={executionPlan} onChange={(event) => setExecutionPlan(event.target.value)} placeholder="粘贴 EXPLAIN 输出（JSON、文本或 XML），最多 12,000 字符" autoSize={{ minRows: 5, maxRows: 10 }} maxLength={12000} showCount disabled={pending} />
            </Fragment>
          )}

          <div className="ai-schema-consent">
            <Checkbox checked={includeSchema} disabled={pending || indexBusy} onChange={(event) => { setIndexStatus(undefined); setIncludeSchema(event.target.checked); }}>允许将当前匹配的表结构（所选 Schema）发送到所选模型</Checkbox>
            <div>
              Chat 最多读取 8 张匹配表的表名、字段、类型与注释关系；不读取业务行。
              {settings?.embedding?.enabled && "开启 Embedding 时，所有选中表结构会发送至 Embedding 服务。"}
              {settings?.rerank?.enabled && "开启 Rerank 时，前 1,000 个字符、最多 12 条、每条 1,200 字符的 Schema 摘要会发送至 Rerank 服务。"}
              请确认后勾选。
            </div>
            {includeSchema && (
              <div className="ai-schema-scope">
                <label>Schema 范围</label>
                <Select mode="multiple" value={selectedSchemas} onChange={(values) => {
                  if (values.length > 16) { message.warning("一次最多选择 16 个 Schema。"); return; }
                  cancelQuery(); indexGuard.cancel(); setIndexBusy(false);
                  setSelectedSchemas(values); setSelectedTables([]); setIndexStatus(undefined); setResult(undefined);
                }} options={availableSchemas.map((item) => ({ value: item, label: item }))} placeholder="选择一个或多个 Schema" disabled={pending || indexBusy || availableSchemas.length === 0} showSearch maxTagCount="responsive" className="ai-table-select" />
              </div>
            )}
            {includeSchema && allTables.length > 0 && (
              <Button type="link" size="small" icon={<RotateCw size={13} />} disabled={pending} onClick={() => setRefreshSchema(true)}>{refreshSchema ? "下次生成刷新字段和关系" : "下次生成重新读取字段和关系"}</Button>
            )}
            {includeSchema && allTables.length > 0 && (
              <div className="ai-schema-scope">
                <label>相关表（推荐选择，可多选）</label>
                <Select mode="multiple" value={selectedTables} onChange={(values) => { setIndexStatus(undefined); setSelectedTables(values); }} disabled={pending || indexBusy} placeholder="选择相关表；留空时自动选择所选 Schema 前 8 张表" className="ai-table-select" maxTagCount="responsive" options={allTables.map((table) => ({ value: schemaTableKey(table.schema, table.name), label: `${table.schema}.${table.name}${table.type === "view" ? "（视图）" : ""}` }))} />
              </div>
            )}
            {includeSchema && selectedTables.length > 0 && settings?.embedding?.enabled && (
              <Button size="small" loading={indexBusy} disabled={pending || indexBusy} onClick={() => void buildIndex()}>根据选择的结构建立 Embedding 索引并进入语义检索</Button>
            )}
            {indexStatus && <Alert role={indexStatus.kind === "error" ? "alert" : "status"} aria-live={indexStatus.kind === "error" ? "assertive" : "polite"} type={indexStatus.kind === "success" ? "success" : indexStatus.kind === "error" ? "error" : "info"} message={indexStatus.text} />}
            {includeSchema && selectedTables.length > 0 && settings?.embedding?.enabled && (
              <Text type="secondary">模型、维度或索引方式变化后需重建索引；范围切换后旧向量仍保留，如需删除可清除当前所选 Schema 范围的向量。</Text>
            )}
            {indexBusy && <Button size="small" onClick={cancelIndex}>取消索引</Button>}
            {includeSchema && selectedSchemas.length > 0 && settings?.embedding?.enabled && (
              <Button size="small" danger loading={clearingIndex} disabled={pending || indexBusy || clearingIndex} onClick={() => void clearIndex()}>清除当前所选 Schema 索引</Button>
            )}
            {includeSchema && selectedSchemas.length === 0 && <Alert type="warning" message="请先选择至少一个 Schema 以及可读取的数据库结构。" />}
            {task === "gis" && <div>GIS 模式只允许选择明确选定的空间表，输入单位取自字段类型、SRID 与 geometry/geography 类型。</div>}
            {includeSchema && loadingSchemas.map((schema) => <Tag key={schema}>正在读取 {schema} 的表清单…</Tag>)}
            {includeSchema && schemaErrors.map(({ schema, error }) => <Tag key={schema} color="red">读取 {schema} 的表清单失败：{error instanceof Error ? error.message : "未知错误"}</Tag>)}
            {includeSchema && selectedSchemas.length > 0 && loadingSchemas.length === 0 && schemaErrors.length === 0 && allTables.length === 0 && <Tag color="warning">所选 Schema 没有可用的表清单。</Tag>}
          </div>

          <Alert showIcon type="info" className="ai-privacy-note" message="最终提交内容由你自己确认；只有明确勾选后才会 SQL / Schema 信息发送给所选模型。" description={<Fragment>不会上传业务行、数据库密码与连接串。{settings?.embedding?.enabled && "开启 Embedding 后，所选表结构会额外发送至 Embedding 服务。"}{settings?.rerank?.enabled && "开启 Rerank 后，最多 12 条截断到 1,000 字符的 Schema 摘要会发送至 Rerank 服务。"}生成结果只会显示供预览，确认后才可插入编辑器。</Fragment>} />

          <div className="ai-run-row">
            <Button type="primary" icon={<Sparkles size={14} />} loading={pending} disabled={!canRun} title={props.connectionId ? model ? canRun ? undefined : "请填写需求并确认勾选 Schema" : "请先在模型设置中启用 Chat 模型" : "请先在上方选择一个数据库连接"} onClick={() => void run()}>{pending ? "正在请求模型" : taskLabels[task]}</Button>
            {pending && <Button icon={<X size={14} />} onClick={() => cancelQuery()}>取消</Button>}
            {task === "repair" && props.failure?.connectionId === props.connectionId && <Button type="link" onClick={() => void run("repair")}>重新生成</Button>}
          </div>
          {pending && <div className="ai-stream-state"><Progress percent={100} showInfo={false} status="active" /><span>{`正在接收结构化结果 · ${streamedChars.toLocaleString()} 字符`}</span></div>}

          {result ? (
            <Fragment>
              <Divider className="ai-result-divider" />
              <section className="ai-result-card">
                <div className="ai-result-head"><div><span className="ai-result-kicker">ASSISTANT RESULT</span><b>{taskLabels[result.result.task]}</b></div><Tag color={validation?.valid === false ? "red" : "green"} bordered={false}>{result.result.dialect}</Tag></div>
                {result.result.evidenceBasis === "static-review" && <Tag color="gold">静态 SQL 审核 · 未获取执行计划</Tag>}
                {result.result.evidenceBasis === "user-supplied-plan" && <Tag color="blue">使用用户提供的执行计划</Tag>}
                <p>{result.result.explanation}</p>
                {!!result.result.assumptions?.length && <div className="ai-result-list"><b>假设</b>{result.result.assumptions.map((item, index) => <span key={index}>· {item}</span>)}</div>}
                {warnings.length > 0 && <Alert type={validation?.valid === false ? "error" : "warning"} showIcon className="ai-result-warning" message={validation?.valid === false ? "需要先解决以下问题再执行" : "结果提示"} description={<ul>{warnings.map((item, index) => <li key={index}>{item}</li>)}</ul>} />}
                {resultSql && <pre className="ai-sql-preview">{resultSql}</pre>}
                {resultSql && <div className="ai-result-actions"><Button size="small" icon={<Clipboard size={13} />} onClick={() => void copySql()}>复制</Button>{result.result.task === "repair" ? <Button size="small" icon={<GitCompareArrows size={13} />} disabled={!validation?.valid} onClick={() => setDiffOpen(true)}>比较并应用修复</Button> : <Button size="small" type="primary" icon={<Columns3 size={13} />} disabled={!validation?.valid} onClick={() => props.onInsertSql(resultSql)}>插入编辑器</Button>}<Button size="small" icon={<RotateCw size={13} />} onClick={() => void run(result.result.task)}>重新生成</Button></div>}
                {!!result.result.referencedObjects?.length && <div className="ai-object-list"><Bot size={13} />引用对象{result.result.referencedObjects.join("、")}</div>}
              </section>
            </Fragment>
          ) : pending ? null : (
            <div className="ai-panel-empty"><span><Sparkles size={18} /></span><b>你的查询助手已就位</b><small>提交请求后，SQL 和头部信息会显示供你检查是否保留。</small></div>
          )}
        </div>
      </Drawer>

      <Modal open={diffOpen} onCancel={() => setDiffOpen(false)} width={1000} title={<span className="ai-diff-title"><GitCompareArrows size={16} />修复前后 · 待你对比后应用</span>} footer={<div className="ai-diff-footer"><Button onClick={() => setDiffOpen(false)}>取消</Button><Button type="primary" disabled={!validation?.valid} onClick={() => { if (resultSql) props.onInsertSql(resultSql); setDiffOpen(false); }}>应用修复的 SQL</Button></div>}>
        {resultSql ? <Suspense fallback={<div className="gis-loading"><Spin size="small" /> 正在加载 SQL 对比视图</div>}><DiffEditor height="58vh" language="sql" original={originalSql} modified={resultSql} theme="vs" options={{ readOnly: true, renderSideBySide: true, minimap: { enabled: false }, automaticLayout: true, originalEditable: false, scrollBeyondLastLine: false }} /></Suspense> : <Empty description="没有可比较的修复结果" />}
      </Modal>
    </Fragment>
  );
}
