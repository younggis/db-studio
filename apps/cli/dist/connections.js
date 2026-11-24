import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { databaseEngines } from "@db-studio/shared";
const CONNECTION_ENV_KEYS = [
    "DBSTUDIO_DATABASE_TYPE", "DATABASE_URL", "DBSTUDIO_DATABASE_URL", "DBSTUDIO_MYSQL_URL", "DBSTUDIO_MARIADB_URL",
    "DBSTUDIO_SQLSERVER_URL", "DBSTUDIO_ORACLE_CONNECT_STRING", "DBSTUDIO_MONGODB_URL", "DBSTUDIO_MONGODB_DATABASE",
    "DBSTUDIO_SQLITE_PATH", "PGHOST", "PGPORT", "PGDATABASE", "PGUSER", "PGPASSWORD", "PGSSLMODE", "PGSERVICE",
    "PGSERVICEFILE", "MYSQL_HOST", "MYSQL_PORT", "MYSQL_USER", "MYSQL_PASSWORD", "MYSQL_DATABASE", "MARIADB_HOST",
    "MARIADB_PORT", "MARIADB_USER", "MARIADB_PASSWORD", "MARIADB_DATABASE", "SQLSERVER_HOST", "SQLSERVER_PORT",
    "SQLSERVER_USER", "SQLSERVER_PASSWORD", "SQLSERVER_DATABASE", "SQLSERVER_ENCRYPT", "SQLSERVER_TRUST_SERVER_CERTIFICATE",
    "ORACLE_USER", "ORACLE_PASSWORD", "ORACLE_HOST", "ORACLE_PORT", "ORACLE_SERVICE_NAME", "ORACLE_CONNECT_STRING",
    "MONGODB_URI", "MONGODB_DATABASE",
];
const PROFILE_FIELDS = new Set([
    "name", "engine", "host", "port", "database", "user", "passwordEnv", "uriEnv", "path", "serviceName",
    "ssl", "encrypt", "trustServerCertificate",
]);
export function connectionProfilesPath(env = process.env) {
    if (env.DBSTUDIO_CONFIG_HOME?.trim())
        return path.join(path.resolve(env.DBSTUDIO_CONFIG_HOME), "connections.json");
    if (process.platform === "win32") {
        return path.join(env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "DB Studio", "CLI", "connections.json");
    }
    if (process.platform === "darwin") {
        return path.join(os.homedir(), "Library", "Application Support", "DB Studio", "CLI", "connections.json");
    }
    return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "db-studio", "connections.json");
}
export async function readConnectionProfiles(env = process.env) {
    let source;
    try {
        source = await readFile(connectionProfilesPath(env), "utf8");
    }
    catch (error) {
        if (isMissingFile(error))
            return [];
        throw error;
    }
    let parsed;
    try {
        parsed = JSON.parse(source);
    }
    catch {
        throw new Error("The CLI connection profile file is not valid JSON.");
    }
    if (!isRecord(parsed) || !Array.isArray(parsed.connections)) {
        throw new Error("The CLI connection profile file has an invalid structure.");
    }
    const profiles = parsed.connections.map((profile) => validateConnectionOptions(profile));
    const names = new Set();
    for (const profile of profiles) {
        if (names.has(profile.name))
            throw new Error("The CLI connection profile file contains duplicate names.");
        names.add(profile.name);
    }
    return profiles;
}
export function validateConnectionOptions(value) {
    const profile = validateStoredProfile(value);
    if (profile.engine === "sqlite") {
        if (!profile.path)
            throw new Error("SQLite profiles require --path.");
    }
    else if (profile.engine === "mongodb") {
        if (!profile.uriEnv)
            throw new Error("MongoDB profiles require --uri-env; the URI value is read from the environment.");
    }
    else {
        if (!profile.host || !profile.user)
            throw new Error(`${profile.engine} profiles require --host and --user.`);
        if (profile.engine === "oracle" && (!profile.passwordEnv || !profile.serviceName)) {
            throw new Error("Oracle profiles require --password-env and --service-name.");
        }
    }
    return profile;
}
export async function addConnectionProfile(options, env = process.env) {
    const profile = validateConnectionOptions(options);
    const profiles = await readConnectionProfiles(env);
    if (profiles.some((item) => item.name === profile.name)) {
        throw new Error(`A CLI connection named '${profile.name}' already exists.`);
    }
    profiles.push(profile);
    await writeConnectionProfiles(profiles, env);
    return profile;
}
export async function updateConnectionProfile(options, env = process.env) {
    const profile = validateConnectionOptions(options);
    const profiles = await readConnectionProfiles(env);
    const index = profiles.findIndex((item) => item.name === profile.name);
    if (index < 0)
        throw new Error(`No CLI connection named '${profile.name}' exists.`);
    profiles[index] = profile;
    await writeConnectionProfiles(profiles, env);
    return profile;
}
export async function removeConnectionProfile(name, env = process.env) {
    const profiles = await readConnectionProfiles(env);
    const remaining = profiles.filter((profile) => profile.name !== name);
    if (remaining.length === profiles.length)
        throw new Error(`No CLI connection named '${name}' exists.`);
    await writeConnectionProfiles(remaining, env);
}
export function connectionSummary(profile) {
    return {
        name: profile.name,
        engine: profile.engine,
        source: "saved",
        configured: true,
        host: profile.host,
        port: profile.port,
        database: profile.database,
        path: profile.path,
        secretSourceConfigured: Boolean(profile.passwordEnv || profile.uriEnv),
    };
}
export async function environmentForConnection(name, base = process.env) {
    if (name === "environment" || name === "default")
        return base;
    const profile = (await readConnectionProfiles(base)).find((item) => item.name === name);
    if (!profile)
        throw new Error(`No CLI connection named '${name}' exists. Run 'dbstudio connections list' to see available connections.`);
    const env = { ...base };
    for (const key of CONNECTION_ENV_KEYS)
        delete env[key];
    const secret = (key) => {
        if (!key)
            return undefined;
        const value = base[key];
        if (value === undefined || value === "")
            throw new Error(`Set environment variable '${key}' for CLI connection '${name}'.`);
        return value;
    };
    const common = { ...env, DBSTUDIO_DATABASE_TYPE: profile.engine };
    switch (profile.engine) {
        case "postgres":
            return withValues(common, {
                PGHOST: profile.host,
                PGPORT: profile.port?.toString(),
                PGDATABASE: profile.database,
                PGUSER: profile.user,
                PGPASSWORD: secret(profile.passwordEnv),
                PGSSLMODE: profile.ssl ? "require" : undefined,
            });
        case "mysql":
            return withValues(common, {
                MYSQL_HOST: profile.host,
                MYSQL_PORT: profile.port?.toString(),
                MYSQL_DATABASE: profile.database,
                MYSQL_USER: profile.user,
                MYSQL_PASSWORD: secret(profile.passwordEnv),
            });
        case "mariadb":
            return withValues(common, {
                MARIADB_HOST: profile.host,
                MARIADB_PORT: profile.port?.toString(),
                MARIADB_DATABASE: profile.database,
                MARIADB_USER: profile.user,
                MARIADB_PASSWORD: secret(profile.passwordEnv),
            });
        case "sqlite":
            return withValues(common, { DBSTUDIO_SQLITE_PATH: profile.path });
        case "sqlserver":
            return withValues(common, {
                SQLSERVER_HOST: profile.host,
                SQLSERVER_PORT: profile.port?.toString(),
                SQLSERVER_DATABASE: profile.database,
                SQLSERVER_USER: profile.user,
                SQLSERVER_PASSWORD: secret(profile.passwordEnv),
                SQLSERVER_ENCRYPT: profile.encrypt?.toString(),
                SQLSERVER_TRUST_SERVER_CERTIFICATE: profile.trustServerCertificate?.toString(),
            });
        case "oracle":
            return withValues(common, {
                ORACLE_HOST: profile.host,
                ORACLE_PORT: profile.port?.toString(),
                ORACLE_SERVICE_NAME: profile.serviceName,
                ORACLE_USER: profile.user,
                ORACLE_PASSWORD: secret(profile.passwordEnv),
            });
        case "mongodb":
            return withValues(common, {
                DBSTUDIO_MONGODB_URL: secret(profile.uriEnv),
                DBSTUDIO_MONGODB_DATABASE: profile.database,
            });
    }
}
export async function applyConnectionEnvironment(name, target = process.env) {
    if (name === "environment" || name === "default")
        return;
    const resolved = await environmentForConnection(name, target);
    for (const key of CONNECTION_ENV_KEYS)
        delete target[key];
    for (const [key, value] of Object.entries(resolved)) {
        if (value !== undefined)
            target[key] = value;
    }
}
async function writeConnectionProfiles(profiles, env) {
    const file = connectionProfilesPath(env);
    const directory = path.dirname(file);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${file}.tmp-${process.pid}`;
    const body = `${JSON.stringify({ version: 1, connections: profiles }, null, 2)}\n`;
    try {
        await writeFile(temporary, body, { encoding: "utf8", mode: 0o600 });
        if (process.platform !== "win32")
            await chmod(temporary, 0o600);
        await renameProfileFile(temporary, file);
        if (process.platform !== "win32")
            await chmod(file, 0o600);
    }
    catch (error) {
        try {
            await rm(temporary, { force: true });
        }
        catch { /* Keep the write error. */ }
        throw error;
    }
}
async function renameProfileFile(source, destination) {
    const retryableWindowsErrors = new Set(["EPERM", "EACCES", "EBUSY"]);
    for (let attempt = 0;; attempt += 1) {
        try {
            await rename(source, destination);
            return;
        }
        catch (error) {
            const code = error.code;
            if (process.platform !== "win32" || !code || !retryableWindowsErrors.has(code) || attempt >= 5) {
                throw error;
            }
            await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** attempt));
        }
    }
}
function validateStoredProfile(value) {
    if (!isRecord(value) || Object.keys(value).some((key) => !PROFILE_FIELDS.has(key))) {
        throw new Error("A CLI connection profile contains unsupported fields; remove any stored credentials and recreate it.");
    }
    const { name, engine } = value;
    if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
        throw new Error("Connection names must be 1 to 64 letters, digits, dots, underscores, or hyphens and start with a letter or digit.");
    }
    if (name === "environment" || name === "default")
        throw new Error(`'${name}' is reserved for the environment connection source.`);
    if (typeof engine !== "string" || !databaseEngines.includes(engine)) {
        throw new Error(`Connection '${name}' has an unsupported database engine.`);
    }
    const profile = { name, engine: engine };
    for (const key of ["host", "database", "user", "passwordEnv", "uriEnv", "path", "serviceName"]) {
        const item = value[key];
        if (item !== undefined) {
            if (typeof item !== "string" || !item.trim())
                throw new Error(`Connection '${name}' has an invalid ${key} value.`);
            profile[key] = item.trim();
        }
    }
    if (value.port !== undefined) {
        if (typeof value.port !== "number" || !Number.isInteger(value.port) || value.port < 1 || value.port > 65_535) {
            throw new Error(`Connection '${name}' has an invalid port.`);
        }
        profile.port = value.port;
    }
    for (const key of ["ssl", "encrypt", "trustServerCertificate"]) {
        const item = value[key];
        if (item !== undefined) {
            if (typeof item !== "boolean")
                throw new Error(`Connection '${name}' has an invalid ${key} setting.`);
            profile[key] = item;
        }
    }
    for (const key of [profile.passwordEnv, profile.uriEnv]) {
        if (key && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
            throw new Error("Secret references must be environment variable names, not credential values.");
        }
    }
    return profile;
}
function withValues(base, values) {
    for (const [key, value] of Object.entries(values)) {
        if (value !== undefined)
            base[key] = value;
    }
    return base;
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isMissingFile(error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
//# sourceMappingURL=connections.js.map