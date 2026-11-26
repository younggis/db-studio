// Minimal reconstruction of the workspace store used by the legacy App.tsx.
// The current compiled shell keeps this state inside its bundle; this module
// mirrors the observable shape so the source App can be type-checked/port.
import { createStore } from "zustand/vanilla";
import { useStore } from "zustand";

export type WorkspacePage = "query" | "mongo" | "gis";

export interface WorkspaceState {
  page: WorkspacePage;
  sql: string;
  sqlPath: string | null;
  result: import("@db-studio/shared").QueryResult | undefined;
  setPage: (page: WorkspacePage) => void;
  setSql: (sql: string) => void;
  setSqlPath: (path: string | null) => void;
  setResult: (result: WorkspaceState["result"]) => void;
}

export const workspaceStore = createStore<WorkspaceState>((set) => ({
  page: "query",
  sql: "",
  sqlPath: null,
  result: undefined,
  setPage: (page) => set({ page }),
  setSql: (sql) => set({ sql }),
  setSqlPath: (sqlPath) => set({ sqlPath }),
  setResult: (result) => set({ result }),
}));

export function useWorkspaceStore<T>(selector: (state: WorkspaceState) => T): T {
  return useStore(workspaceStore, selector);
}

useWorkspaceStore.getState = workspaceStore.getState;
useWorkspaceStore.setState = workspaceStore.setState;
useWorkspaceStore.subscribe = workspaceStore.subscribe;
