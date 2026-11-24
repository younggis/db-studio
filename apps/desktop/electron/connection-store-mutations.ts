// RECONSTRUCTED from dist/electron/connection-store-mutations.js (tsc output of the lost source).
// @ts-nocheck -- temporary: original type annotations were not preserved in the build output.
export async function commitConnectionRemoval(connections, id, cleanup, write) {
    await cleanup();
    await write(connections.filter((connection) => connection.id !== id));
}
//# sourceMappingURL=connection-store-mutations.js.map