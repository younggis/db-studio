export function createAsyncSerialQueue() {
    let tail = Promise.resolve();
    return function run(operation) {
        const result = tail.then(operation);
        tail = result.then(() => undefined, () => undefined);
        return result;
    };
}
//# sourceMappingURL=async-serial-queue.js.map