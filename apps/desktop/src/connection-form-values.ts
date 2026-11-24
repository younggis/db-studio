import type { ConnectionSummary, ConnectionValues } from "./ConnectionFormModal";

export function initialConnectionValues(editingConnection?: ConnectionSummary): ConnectionValues {
  if (!editingConnection) {
    return {
      name: "本地 PostgreSQL", engine: "postgres", host: "127.0.0.1", port: 5432,
      database: "postgres", user: "postgres", password: "", ssl: false,
      encrypt: true, trustServerCertificate: true,
      ssh: { enabled: false, port: 22, authentication: "password", password: "", privateKey: "", passphrase: "" },
    };
  }

  return {
    ...editingConnection,
    password: "",
    ssh: editingConnection.ssh ? {
      enabled: true,
      host: editingConnection.ssh.host,
      port: editingConnection.ssh.port,
      username: editingConnection.ssh.username,
      authentication: editingConnection.ssh.authentication,
      hostFingerprint: editingConnection.ssh.hostFingerprint,
      password: "",
      privateKey: "",
      passphrase: "",
    } : { enabled: false, port: 22, authentication: "password", password: "", privateKey: "", passphrase: "" },
  };
}