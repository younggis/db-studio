import { describe, expect, it } from "vitest";
import { sqlServerConfigFromEnvironment } from "./sqlserver.js";

describe("sqlServerConfigFromEnvironment", () => {
  it("reads the SQLSERVER_* connection fields and local certificate defaults", () => {
    expect(sqlServerConfigFromEnvironment({
      SQLSERVER_HOST: "sql.internal",
      SQLSERVER_PORT: "1435",
      SQLSERVER_DATABASE: "gis",
      SQLSERVER_USER: "reader",
      SQLSERVER_PASSWORD: "secret",
    })).toEqual({
      server: "sql.internal",
      port: 1435,
      user: "reader",
      password: "secret",
      database: "gis",
      encrypt: true,
      trustServerCertificate: true,
      connectionTimeout: 10_000,
      requestTimeout: 30_000,
    });
  });

  it("accepts a driver connection string without exposing its credentials", () => {
    expect(sqlServerConfigFromEnvironment({
      DBSTUDIO_SQLSERVER_URL: "Server=localhost,1433;Database=gis;User Id=app;Password=local-only",
    })).toEqual({
      connectionString: "Server=localhost,1433;Database=gis;User Id=app;Password=local-only",
      connectionTimeout: 10_000,
      requestTimeout: 30_000,
    });
  });

  it("validates the port, timeouts, and certificate switches", () => {
    expect(() => sqlServerConfigFromEnvironment({ SQLSERVER_USER: "reader", SQLSERVER_PORT: "0" })).toThrow(/SQLSERVER_PORT/);
    expect(() => sqlServerConfigFromEnvironment({ SQLSERVER_USER: "reader", SQLSERVER_CONNECT_TIMEOUT: "fast" })).toThrow(/SQLSERVER_CONNECT_TIMEOUT/);
    expect(() => sqlServerConfigFromEnvironment({ SQLSERVER_USER: "reader", SQLSERVER_ENCRYPT: "maybe" })).toThrow(/SQLSERVER_ENCRYPT/);
    expect(() => sqlServerConfigFromEnvironment({})).toThrow(/SQLSERVER_USER/);
  });
});
