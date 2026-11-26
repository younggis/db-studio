// Merge AI-generated SQL into the current editor text without destroying it.
export function appendAssistantSql(current: string, incoming: string): string {
  const head = current.trimEnd();
  const addition = incoming.trim();
  if (!head) return addition;
  if (!addition) return head;
  return `${head}\n\n${addition}\n`;
}
