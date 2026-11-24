export async function commitConnectionRemoval(connections, id, cleanup, write) {
    await cleanup();
    await write(connections.filter((connection) => connection.id !== id));
}
//# sourceMappingURL=connection-store-mutations.js.map