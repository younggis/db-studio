// Reconstructed from vendor chunk AiSettingsModal-ChfFCd_5.js.
import { useEffect, useState } from "react";
import { Alert, Button, Divider, Input, InputNumber, Modal, Select, Space, Switch, Typography, message } from "antd";
import { AlertCircle, Play, Plus, Save, Settings2, Trash2 } from "lucide-react";
import type {
  PublicAiModelSettings,
  PublicChatModelConfig,
  PublicEmbeddingModelConfig,
  PublicRerankModelConfig,
} from "@db-studio/ai";

type ChatDraft = PublicChatModelConfig & { apiKey: string };
type EmbeddingDraft = PublicEmbeddingModelConfig & { apiKey: string };
type RerankDraft = PublicRerankModelConfig & { apiKey: string };

const DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";

function newChatModel(): ChatDraft {
  return {
    id: crypto.randomUUID(),
    name: "DashScope Chat",
    provider: "openai-compatible",
    baseURL: DEFAULT_BASE_URL,
    model: "qwen3.6-flash",
    apiKey: "",
    apiKeySet: false,
    temperature: 0.2,
    maxOutputTokens: 2048,
    timeoutMs: 60_000,
    streaming: true,
    enabled: false,
  };
}

function newEmbedding(): EmbeddingDraft {
  return {
    provider: "openai-compatible",
    baseURL: DEFAULT_BASE_URL,
    model: "text-embedding-v4",
    apiKey: "",
    apiKeySet: false,
    dimensions: 1024,
    batchSize: 10,
    timeoutMs: 60_000,
    enabled: false,
  };
}

function newRerank(): RerankDraft {
  return {
    provider: "dashscope",
    baseURL: DEFAULT_BASE_URL,
    model: "gte-rerank-v2",
    apiKey: "",
    apiKeySet: false,
    timeoutMs: 60_000,
    enabled: false,
  };
}

function describeError(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function ApiKeyField({ value, configured, onChange }: { value: string; configured: boolean; onChange: (value: string) => void }) {
  return (
    <Input.Password
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder={configured ? "留空保持已保存的密钥" : "粘贴 API Key"}
      autoComplete="new-password"
    />
  );
}

interface AiSettingsModalProps {
  open: boolean;
  onClose: () => void;
  onSaved?: () => void;
}

export default function AiSettingsModal({ open, onClose, onSaved }: AiSettingsModalProps) {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [chatModels, setChatModels] = useState<ChatDraft[]>([]);
  const [defaultChatModelId, setDefaultChatModelId] = useState<string>();
  const [embedding, setEmbedding] = useState<EmbeddingDraft>(newEmbedding);
  const [rerank, setRerank] = useState<RerankDraft>(newRerank);
  const [testResults, setTestResults] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    window.dbStudio.ai.settings().then((settings: PublicAiModelSettings) => {
      setEnabled(settings.enabled);
      const drafts = settings.chatModels.map((model) => ({ ...model, apiKey: "" }));
      setChatModels(drafts.length ? drafts : [newChatModel()]);
      setDefaultChatModelId(settings.defaultChatModelId);
      setEmbedding(settings.embedding ? { ...settings.embedding, apiKey: "" } : newEmbedding());
      setRerank(settings.rerank ? { ...settings.rerank, apiKey: "" } : newRerank());
    }).catch((error: unknown) => {
      message.error(describeError(error, "读取 AI 设置失败。"));
    }).finally(() => setLoading(false));
  }, [open]);

  function updateChat(index: number, patch: Partial<ChatDraft>) {
    setChatModels((current) => current.map((model, position) => position === index ? { ...model, ...patch } : model));
  }

  async function testModel(kind: "chat" | "embedding" | "rerank", config: object, key: string) {
    setTestResults((current) => ({ ...current, [key]: "testing" }));
    try {
      const result = await window.dbStudio.ai.testModel(kind, config as Record<string, unknown>);
      setTestResults((current) => ({ ...current, [key]: result.message }));
      message.success(result.message);
    } catch (error) {
      const text = describeError(error, "模型测试失败。");
      setTestResults((current) => ({ ...current, [key]: text }));
      message.error(text);
    }
  }

  async function save() {
    setSaving(true);
    try {
      const withoutSecret = <T extends { apiKeySet?: boolean }>(value: T) => {
        const { apiKeySet: _ignored, ...rest } = value;
        return rest;
      };
      const settings = await window.dbStudio.ai.saveSettings({
        enabled,
        chatModels: chatModels.map(withoutSecret),
        defaultChatModelId,
        embedding: embedding.model.trim() ? withoutSecret(embedding) : undefined,
        rerank: rerank.model.trim() ? withoutSecret(rerank) : undefined,
      });
      setChatModels(settings.chatModels.map((model) => ({ ...model, apiKey: "" })));
      setEmbedding(settings.embedding ? { ...settings.embedding, apiKey: "" } : newEmbedding());
      setRerank(settings.rerank ? { ...settings.rerank, apiKey: "" } : newRerank());
      setDefaultChatModelId(settings.defaultChatModelId);
      setTestResults({});
      message.success("AI 模型设置已安全保存。");
      onSaved?.();
      onClose();
    } catch (error) {
      message.error(describeError(error, "保存 AI 设置失败。"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onCancel={onClose}
      title={<span className="ai-settings-title"><Settings2 size={17} />AI 模型与隐私设置</span>}
      width={760}
      footer={null}
      destroyOnHidden
    >
      {loading
        ? <div className="ai-settings-loading">正在读取本机加密配置…</div>
        : <div className="ai-settings">
            <Alert
              showIcon
              icon={<Settings2 size={15} />}
              message="密钥只在此处录入，并由 Electron 主进程使用系统安全存储加密。Renderer 无法读取已保存的密钥。"
              description="模型请求只发送你主动提交的需求；Schema、SQL 和错误消息会随单次请求发送给所选服务。不会读取或上传业务行、数据库密码或连接 URI。"
              type="info"
              className="ai-security-alert"
            />
            <div className="ai-settings-toggle">
              <div><b>启用 AI SQL Assistant</b><span>关闭后 SQL 编辑器与数据库查询仍可正常使用</span></div>
              <Switch checked={enabled} onChange={setEnabled} />
            </div>

            <section className="ai-setting-section">
              <div className="ai-setting-heading">
                <div><b>Chat 模型</b><span>OpenAI-compatible Chat Completions</span></div>
                <Button
                  size="small"
                  icon={<Plus size={14} />}
                  onClick={() => setChatModels((current) => [...current, newChatModel()])}
                  disabled={chatModels.length >= 10}
                >添加模型</Button>
              </div>
              {chatModels.map((model, index) => {
                const key = `chat:${model.id}`;
                return (
                  <div className="ai-model-card" key={model.id}>
                    <div className="ai-model-card-top">
                      <div className="ai-model-badge">{`CHAT ${String(index + 1).padStart(2, "0")}`}</div>
                      <span className="ai-switch-label"><Switch checked={model.enabled} onChange={(checked) => updateChat(index, { enabled: checked })} />可用于助手</span>
                      <Button
                        type="text"
                        danger
                        size="small"
                        aria-label="删除模型"
                        title="删除模型"
                        icon={<Trash2 size={14} />}
                        onClick={() => {
                          const next = chatModels.filter((_item, position) => position !== index);
                          setChatModels(next);
                          if (defaultChatModelId === model.id) setDefaultChatModelId(next.find((item) => item.enabled)?.id);
                        }}
                      />
                    </div>
                    <div className="ai-field-grid">
                      <label>配置名称<Input value={model.name} onChange={(event) => updateChat(index, { name: event.target.value })} placeholder="例如：本地 Qwen" /></label>
                      <label>Model ID<Input value={model.model} onChange={(event) => updateChat(index, { model: event.target.value })} placeholder="模型服务提供的 ID" /></label>
                      <label className="wide">Base URL<Input value={model.baseURL} onChange={(event) => updateChat(index, { baseURL: event.target.value })} placeholder="https://…/v1" /></label>
                      <label className="wide">API Key<ApiKeyField value={model.apiKey} configured={model.apiKeySet} onChange={(value) => updateChat(index, { apiKey: value })} /></label>
                      <label>Temperature<InputNumber min={0} max={2} step={0.1} value={model.temperature} onChange={(value) => updateChat(index, { temperature: value ?? 0.2 })} /></label>
                      <label>最大输出 Token<InputNumber min={64} max={16384} step={256} value={model.maxOutputTokens} onChange={(value) => updateChat(index, { maxOutputTokens: value ?? 2048 })} /></label>
                      <label>超时（毫秒）<InputNumber min={1000} max={300000} step={5000} value={model.timeoutMs} onChange={(value) => updateChat(index, { timeoutMs: value ?? 60_000 })} /></label>
                      <label>流式响应<Switch checked={model.streaming} onChange={(checked) => updateChat(index, { streaming: checked })} /></label>
                    </div>
                    <div className="ai-model-card-bottom">
                      <span className="ai-switch-label">
                        <Switch
                          checked={defaultChatModelId === model.id}
                          disabled={!model.enabled}
                          onChange={(checked) => setDefaultChatModelId(checked ? model.id : undefined)}
                        />默认模型
                      </span>
                      <Space size={8}>
                        <Typography.Text type="secondary">{model.apiKeySet ? "本机已有加密密钥" : "未配置密钥"}</Typography.Text>
                        <Button size="small" icon={<Play size={13} />} loading={testResults[key] === "testing"} onClick={() => void testModel("chat", model, key)}>测试连接</Button>
                      </Space>
                    </div>
                    {testResults[key] && testResults[key] !== "testing" && (
                      <div className="ai-test-result"><AlertCircle size={13} />{testResults[key]}</div>
                    )}
                  </div>
                );
              })}
              <label className="ai-default-model">
                助手默认使用
                <Select
                  value={defaultChatModelId}
                  onChange={setDefaultChatModelId}
                  placeholder="选择已启用的 Chat 模型"
                  options={chatModels.filter((model) => model.enabled).map((model) => ({ value: model.id, label: `${model.name} · ${model.model}` }))}
                />
              </label>
            </section>

            <Divider />

            <section className="ai-setting-section">
              <div className="ai-setting-heading">
                <div><b>Embedding 模型</b><span>独立于 Chat 配置；仅在开启语义检索时使用</span></div>
                <span className="ai-switch-label"><Switch checked={embedding.enabled} onChange={(checked) => setEmbedding((current) => ({ ...current, enabled: checked }))} />启用</span>
              </div>
              <div className="ai-field-grid">
                <label>Provider
                  <Select
                    value={embedding.provider}
                    onChange={(value) => setEmbedding((current) => ({ ...current, provider: value }))}
                    options={[{ value: "openai-compatible", label: "OpenAI-compatible" }, { value: "dashscope", label: "DashScope" }]}
                  />
                </label>
                <label>Model ID<Input value={embedding.model} onChange={(event) => setEmbedding((current) => ({ ...current, model: event.target.value }))} /></label>
                <label className="wide">Base URL<Input value={embedding.baseURL} onChange={(event) => setEmbedding((current) => ({ ...current, baseURL: event.target.value }))} /></label>
                <label className="wide">API Key<ApiKeyField value={embedding.apiKey} configured={embedding.apiKeySet} onChange={(value) => setEmbedding((current) => ({ ...current, apiKey: value }))} /></label>
                <label>向量维度<InputNumber min={1} max={8192} value={embedding.dimensions} onChange={(value) => setEmbedding((current) => ({ ...current, dimensions: value ?? undefined }))} /></label>
                <label>批次大小<InputNumber min={1} max={10} value={embedding.batchSize} onChange={(value) => setEmbedding((current) => ({ ...current, batchSize: value ?? 10 }))} /></label>
              </div>
              <div className="ai-model-card-bottom">
                <Typography.Text type="secondary">{embedding.apiKeySet ? "本机已有加密密钥" : "未配置密钥"}</Typography.Text>
                <Button size="small" icon={<Play size={13} />} loading={testResults.embedding === "testing"} onClick={() => void testModel("embedding", embedding, "embedding")}>测试 Embedding</Button>
              </div>
              {testResults.embedding && testResults.embedding !== "testing" && (
                <div className="ai-test-result"><AlertCircle size={13} />{testResults.embedding}</div>
              )}
            </section>

            <Divider />

            <section className="ai-setting-section">
              <div className="ai-setting-heading">
                <div><b>Rerank 模型</b><span>可选的候选 Schema 重排服务</span></div>
                <span className="ai-switch-label"><Switch checked={rerank.enabled} onChange={(checked) => setRerank((current) => ({ ...current, enabled: checked }))} />启用</span>
              </div>
              <div className="ai-field-grid">
                <label>Provider
                  <Select
                    value={rerank.provider}
                    onChange={(value) => setRerank((current) => ({ ...current, provider: value }))}
                    options={[{ value: "dashscope", label: "DashScope" }, { value: "openai-compatible", label: "OpenAI-compatible / 本地" }]}
                  />
                </label>
                <label>Model ID<Input value={rerank.model} onChange={(event) => setRerank((current) => ({ ...current, model: event.target.value }))} /></label>
                <label>超时（毫秒）<InputNumber min={1000} max={300000} value={rerank.timeoutMs} onChange={(value) => setRerank((current) => ({ ...current, timeoutMs: value ?? 60_000 }))} /></label>
                <label className="wide">Base URL<Input value={rerank.baseURL} onChange={(event) => setRerank((current) => ({ ...current, baseURL: event.target.value }))} /></label>
                <label className="wide">API Key<ApiKeyField value={rerank.apiKey} configured={rerank.apiKeySet} onChange={(value) => setRerank((current) => ({ ...current, apiKey: value }))} /></label>
              </div>
              <div className="ai-model-card-bottom">
                <Typography.Text type="secondary">{rerank.apiKeySet ? "本机已有加密密钥" : "未配置密钥"}</Typography.Text>
                <Button size="small" icon={<Play size={13} />} loading={testResults.rerank === "testing"} onClick={() => void testModel("rerank", rerank, "rerank")}>测试 Rerank</Button>
              </div>
              {testResults.rerank && testResults.rerank !== "testing" && (
                <div className="ai-test-result"><AlertCircle size={13} />{testResults.rerank}</div>
              )}
            </section>

            <div className="ai-settings-footer">
              <Button onClick={onClose}>取消</Button>
              <Button type="primary" icon={<Save size={14} />} loading={saving} onClick={() => void save()}>保存到本机</Button>
            </div>
          </div>}
    </Modal>
  );
}
