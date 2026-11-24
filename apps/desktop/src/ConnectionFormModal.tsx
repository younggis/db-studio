// Reconstructed from vendor chunk ConnectionFormModal-CvGV5FvW.js.
import { Fragment, useLayoutEffect, useMemo } from "react";
import { Alert, Button, Checkbox, Form, Input, InputNumber, Modal, Select, Typography } from "antd";
import { Database } from "lucide-react";
import type { DatabaseEngine } from "@db-studio/shared";
import { initialConnectionValues } from "./connection-form-values";

export interface ConnectionSummary {
  id: string;
  name: string;
  engine: DatabaseEngine;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  endpoint?: string;
  hasUri: boolean;
  encrypt?: boolean;
  trustServerCertificate?: boolean;
  ssl?: boolean;
  path?: string;
  hasPassword: boolean;
  ssh?: {
    host: string;
    port: number;
    username: string;
    authentication: "password" | "privateKey";
    hostFingerprint: string;
    hasCredentials: boolean;
    hasPassphrase: boolean;
  };
}

export interface ConnectionValues {
  id?: string;
  name: string;
  engine: DatabaseEngine;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  uri?: string;
  encrypt?: boolean;
  trustServerCertificate?: boolean;
  ssl?: boolean;
  path?: string;
  ssh?: {
    enabled: boolean;
    host?: string;
    port?: number;
    username?: string;
    authentication?: "password" | "privateKey";
    hostFingerprint?: string;
    password?: string;
    privateKey?: string;
    passphrase?: string;
  };
}

interface ConnectionFormModalProps {
  open: boolean;
  editingConnection?: ConnectionSummary;
  error?: string;
  desktopEngines: readonly DatabaseEngine[];
  engineLabels: Partial<Record<DatabaseEngine, string>>;
  defaultPorts: Partial<Record<DatabaseEngine, number>>;
  onCancel: () => void;
  onSave: (values: ConnectionValues) => void;
}

const { Text } = Typography;

export default function ConnectionFormModal({
  open,
  editingConnection,
  error,
  desktopEngines,
  engineLabels,
  defaultPorts,
  onCancel,
  onSave,
}: ConnectionFormModalProps) {
  const [form] = Form.useForm<ConnectionValues>();
  const initialValues = useMemo(() => initialConnectionValues(editingConnection), [editingConnection]);

  useLayoutEffect(() => {
    if (!open) return;
    form.resetFields();
    form.setFieldsValue(initialValues);
  }, [form, initialValues, open]);

  return (
    <Modal
      title={
        <div className="modal-title">
          <div className="modal-icon"><Database size={17} /></div>
          <div>
            <b>{editingConnection ? "编辑数据库连接" : "新建数据库连接"}</b>
            <span>PostgreSQL · MySQL · MariaDB · SQLite · SQL Server · MongoDB</span>
          </div>
        </div>
      }
      open={open}
      onCancel={onCancel}
      footer={null}
      destroyOnHidden
      width={500}
    >
      {error && (
        <Alert
          showIcon
          type="error"
          className="connection-save-error"
          message="连接保存失败"
          description={error}
          style={{ marginBottom: 16 }}
        />
      )}
      <Form
        form={form}
        layout="vertical"
        className="connection-form"
        initialValues={initialValues}
        onValuesChange={(changed) => {
          if (changed.engine && changed.engine !== "sqlite") {
            const port = defaultPorts[changed.engine];
            if (port !== undefined) form.setFieldValue("port", port);
            if (changed.engine === "oracle") form.setFieldValue("database", "FREEPDB1");
          }
          if (changed.engine === "sqlite" || changed.engine === "mongodb") {
            form.setFieldValue(["ssh", "enabled"], false);
          }
        }}
        onFinish={(values) => onSave({ ...values, id: editingConnection?.id })}
      >
        <Form.Item name="id" hidden><Input /></Form.Item>
        <Form.Item name="name" label="连接名称" rules={[{ required: true }]}>
          <Input placeholder="例如：开发数据库" />
        </Form.Item>
        <Form.Item name="engine" label="数据库类型" rules={[{ required: true }]}>
          <Select options={desktopEngines.map((engine) => ({ value: engine, label: engineLabels[engine] ?? engine }))} />
        </Form.Item>

        <Form.Item
          noStyle
          shouldUpdate={(previous, current) => previous.engine !== current.engine}
        >
          {({ getFieldValue }) => {
            const engine = getFieldValue("engine") ?? "postgres";
            if (engine === "mongodb") {
              return (
                <Fragment>
                  <Form.Item
                    name="uri"
                    label="MongoDB URI"
                    rules={editingConnection?.hasUri ? [] : [{ required: true, message: "请输入 MongoDB URI。" }]}
                  >
                    <Input.Password
                      autoComplete="new-password"
                      placeholder={editingConnection?.hasUri ? "URI 已加密保存，留空则保持不变" : "mongodb://user:password@127.0.0.1:27017/?authSource=admin"}
                    />
                  </Form.Item>
                  <Form.Item name="database" label="默认数据库（可选）">
                    <Input placeholder="也可使用 URI 路径中的数据库名" />
                  </Form.Item>
                  <Alert
                    showIcon
                    type="info"
                    className="security-note"
                    message="MongoDB URI（包含认证信息）由本机系统安全存储加密，解密仅在主进程中进行，不会发送到渲染界面。"
                  />
                </Fragment>
              );
            }
            if (engine === "sqlite") {
              return (
                <Form.Item name="path" label="数据库文件" rules={[{ required: true, message: "请选择或填写 SQLite 数据库文件路径。" }]}>
                  <Input placeholder="C:\\data\\sample.sqlite" />
                </Form.Item>
              );
            }
            const isPostgres = engine === "postgres";
            const isOracle = engine === "oracle";
            return (
              <Fragment>
                <div className="form-grid">
                  <Form.Item name="host" label="主机" rules={[{ required: true }]}>
                    <Input placeholder="127.0.0.1" />
                  </Form.Item>
                  <Form.Item name="port" label="端口" rules={[{ required: true }]}>
                    <InputNumber min={1} max={65535} className="wide-control" />
                  </Form.Item>
                </div>
                <div className="form-grid">
                  <Form.Item
                    name="database"
                    label={isOracle ? "服务名" : "默认数据库"}
                    rules={isPostgres || isOracle ? [{ required: true }] : []}
                  >
                    <Input placeholder={isOracle ? "FREEPDB1" : isPostgres ? "postgres" : "留空以选择数据库"} />
                  </Form.Item>
                  <Form.Item name="user" label="用户名" rules={[{ required: true }]}>
                    <Input placeholder={isPostgres ? "postgres" : isOracle ? "SYSTEM 或普通用户" : "数据库用户"} />
                  </Form.Item>
                </div>
                <Form.Item
                  name="password"
                  label={<span>密码 <Text type="secondary">· 留空保留现有密码</Text></span>}
                  rules={(engine === "oracle" || engine === "sqlserver") && !editingConnection?.hasPassword ? [{ required: true }] : []}
                >
                  <Input.Password
                    autoComplete="new-password"
                    placeholder={editingConnection?.hasPassword ? "已安全保存，留空则保持不变" : "密码将由系统安全存储加密"}
                  />
                </Form.Item>

                {isPostgres && (
                  <Form.Item name="ssl" valuePropName="checked">
                    <Checkbox>使用 SSL/TLS</Checkbox>
                  </Form.Item>
                )}

                {engine === "sqlserver" && (
                  <Fragment>
                    <Form.Item name="encrypt" valuePropName="checked">
                      <Checkbox>加密连接</Checkbox>
                    </Form.Item>
                    <Form.Item name="trustServerCertificate" valuePropName="checked">
                      <Checkbox>信任服务器证书（适用于本地测试证书）</Checkbox>
                    </Form.Item>
                  </Fragment>
                )}

                <Form.Item name={["ssh", "enabled"]} valuePropName="checked">
                  <Checkbox>通过 SSH 隧道连接</Checkbox>
                </Form.Item>
                <Form.Item
                  noStyle
                  shouldUpdate={(previous, current) =>
                    previous.ssh?.enabled !== current.ssh?.enabled
                    || previous.ssh?.authentication !== current.ssh?.authentication
                  }
                >
                  {({ getFieldValue }) => {
                    if (!getFieldValue(["ssh", "enabled"])) return null;
                    const authentication = getFieldValue(["ssh", "authentication"]) ?? "password";
                    const hasCredentials = editingConnection?.engine === engine
                      && editingConnection?.ssh?.authentication === authentication
                      && editingConnection?.ssh?.hasCredentials;
                    return (
                      <div className="ssh-tunnel-form">
                        <div className="form-grid">
                          <Form.Item
                            name={["ssh", "host"]}
                            label="SSH 主机"
                            rules={[{ required: true, message: "请输入 SSH 主机。" }]}
                          >
                            <Input placeholder="bastion.example.com" />
                          </Form.Item>
                          <Form.Item
                            name={["ssh", "port"]}
                            label="SSH 端口"
                            rules={[{ required: true, message: "请输入 SSH 端口。" }]}
                          >
                            <InputNumber min={1} max={65535} className="wide-control" />
                          </Form.Item>
                        </div>
                        <Form.Item
                          name={["ssh", "username"]}
                          label="SSH 用户名"
                          rules={[{ required: true, message: "请输入 SSH 用户名。" }]}
                        >
                          <Input autoComplete="username" />
                        </Form.Item>
                        <Form.Item
                          name={["ssh", "hostFingerprint"]}
                          label="已核验的主机指纹"
                          rules={[{ required: true, message: "请输入服务器 SHA256 主机指纹。" }]}
                        >
                          <Input placeholder="SHA256:…（从可信的服务器管理员或已验证的 known_hosts 获取）" />
                        </Form.Item>
                        <Form.Item name={["ssh", "authentication"]} label="SSH 认证方式" rules={[{ required: true }]}>
                          <Select options={[{ value: "password", label: "密码" }, { value: "privateKey", label: "私钥" }]} />
                        </Form.Item>
                        {authentication === "password" ? (
                          <Form.Item
                            name={["ssh", "password"]}
                            label="SSH 密码"
                            rules={hasCredentials ? [] : [{ required: true, message: "请输入 SSH 密码。" }]}
                          >
                            <Input.Password
                              autoComplete="new-password"
                              placeholder={hasCredentials ? "已安全保存，留空则保持不变" : "SSH 密码将加密保存在本机"}
                            />
                          </Form.Item>
                        ) : (
                          <Fragment>
                            <Form.Item
                              name={["ssh", "privateKey"]}
                              label="SSH 私钥"
                              rules={hasCredentials ? [] : [{ required: true, message: "请输入 SSH 私钥。" }]}
                            >
                              <Input.TextArea
                                rows={4}
                                autoSize={{ minRows: 3, maxRows: 7 }}
                                placeholder={hasCredentials ? "私钥已安全保存，留空则保持不变" : "粘贴 OpenSSH 格式私钥；密钥将加密保存在本机"}
                              />
                            </Form.Item>
                            <Form.Item name={["ssh", "passphrase"]} label="私钥口令（如有）">
                              <Input.Password
                                autoComplete="new-password"
                                placeholder={editingConnection?.engine === engine && editingConnection?.ssh?.hasPassphrase ? "已安全保存，留空则保持不变" : "可留空"}
                              />
                            </Form.Item>
                          </Fragment>
                        )}
                        <Alert
                          showIcon
                          type="info"
                          className="security-note"
                          message="隧道只监听本机 127.0.0.1，并固定转发到上方数据库端点；必须提供已核验的 SHA256 SSH 主机指纹。凭据随连接配置加密保存在本机。"
                        />
                      </div>
                    );
                  }}
                </Form.Item>

                <Alert
                  showIcon
                  type="info"
                  className="security-note"
                  message="连接配置由本机系统安全存储加密后保存在用户目录。"
                />
              </Fragment>
            );
          }}
        </Form.Item>

        <div className="modal-actions">
          <Button onClick={onCancel}>取消</Button>
          <Button type="primary" htmlType="submit">保存连接</Button>
        </div>
      </Form>
    </Modal>
  );
}
