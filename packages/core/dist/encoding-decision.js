export function createDecisionLedger(existing = []) {
    const decisions = new Map();
    const key = (file, layer) => `${file}\0${layer ?? ""}`;
    for (const decision of existing)
        decisions.set(key(decision.file, decision.layer), decision);
    return {
        get decisions() { return [...decisions.values()]; },
        upsert(decision) { decisions.set(key(decision.file, decision.layer), decision); },
        find(file, layer) { return decisions.get(key(file, layer)); },
        toJSON() { return JSON.stringify([...decisions.values()], null, 2); },
    };
}
export function needsUserDecision(candidate) {
    if (candidate.source === "metadata" || candidate.source === "format" || candidate.source === "user")
        return false;
    if (candidate.confidence != null && candidate.confidence >= 0.9)
        return false;
    return true;
}
//# sourceMappingURL=encoding-decision.js.map