import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  addConnectionProfile,
  connectionProfilesPath,
  environmentForConnection,
  readConnectionProfiles,
  removeConnectionProfile,
  updateConnectionProfile,
} from "./connections.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function profileEnvironment(extra: NodeJS.ProcessEnv = {}): Promise<NodeJS.ProcessEnv> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dbstudio-cli-connections-"));
  temporaryDirectories.push(directory);
  return { DBSTUDIO_CONFIG_HOME: directory, ...extra };
}

describe("CLI saved connection profiles", () => {
  it("stores only profile metadata and secret variable names with private file permissions", async () => {
    const env = await profileEnvironment({ PROFILE_TEST_PASSWORD: "never-write-this" });
    const profile = await addConnectionProfile({
      name: "local-pg", engine: "postgres", host: "127.0.0.1", port: 5432,
      database: "demo", user: "reader", passwordEnv: "PROFILE_TEST_PASSWORD", ssl: true,
    }, env);

    expect(profile.name).toBe("local-pg");
    const contents = await readFile(connectionProfilesPath(env), "utf8");
    expect(contents).toContain("PROFILE_TEST_PASSWORD");
    expect(contents).not.toContain("never-write-this");
    expect(contents).not.toMatch(/"password"\s*:/i);
    if (process.platform !== "win32") expect((await stat(connectionProfilesPath(env))).mode & 0o777).toBe(0o600);

    const selected = await environmentForConnection("local-pg", env);
    expect(selected).toMatchObject({
      DBSTUDIO_DATABASE_TYPE: "postgres", PGHOST: "127.0.0.1", PGPORT: "5432", PGDATABASE: "demo",
      PGUSER: "reader", PGPASSWORD: "never-write-this", PGSSLMODE: "require",
    });
  });

  it("supports replacing and removing a saved profile", async () => {
    const env = await profileEnvironment({ DB_PASS: "secret" });
    await addConnectionProfile({ name: "sqlite-dev", engine: "sqlite", path: ":memory:" }, env);
    await updateConnectionProfile({ name: "sqlite-dev", engine: "sqlite", path: "./workspace.db" }, env);

    expect((await environmentForConnection("sqlite-dev", env)).DBSTUDIO_SQLITE_PATH).toBe("./workspace.db");
    await removeConnectionProfile("sqlite-dev", env);
    expect(await readConnectionProfiles(env)).toEqual([]);
  });

  it("reads MongoDB credentials from the referenced environment variable", async () => {
    const env = await profileEnvironment({ MONGO_TEST_URI: "mongodb://user:secret@localhost:27017/app" });
    await addConnectionProfile({
      name: "mongo-local", engine: "mongodb", uriEnv: "MONGO_TEST_URI", database: "app",
    }, env);

    const selected = await environmentForConnection("mongo-local", env);
    expect(selected.DBSTUDIO_DATABASE_TYPE).toBe("mongodb");
    expect(selected.DBSTUDIO_MONGODB_URL).toBe(env.MONGO_TEST_URI);
    expect(await readFile(connectionProfilesPath(env), "utf8")).not.toContain("user:secret");
  });

  it.each([
    {
      name: "mysql-local", engine: "mysql" as const, host: "db.local", user: "reader", passwordEnv: "DB_PASS",
      expected: { MYSQL_HOST: "db.local", MYSQL_USER: "reader", MYSQL_PASSWORD: "secret" },
    },
    {
      name: "mariadb-local", engine: "mariadb" as const, host: "db.local", user: "reader", passwordEnv: "DB_PASS",
      expected: { MARIADB_HOST: "db.local", MARIADB_USER: "reader", MARIADB_PASSWORD: "secret" },
    },
    {
      name: "sqlserver-local", engine: "sqlserver" as const, host: "db.local", user: "reader", passwordEnv: "DB_PASS",
      expected: { SQLSERVER_HOST: "db.local", SQLSERVER_USER: "reader", SQLSERVER_PASSWORD: "secret" },
    },
    {
      name: "oracle-local", engine: "oracle" as const, host: "db.local", serviceName: "FREEPDB1", user: "reader", passwordEnv: "DB_PASS",
      expected: { ORACLE_HOST: "db.local", ORACLE_SERVICE_NAME: "FREEPDB1", ORACLE_USER: "reader", ORACLE_PASSWORD: "secret" },
    },
  ])("maps $engine profile settings to only that adapter's environment", async (profile) => {
    const env = await profileEnvironment({ DB_PASS: "secret", DATABASE_URL: "postgres://stale", PGHOST: "stale-host" });
    const { expected, ...connection } = profile;
    await addConnectionProfile(connection, env);

    const selected = await environmentForConnection(profile.name, env);
    expect(selected.DBSTUDIO_DATABASE_TYPE).toBe(profile.engine);
    expect(selected).toMatchObject(expected);
    expect(selected.DATABASE_URL).toBeUndefined();
    expect(selected.PGHOST).toBeUndefined();
  });

  it("rejects missing secret environment values without including credential data in errors", async () => {
    const env = await profileEnvironment();
    await addConnectionProfile({
      name: "needs-secret", engine: "postgres", host: "db.local", user: "reader", passwordEnv: "PG_PROFILE_SECRET",
    }, env);

    await expect(environmentForConnection("needs-secret", env)).rejects.toThrow("PG_PROFILE_SECRET");
    await expect(environmentForConnection("unknown", env)).rejects.toThrow("No CLI connection named 'unknown'");
  });
});
