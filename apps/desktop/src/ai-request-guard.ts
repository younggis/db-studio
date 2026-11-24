// Reconstructed from vendor chunk ai-request-guard-C0ijTAwq.js.
// Tracks one in-flight request per scope; cancelling is idempotent.
export function createAiRequestScope(...parts: unknown[]): string {
  return JSON.stringify(parts);
}

export interface AiRequestLifecycle {
  start(id: string, scope: string): void;
  updateScope(scope: string): boolean;
  cancel(): boolean;
  isActive(id: string): boolean;
  isCurrent(id: string, scope: string): boolean;
  finish(id: string): boolean;
}

export function createAiRequestLifecycle(initialScope: string, onCancel?: (id: string) => void): AiRequestLifecycle {
  let scope = initialScope;
  let activeId: string | undefined;
  function cancel(): boolean {
    if (!activeId) return false;
    const id = activeId;
    activeId = undefined;
    onCancel?.(id);
    return true;
  }
  return {
    start(id, nextScope) {
      if (scope !== nextScope) scope = nextScope;
      cancel();
      activeId = id;
    },
    updateScope(nextScope) {
      if (scope === nextScope) return false;
      scope = nextScope;
      cancel();
      return true;
    },
    cancel,
    isActive(id) { return activeId === id; },
    isCurrent(id, currentScope) { return activeId === id && scope === currentScope; },
    finish(id) {
      if (activeId !== id) return false;
      activeId = undefined;
      return true;
    },
  };
}
