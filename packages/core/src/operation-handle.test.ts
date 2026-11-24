import { describe, expect, it } from "vitest";
import { OperationRegistry } from "./operation-handle.js";

function start(registry: OperationRegistry, overrides: Record<string, unknown> = {}) {
  return registry.start({
    id: "op-1",
    type: "gis-import",
    senderId: 7,
    connectionId: "conn-1",
    ...overrides,
  });
}

describe("OperationHandle registry", () => {
  it("registers a handle with a fresh AbortController and running status", () => {
    const registry = new OperationRegistry();
    const handle = start(registry);
    expect(registry.has("op-1")).toBe(true);
    expect(handle.status).toBe("running");
    expect(handle.controller.signal.aborted).toBe(false);
    expect(registry.size).toBe(1);
  });

  it("rejects duplicate IDs and already-aborted parent signals", () => {
    const registry = new OperationRegistry();
    start(registry);
    expect(() => start(registry)).toThrow(/已在使用中/);
    const parent = new AbortController();
    parent.abort();
    expect(() => start(registry, { id: "op-2", signal: parent.signal })).toThrow(/取消/);
    expect(registry.size).toBe(1);
  });

  it("cancels only when the sender owns the operation, exactly once", () => {
    let cancellations = 0;
    const registry = new OperationRegistry({ onCancel: () => { cancellations += 1; } });
    const handle = start(registry);
    expect(registry.cancel("op-1", 8)).toBe(false);
    expect(handle.controller.signal.aborted).toBe(false);
    expect(registry.cancel("op-1", 7)).toBe(true);
    expect(handle.controller.signal.aborted).toBe(true);
    expect(handle.status).toBe("cancelling");
    expect(registry.cancel("op-1", 7)).toBe(false);
    expect(cancellations).toBe(1);
    expect(() => registry.throwIfCancelled(handle)).toThrow(/取消/);
  });

  it("cancels all operations for a connection or sender", () => {
    const registry = new OperationRegistry();
    start(registry, { id: "gis-1", type: "gis-import", senderId: 7, connectionId: "conn-1" });
    start(registry, { id: "ai-1", type: "ai-chat", senderId: 7, connectionId: "conn-1" });
    start(registry, { id: "other", type: "ai-chat", senderId: 7, connectionId: "conn-2" });
    const byConnection = registry.cancelByConnection("conn-1");
    expect(byConnection.map((item) => item.id).sort()).toEqual(["ai-1", "gis-1"]);
    expect(registry.get("other")?.controller.signal.aborted).toBe(false);
    const bySender = registry.cancelBySender(7);
    expect(bySender.map((item) => item.id)).toEqual(["other"]);
  });

  it("finishes only the exact stored handle and records terminal status", () => {
    const registry = new OperationRegistry();
    const handle = start(registry);
    const stale = { ...handle };
    expect(registry.finish("op-1", stale)).toBe(false);
    expect(registry.has("op-1")).toBe(true);
    expect(registry.finish("op-1", handle, "rolled-back")).toBe(true);
    expect(handle.status).toBe("rolled-back");
    expect(registry.size).toBe(0);
  });

  it("tracks progress and detail for the operation report", () => {
    const registry = new OperationRegistry();
    const handle = start(registry);
    handle.progress = 45;
    handle.detail = "batch 2/5";
    expect(registry.get("op-1")?.progress).toBe(45);
    expect(registry.get("op-1")?.detail).toBe("batch 2/5");
  });
});
