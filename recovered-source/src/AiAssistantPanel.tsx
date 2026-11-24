import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { Alert, Button, Checkbox, Divider, Drawer, Empty, Input, Modal, Progress, Select, Space, Spin, Tag, Typography, message } from "antd";
import { Bot, Check, Clipboard, Columns3, GitCompareArrows, RotateCw, Settings2, Sparkles, X } from "lucide-react";
import { schemaTableKey } from "@db-studio/shared/schema-table-key";
import type { PublicAiModelSettings, SqlAssistantResponse, SqlAssistantTask } from "@db-studio/ai";
import type { DatabaseEngine } from "@db-studio/shared";
import { createAiRequestLifecycle, createAiRequestScope } from "./ai-request-guard.js";

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

export default function AiAssistantPanel(props: AiAssistantPanelProps) {
  const [settings, setSettings] = useState<PublicAiModelSettings>();
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [task, setTask] = useState<SqlAssistantTask>("generate");
  const [modelId, setModelId] = useState<string>();
  const [selectedSchemas, setSelectedSchemas] = useState<string[]>(() => {
    const initialSchema = props.schema ?? props.schemas[0];




























































































  const currentModel = settings?.chatModels.find((model) => model.id === modelId && model.enabled);
  const currentSql = props.selectedSql?.trim() || props.sql;
  const taskNeedsSql = task === "repair" || task === "explain" || task === "explain-plan" || task === "optimize";
  const canRun = Boolean(props.connectionId && props.engine && props.engine !== "mongodb" && currentModel && !settingsBusy
    && (!taskNeedsSql || currentSql.trim())
    && (task !== "explain-plan" || executionPlan.trim())
    && (!includeSchema || selectedSchemas.length > 0)
    && (!["generate", "repair", "gis"].includes(task) || (includeSchema && selectedSchemas.length > 0))
    && (task !== "gis" || (props.engine === "postgres" && selectedTables.length > 0 && selectedSchemas.length === 1))
    && (task !== "repair" || props.failure?.connectionId === props.connectionId));

  async function run(nextTask = task) {
    if (!props.connectionId) { message.warning("请先选择数据库连接。"); return; }
    if (!currentModel) { message.warning("请先在 AI 设置中启用一个 Chat 模型。"); return; }
    if (includeSchema && !selectedSchemas.length) { message.warning("请至少选择一个 Schema，或关闭 Schema 同意选项。"); return; }
    if ((nextTask === "generate" || nextTask === "repair" || nextTask === "gis") && (!includeSchema || !selectedSchemas.length)) {
      message.warning("此任务需要允许发送当前匹配的表结构，以检查表和字段名称。"); return;
    }
    if (nextTask === "explain-plan" && !executionPlan.trim()) {
      message.warning("请粘贴由数据库客户端生成的执行计划；助手不会替你运行 EXPLAIN。"); return;
    }































































































































    <Drawer open={props.open} onClose={props.onClose} styles={{ wrapper: { width: 500 } }} destroyOnHidden
      title={<div className="ai-drawer-title"><span className="ai-drawer-mark"><Sparkles size={15} /></span><div><b>AI SQL Assistant</b><small>{props.connectionName ?? "未选择连接"} · {props.engine ?? "SQL"}</small></div></div>}
      extra={<Button type="text" size="small" icon={<Settings2 size={15} />} onClick={props.onOpenSettings}>模型设置</Button>}
    >
      <div className="ai-panel">
        {(props.connections?.length ?? 0) > 0 && <div className="ai-connection-strip">
          <label>连接</label>
          <Select
            value={props.connectionId || undefined}
            onChange={(value) => props.onConnectionChange?.(value)}
            placeholder="请选择数据库连接"
            className="ai-model-select"
            disabled={busy}
            options={(props.connections ?? []).map((connection) => ({
              value: connection.id,
              label: `${connection.name} · ${connection.engine}`,
            }))}
          />
        </div>}
        <div className="ai-model-strip">
          <span className="ai-model-live"><i />模型</span>
          {settingsBusy ? <Spin size="small" /> : <Select
            value={modelId} onChange={setModelId} placeholder="选择已启用的模型" className="ai-model-select"
            options={(settings?.chatModels ?? []).filter((model) => model.enabled).map((model) => ({
              value: model.id, label: <span>{model.name}<small className="ai-model-option-id">{model.model}</small></span>,
            }))}
            notFoundContent={<span>尚未配置模型</span>}
          />}
          {currentModel && <Tag bordered={false}>{currentModel.provider}</Tag>}
        </div>

        {!settings?.enabled && <Alert
          showIcon type="warning" className="ai-panel-alert"
          message="AI 助手尚未启用"
          description={<Button type="link" size="small" onClick={props.onOpenSettings}>打开模型设置</Button>}
        />}
        {props.engine === "mongodb" && <Alert showIcon type="info" className="ai-panel-alert" message="MongoDB 使用独立的 Filter / Aggregate 工作流，SQL 助手暂不处理文档查询。" />}

        <div className="ai-task-heading"><span>任务</span><small>AI 只生成草稿或解释，不会执行 SQL</small></div>
        <div className="ai-task-grid">















        <Input.TextArea
          value={request} onChange={(event) => setRequest(event.target.value)}
          placeholder={task === "gis" ? "例如：查询距指定点 5 公里内的建筑物" : task === "generate" ? "例如：统计最近 30 天各城市新增用户数，按数量降序取前 10 名" : "说明业务口径、期望结果或需要重点检查的部分"}
          autoSize={{ minRows: 3, maxRows: 7 }} maxLength={6_000} showCount
          disabled={busy}
        />

        {task === "explain-plan" && <>
          <Alert showIcon type="warning" className="ai-panel-alert"
            message="粘贴由数据库客户端生成的 EXPLAIN 计划；本应用不会运行 EXPLAIN 或 ANALYZE。"
            description="执行计划和当前 SQL 会发送到所选 Chat 服务用于解释，可能包含表名、索引名和估算值；发送前请移除不希望共享的内容。不要粘贴 EXPLAIN ANALYZE 的输出。"
          />
          <label className="ai-prompt-label">执行计划</label>
          <Input.TextArea
            value={executionPlan} onChange={(event) => setExecutionPlan(event.target.value)}
            placeholder="粘贴 EXPLAIN 输出（JSON、文本或 XML），最多 12,000 个字符"
            autoSize={{ minRows: 5, maxRows: 10 }} maxLength={12_000} showCount disabled={busy}
          />
        </>}

        <div className="ai-schema-consent">
          <Checkbox
            checked={includeSchema}
            disabled={busy || indexBusy}
            onChange={(event) => { setIndexFeedback(undefined); setIncludeSchema(event.target.checked); }}
          >
            允许将本次匹配的表结构发送至配置的模型服务
          </Checkbox>
          <div>
            Chat 最多接收 8 张匹配表的名称、字段、类型、备注和关系；不读取业务行。
          </div>
          {includeSchema && <div className="ai-schema-scope">
            <label>Schema 范围</label>
            <Select
              mode="multiple"
              value={selectedSchemas}
              onChange={(values: string[]) => {
                if (values.length > 16) { message.warning("一次最多选择 16 个 Schema。"); return; }
                cancelActive();
                indexLifecycle.cancel();
                setIndexBusy(false);
                setSelectedSchemas(values);
                setSelectedTables([]);
                setIndexFeedback(undefined);
                setResult(undefined);
              }}
              options={schemaOptions.map((schema) => ({ value: schema, label: schema }))}
              placeholder="选择一个或多个 Schema"
              disabled={busy || indexBusy || schemaOptions.length === 0}
              showSearch
              maxTagCount="responsive"
              className="ai-table-select"
            />
          </div>}
          {includeSchema && tables.length > 0 && <Button
            type="link" size="small" icon={<RotateCw size={13} />} disabled={busy}
            onClick={() => setRefreshSchemaNext(true)}
          >{refreshSchemaNext ? "下次请求将刷新字段和关系" : "下次请求重新读取字段和关系"}</Button>}
          {includeSchema && tables.length > 0 && <div className="ai-schema-scope">
            <label>相关表（推荐选择，可多选）</label>
            <Select
            mode="multiple" value={selectedTables} onChange={(values: string[]) => { setIndexFeedback(undefined); setSelectedTables(values); }} disabled={busy || indexBusy}
            placeholder="选择相关表；不选时自动包含所选 Schema 前 8 张表" className="ai-table-select"
            maxTagCount="responsive"
            options={tables.map((table) => ({
              value: schemaTableKey(table.schema, table.name),
              label: table.schema + "." + table.name + (table.type === "view" ? " · 视图" : ""),
            }))}
          />}
          />}
          {includeSchema && selectedTables.length > 0 && settings?.embedding?.enabled && <Button
            size="small" loading={indexBusy} disabled={busy || indexBusy}
            onClick={() => void buildSchemaIndex()}
          >将所选表结构发送至 Embedding 服务并建立本机索引</Button>}











































            {settings?.rerank?.enabled && <>启用 Rerank 时，最多 12 份截断的 Schema 摘要和前 1,000 个字符的需求会发给 Rerank 服务。</>}
            生成内容只进入预览，必须由你确认后才会插入编辑器。
          </>}
        />

        <div className="ai-run-row">
          <Button type="primary" icon={<Sparkles size={14} />} loading={busy} disabled={!canRun}
            title={!props.connectionId ? "请先在上方选择一个数据库连接" : !currentModel ? "请先在模型设置中启用 Chat 模型" : !canRun ? "请填写需求并确认已选择 Schema" : undefined}
            onClick={() => void run()}>
            {busy ? "正在请求模型" : taskLabels[task]}
          </Button>
          {busy && <Button icon={<X size={14} />} onClick={() => cancelActive()}>取消</Button>}
          {task === "repair" && props.failure?.connectionId === props.connectionId && <Button type="link" onClick={() => void run("repair")}>重新生成</Button>}
        </div>
        {busy && <div className="ai-stream-state"><Progress percent={100} showInfo={false} status="active" /><span>正在接收结构化结果 · {streamCharacters.toLocaleString()} 字符</span></div>}

