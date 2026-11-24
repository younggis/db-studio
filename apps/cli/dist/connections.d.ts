import { type DatabaseEngine } from "@db-studio/shared";
export interface CliConnectionProfile {
    name: string;
    engine: DatabaseEngine;
    host?: string;
    port?: number;
    database?: string;
    user?: string;
    passwordEnv?: string;
    uriEnv?: string;
    path?: string;
    serviceName?: string;
    ssl?: boolean;
    encrypt?: boolean;
    trustServerCertificate?: boolean;
}
export interface CliConnectionOptions {
    name: string;
    engine: DatabaseEngine;
    host?: string;
    port?: number;
    database?: string;
    user?: string;
    passwordEnv?: string;
    uriEnv?: string;
    path?: string;
    serviceName?: string;
    ssl?: boolean;
    encrypt?: boolean;
    trustServerCertificate?: boolean;
}
export declare function connectionProfilesPath(env?: NodeJS.ProcessEnv): string;
export declare function readConnectionProfiles(env?: NodeJS.ProcessEnv): Promise<CliConnectionProfile[]>;
export declare function validateConnectionOptions(value: CliConnectionOptions): CliConnectionProfile;
export declare function addConnectionProfile(options: CliConnectionOptions, env?: NodeJS.ProcessEnv): Promise<CliConnectionProfile>;
export declare function updateConnectionProfile(options: CliConnectionOptions, env?: NodeJS.ProcessEnv): Promise<CliConnectionProfile>;
export declare function removeConnectionProfile(name: string, env?: NodeJS.ProcessEnv): Promise<void>;
export declare function connectionSummary(profile: CliConnectionProfile): Record<string, unknown>;
export declare function environmentForConnection(name: string, base?: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv>;
export declare function applyConnectionEnvironment(name: string, target?: NodeJS.ProcessEnv): Promise<void>;
//# sourceMappingURL=connections.d.ts.map