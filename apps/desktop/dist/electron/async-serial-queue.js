// RECONSTRUCTED from dist/electron/async-serial-queue.js (tsc output of the lost source).
// @ts-nocheck -- temporary: original type annotations were not preserved in the build output.
export function createAsyncSerialQueue() {
    let tail = Promise.resolve();
    return function run(operation) {
        const result = tail.then(operation);
        tail = result.then(() => undefined, () => undefined);
        return result;
    };
}
//# sourceMappingURL=async-serial-queue.js.map
//# sourceMappingURL=async-serial-queue.js.map