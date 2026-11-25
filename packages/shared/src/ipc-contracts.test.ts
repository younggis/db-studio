import { describe, expect, it } from "vitest";
import { ipcArgSchemas, validateIpcArgs, assertIpcArgs, type IpcChannel } from "./ipc-contracts.js";

const validConnection = {
  name: "Local PG",
  engine: "postgres",
  host: "127.0.0.1",
  port: 5432,
  database: "dbstudio_test",
  user: "dbstudio",
};

describe("IPC argument contracts", () => {
  it("defines a schema for every high-risk channel", () => {
    const channels = Object.keys(ipcArgSchemas);
    expect(channels.length).toBeGreaterThanOrEqual(18);
    expect(channels).toContain("database:query");
    expect(channels).toContain("connections:save");
    expect(channels).toContain("ai:assistant:run");
    expect(channels).toContain("gis:import");
  });

  it("accepts valid arguments for representative channels", () => {
    expect(validateIpcArgs("connections:save", [validConnection])).toBeUndefined();
    expect(validateIpcArgs("database:query", ["conn-1", "SELECT 1", [1, "two"]])).toBeUndefined();
    expect(validateIpcArgs("database:tables", ["conn-1", "public", { limit: 2000 }])).toBeUndefined();
    expect(validateIpcArgs("database:tables", ["conn-1", "public"])).toBeUndefined();
    expect(validateIpcArgs("database:update-rows", ["conn-1", {
      schema: "public", table: "orders",
      changes: [{ primaryKeyValues: { id: 1 }, values: { name: "x" } }],
    }])).toBeUndefined();
    expect(validateIpcArgs("mongo:aggregate", ["conn-1", "db", "c", [{ $limit: 10 }], 100])).toBeUndefined();
    expect(validateIpcArgs("mongo:delete-document", ["conn-1", "db", "c", '{"_id":1}'])).toBeUndefined();
    expect(validateIpcArgs("mongo:replace-document", ["conn-1", "db", "c", '{"_id":1}', '{"name":"x"}'])).toBeUndefined();
  });

  it("rejects invalid identifiers, engines and unknown fields with structured issues", () => {
    const empty = validateIpcArgs("connections:remove", [""]);
    expect(empty?.channel).toBe("connections:remove");
    expect(empty?.issues[0]?.path).toBe("0");

    const badEngine = validateIpcArgs("connections:save", [{ ...validConnection, engine: "db2" }]);
    expect(badEngine?.issues.some((issue) => issue.message.includes("postgres"))).toBe(true);

    const unknownField = validateIpcArgs("connections:save", [{ ...validConnection, bogus: true }]);
    expect(unknownField).toBeDefined();
    expect(unknownField?.issues.some((issue) => /bogus|unrecognized/i.test(issue.message))).toBe(true);
  });

  it("rejects oversized batches and out-of-range ports", () => {
    expect(validateIpcArgs("database:query", ["conn-1", "SELECT 1", new Array(2001).fill(1)]))?.toBeDefined();
    const badPort = validateIpcArgs("connections:save", [{ ...validConnection, port: 99999 }]);
    expect(badPort).toBeDefined();
    const tooManyChanges = validateIpcArgs("database:update-rows", ["conn-1", {
      schema: "public", table: "orders", changes: new Array(101).fill({ primaryKeyValues: { id: 1 }, values: {} }),
    }]);
    expect(tooManyChanges).toBeDefined();
  });

  it("assertIpcArgs throws a structured, readable error", () => {
    expect(() => assertIpcArgs("connections:remove", [""])).toThrow(/Invalid IPC arguments.*connections:remove/);
  });

  it("keeps channel names in sync with the schema map type", () => {
    const channel: IpcChannel = "database:query";
    expect(Object.keys(ipcArgSchemas)).toContain(channel);
  });
});
