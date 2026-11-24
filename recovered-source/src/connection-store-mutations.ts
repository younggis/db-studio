export async function commitConnectionRemoval<T extends { id: string }>(
  connections: T[],
  id: string,
  cleanup: () => Promise<void>,
  write: (next: T[]) => Promise<void>,
): Promise<void> {
  await cleanup();
  await write(connections.filter((connection) => connection.id !== id));
}