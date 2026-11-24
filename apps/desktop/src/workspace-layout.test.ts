import { describe, expect, it } from "vitest";
import {
  DEFAULT_WORKSPACE_LAYOUT,
  EDITOR_SHARE_MAX,
  EDITOR_SHARE_MIN,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
  WORKSPACE_LAYOUT_STORAGE_KEY,
  loadWorkspaceLayout,
  normalizeWorkspaceLayout,
  saveWorkspaceLayout,
  type WorkspaceLayoutStorage,
} from "./workspace-layout";

function memoryStorage(initial?: string): WorkspaceLayoutStorage & { value: () => string | null } {
  let data = initial ?? null;
  return {
    getItem: () => data,
    setItem: (_key, value) => { data = value; },
    value: () => data,
  };
}

describe("normalizeWorkspaceLayout", () => {
  it("returns defaults for missing or malformed input", () => {
    expect(normalizeWorkspaceLayout(undefined)).toEqual(DEFAULT_WORKSPACE_LAYOUT);
    expect(normalizeWorkspaceLayout(null)).toEqual(DEFAULT_WORKSPACE_LAYOUT);
    expect(normalizeWorkspaceLayout("bad")).toEqual(DEFAULT_WORKSPACE_LAYOUT);
    expect(normalizeWorkspaceLayout([])).toEqual(DEFAULT_WORKSPACE_LAYOUT);
  });

  it("falls back per field and clamps out-of-range values", () => {
    expect(normalizeWorkspaceLayout({ sidebarWidth: 999, editorShare: -3 })).toEqual({
      sidebarWidth: SIDEBAR_WIDTH_MAX,
      editorShare: EDITOR_SHARE_MIN,
    });
    expect(normalizeWorkspaceLayout({ sidebarWidth: -50, editorShare: 5 })).toEqual({
      sidebarWidth: SIDEBAR_WIDTH_MIN,
      editorShare: EDITOR_SHARE_MAX,
    });
    expect(normalizeWorkspaceLayout({ sidebarWidth: 300 })).toEqual({
      sidebarWidth: 300,
      editorShare: DEFAULT_WORKSPACE_LAYOUT.editorShare,
    });
  });

  it("rejects NaN and Infinity", () => {
    expect(normalizeWorkspaceLayout({ sidebarWidth: Number.NaN, editorShare: Number.POSITIVE_INFINITY }))
      .toEqual(DEFAULT_WORKSPACE_LAYOUT);
  });
});

describe("load/save workspace layout", () => {
  it("returns defaults when storage is unavailable", () => {
    expect(loadWorkspaceLayout(undefined)).toEqual(DEFAULT_WORKSPACE_LAYOUT);
  });

  it("returns defaults for unreadable or invalid JSON", () => {
    const broken: WorkspaceLayoutStorage = {
      getItem: () => "{not json",
      setItem: () => { throw new Error("must not write"); },
    };
    expect(loadWorkspaceLayout(broken)).toEqual(DEFAULT_WORKSPACE_LAYOUT);
  });

  it("round-trips normalized values using the stable storage key", () => {
    const storage = memoryStorage();
    saveWorkspaceLayout({ sidebarWidth: 320, editorShare: 0.7 }, storage);
    expect(storage.value()).toBe(JSON.stringify({ sidebarWidth: 320, editorShare: 0.7 }));
    // The key stays stable across versions; old data is tolerated and re-clamped.
    const raw = memoryStorage(JSON.stringify({ sidebarWidth: 10, editorShare: 0.9 }));
    expect(loadWorkspaceLayout(raw)).toEqual({ sidebarWidth: SIDEBAR_WIDTH_MIN, editorShare: EDITOR_SHARE_MAX });
    expect(WORKSPACE_LAYOUT_STORAGE_KEY).toContain("workspace-layout");
  });

  it("never throws when storage rejects writes", () => {
    const readonly: WorkspaceLayoutStorage = {
      getItem: () => null,
      setItem: () => { throw new Error("denied"); },
    };
    expect(() => saveWorkspaceLayout(DEFAULT_WORKSPACE_LAYOUT, readonly)).not.toThrow();
  });
});
