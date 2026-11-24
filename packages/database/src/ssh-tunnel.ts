import { createHash } from "node:crypto";
import { createServer, type AddressInfo, type Server, type Socket } from "node:net";
import ssh2 from "ssh2";

const { Client } = ssh2;
const LOOPBACK = "127.0.0.1" as const;
const MAX_FORWARDED_SOCKETS = 64;

export type SshAuthenticationMethod = "password" | "privateKey";

export interface SshTunnelConfig {
  host: string;
  port: number;
  username: string;
  authentication: SshAuthenticationMethod;
  hostFingerprint: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
}

export interface SshTunnelTarget {
  host: string;
  port: number;
}

export interface SshTunnelEndpoint {
  host: typeof LOOPBACK;
  port: number;
}

export function validateSshTunnelConfig(value: SshTunnelConfig): SshTunnelConfig {
  const host = value.host.trim();
  const username = value.username.trim();
  if (!host || host.length > 255 || /[\s/\\]/.test(host)) {
    throw new Error("SSH 主机名无效。");
  }
  if (!username || username.length > 256) throw new Error("SSH 用户名无效。");
  if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535) {
    throw new Error("SSH 端口必须是 1 到 65535 之间的整数。");
  }
  if (value.authentication !== "password" && value.authentication !== "privateKey") {
    throw new Error("SSH 认证方式无效。");
  }
  const hostFingerprint = normalizeSshFingerprint(value.hostFingerprint);
  if (value.authentication === "password") {
    if (!value.password?.trim()) throw new Error("SSH 密码不能为空。");
    return { ...value, host, username, hostFingerprint, privateKey: undefined, passphrase: undefined };
  }
  if (!value.privateKey?.trim()) throw new Error("SSH 私钥不能为空。");
  if (value.privateKey.length > 64_000) throw new Error("SSH 私钥不能超过 64,000 个字符。");
  return { ...value, host, username, hostFingerprint, password: undefined };
}

export function normalizeSshFingerprint(value: string): string {
  const fingerprint = value.trim().replace(/=+$/, "");
  if (!/^SHA256:[A-Za-z0-9+/]{43}$/.test(fingerprint)) {
    throw new Error("请输入 OpenSSH 格式的 SHA256 主机指纹（SHA256:…）。");
  }
  return fingerprint;
}

export function fingerprintFromSsh2HostHash(value: string | Buffer): string {
  const digest = Buffer.isBuffer(value)
    ? createHash("sha256").update(value).digest()
    : Buffer.from(value, "hex");
  return `SHA256:${digest.toString("base64").replace(/=+$/, "")}`;
}

export class SshTunnelManager {
  private readonly entries = new Map<string, { signature: string; tunnel: SshTunnel }>();
  private readonly operations = new Map<string, Promise<unknown>>();
  private closing = false;
  private closeAllPromise?: Promise<void>;

  get activeCount(): number {
    return this.entries.size;
  }

  get pendingCount(): number {
    return this.operations.size;
  }

  async endpointFor(
    connectionId: string,
    config: SshTunnelConfig,
    target: SshTunnelTarget,
  ): Promise<SshTunnelEndpoint> {
    if (this.closing) throw new Error("SSH 隧道管理器正在关闭。");
    const normalized = validateSshTunnelConfig(config);
    const normalizedTarget = validateSshTarget(target);
    const signature = createHash("sha256")
      .update(JSON.stringify([normalized, normalizedTarget]))
      .digest("hex");
    return this.enqueue(connectionId, async () => {
      const current = this.entries.get(connectionId);
      if (current?.signature === signature && current.tunnel.isOpen) return current.tunnel.endpoint;
      if (current) {
        this.entries.delete(connectionId);
        await current.tunnel.close();
      }
      const tunnel = await SshTunnel.open(normalized, normalizedTarget);
      this.entries.set(connectionId, { signature, tunnel });
      return tunnel.endpoint;
    });
  }

  close(connectionId: string): Promise<void> {
    return this.enqueue(connectionId, async () => {
      const entry = this.entries.get(connectionId);
      if (!entry) return;
      this.entries.delete(connectionId);
      await entry.tunnel.close();
    });
  }

  closeAll(): Promise<void> {
    if (this.closeAllPromise) return this.closeAllPromise;
    this.closing = true;
    this.closeAllPromise = (async () => {
      await Promise.all([...this.operations.values()].map((operation) => operation.catch(() => undefined)));
      const entries = [...this.entries.values()];
      this.entries.clear();
      await Promise.all(entries.map(({ tunnel }) => tunnel.close()));
    })();
    return this.closeAllPromise;
  }

  private enqueue<T>(connectionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.operations.get(connectionId);
    const current = (previous ? previous.catch(() => undefined) : Promise.resolve()).then(operation);
    this.operations.set(connectionId, current);
    void current.finally(() => {
      if (this.operations.get(connectionId) === current) this.operations.delete(connectionId);
    }).catch(() => undefined);
    return current;
  }
}

class SshTunnel {
  readonly endpoint: SshTunnelEndpoint;
  private open = true;

  private constructor(
    private readonly server: Server,
    private readonly client: InstanceType<typeof Client>,
    private readonly sockets: Set<Socket>,
    endpoint: SshTunnelEndpoint,
  ) {
    this.endpoint = endpoint;
    this.client.on("error", () => this.markClosed());
    this.client.on("close", () => this.markClosed());
    this.client.on("end", () => this.markClosed());
    this.server.on("error", () => this.markClosed());
  }

  get isOpen(): boolean {
    return this.open;
  }

  static async open(config: SshTunnelConfig, target: SshTunnelTarget): Promise<SshTunnel> {
    const client = new Client();
    const sockets = new Set<Socket>();
    const server = createServer({ allowHalfOpen: true }, (socket) => {
      if (sockets.size >= MAX_FORWARDED_SOCKETS) {
        socket.destroy();
        return;
      }
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      client.forwardOut(
        socket.remoteAddress ?? LOOPBACK,
        socket.remotePort ?? 0,
        target.host,
        target.port,
        (error, channel) => {
          if (error || !channel) {
            socket.destroy();
            return;
          }
          channel.once("close", () => socket.end());
          channel.once("error", () => socket.destroy());
          socket.once("error", () => channel.destroy());
          socket.once("close", () => channel.destroy());
          socket.pipe(channel).pipe(socket);
        },
      );
    });

    await listenLoopback(server);
    const address = server.address() as AddressInfo;
    try {
      await connectSsh(client, config);
      return new SshTunnel(server, client, sockets, { host: LOOPBACK, port: address.port });
    } catch (error) {
      await closeServer(server, sockets);
      client.end();
      throw error;
    }
  }

  async close(): Promise<void> {
    if (!this.open && !this.server.listening) return;
    this.open = false;
    for (const socket of this.sockets) socket.destroy();
    this.client.end();
    await closeServer(this.server, this.sockets);
  }

  private markClosed(): void {
    if (!this.open) return;
    this.open = false;
    for (const socket of this.sockets) socket.destroy();
    if (this.server.listening) this.server.close();
  }
}

function validateSshTarget(value: SshTunnelTarget): SshTunnelTarget {
  const host = value.host.trim();
  if (!host || host.length > 255 || /[\s/\\]/.test(host)) throw new Error("SSH 转发目标主机无效。");
  if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535) {
    throw new Error("SSH 转发目标端口必须是 1 到 65535 之间的整数。");
  }
  return { host, port: value.port };
}

function listenLoopback(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.removeListener("listening", onListening);
      reject(new Error(`无法启动 SSH 本地转发：${error.message}`));
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, LOOPBACK);
  });
}

async function closeServer(server: Server, sockets: Set<Socket>): Promise<void> {
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function connectSsh(client: InstanceType<typeof Client>, config: SshTunnelConfig): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let fingerprintMismatch = false;
    const timeout = setTimeout(() => fail(new Error("SSH 连接超时。")), 15_000);
    const cleanup = () => {
      clearTimeout(timeout);
      client.removeListener("ready", onReady);
      client.removeListener("error", onError);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(fingerprintMismatch ? new Error("SSH 主机指纹不匹配；请核验服务器指纹后重试。") : error);
    };
    const onReady = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const onError = (error: Error) => fail(error);
    client.once("ready", onReady);
    client.once("error", onError);
    client.connect({
      host: config.host,
      port: config.port,
      username: config.username,
      ...(config.authentication === "password"
        ? { password: config.password }
        : { privateKey: config.privateKey, passphrase: config.passphrase }),
      hostHash: "sha256",
      hostVerifier: (key: Buffer | string) => {
        const actual = fingerprintFromSsh2HostHash(key);
        const accepted = actual === config.hostFingerprint;
        if (!accepted) fingerprintMismatch = true;
        return accepted;
      },
      readyTimeout: 15_000,
      keepaliveInterval: 15_000,
      keepaliveCountMax: 3,
    });
  });
}
