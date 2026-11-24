declare const LOOPBACK: "127.0.0.1";
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
export declare function validateSshTunnelConfig(value: SshTunnelConfig): SshTunnelConfig;
export declare function normalizeSshFingerprint(value: string): string;
export declare function fingerprintFromSsh2HostHash(value: string | Buffer): string;
export declare class SshTunnelManager {
    private readonly entries;
    private readonly operations;
    private closing;
    private closeAllPromise?;
    get activeCount(): number;
    get pendingCount(): number;
    endpointFor(connectionId: string, config: SshTunnelConfig, target: SshTunnelTarget): Promise<SshTunnelEndpoint>;
    close(connectionId: string): Promise<void>;
    closeAll(): Promise<void>;
    private enqueue;
}
export {};
//# sourceMappingURL=ssh-tunnel.d.ts.map