// Advisory string fields (warnings / assumptions / referencedObjects) must not
// fail an otherwise safe, validated SQL draft. Some OpenAI-compatible models
// return a single string, an object with a message field, or mixed arrays.
// Normalise to a bounded string[] instead of throwing.
const OBJECT_KEYS = ["message", "text", "reason", "warning", "description", "detail", "value"];
function toStringItem(value, maxChars) {
    if (value === null || value === undefined)
        return undefined;
    if (typeof value === "string") {
        const trimmed = value.trim();
        return trimmed ? trimmed.slice(0, maxChars) : undefined;
    }
    if (typeof value === "number" || typeof value === "boolean")
        return String(value);
    if (typeof value === "object" && !Array.isArray(value)) {
        const record = value;
        for (const key of OBJECT_KEYS) {
            if (typeof record[key] === "string")
                return toStringItem(record[key], maxChars);
        }
        // last resort: JSON stringify a small object, bounded
        try {
            const json = JSON.stringify(value);
            return json.slice(0, maxChars);
        }
        catch {
            return undefined;
        }
    }
    return undefined;
}
export function normalizeAdvisoryList(value, options = {}) {
    const maxItems = options.maxItems ?? 30;
    const maxChars = options.maxChars ?? 300;
    if (value === null || value === undefined)
        return [];
    const values = Array.isArray(value) ? value : [value];
    const output = [];
    for (const item of values) {
        if (output.length >= maxItems)
            break;
        const text = toStringItem(item, maxChars);
        if (text)
            output.push(text);
    }
    return output;
}
//# sourceMappingURL=advisory-list.js.map