export interface WorkspaceLayoutPreferences {
  sidebarWidth: number;
  editorShare: number;
}

export interface WorkspaceLayoutStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const WORKSPACE_LAYOUT_STORAGE_KEY = "db-studio:workspace-layout:v1";
export const DEFAULT_WORKSPACE_LAYOUT: WorkspaceLayoutPreferences = {
  sidebarWidth: 258,
  editorShare: 0.56,
};

export const SIDEBAR_WIDTH_MIN = 210;
export const SIDEBAR_WIDTH_MAX = 440;
export const EDITOR_SHARE_MIN = 0.2;
export const EDITOR_SHARE_MAX = 0.8;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function browserStorage(): WorkspaceLayoutStorage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export function normalizeWorkspaceLayout(value: unknown): WorkspaceLayoutPreferences {
  if (!value || typeof value !== "object") return { ...DEFAULT_WORKSPACE_LAYOUT };
  const candidate = value as Partial<WorkspaceLayoutPreferences>;
  const sidebarWidth = typeof candidate.sidebarWidth === "number" && Number.isFinite(candidate.sidebarWidth)
    ? clamp(candidate.sidebarWidth, SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_MAX)
    : DEFAULT_WORKSPACE_LAYOUT.sidebarWidth;
  const editorShare = typeof candidate.editorShare === "number" && Number.isFinite(candidate.editorShare)
    ? clamp(candidate.editorShare, EDITOR_SHARE_MIN, EDITOR_SHARE_MAX)
    : DEFAULT_WORKSPACE_LAYOUT.editorShare;
  return { sidebarWidth, editorShare };
}

export function loadWorkspaceLayout(storage: WorkspaceLayoutStorage | undefined = browserStorage()): WorkspaceLayoutPreferences {
  if (!storage) return { ...DEFAULT_WORKSPACE_LAYOUT };
  try {
    const stored = storage.getItem(WORKSPACE_LAYOUT_STORAGE_KEY);
    return stored ? normalizeWorkspaceLayout(JSON.parse(stored) as unknown) : { ...DEFAULT_WORKSPACE_LAYOUT };
  } catch {
    return { ...DEFAULT_WORKSPACE_LAYOUT };
  }
}

export function saveWorkspaceLayout(
  layout: WorkspaceLayoutPreferences,
  storage: WorkspaceLayoutStorage | undefined = browserStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(WORKSPACE_LAYOUT_STORAGE_KEY, JSON.stringify(normalizeWorkspaceLayout(layout)));
  } catch {
    // Layout preferences are optional; storage restrictions should not block the workspace.
  }
}