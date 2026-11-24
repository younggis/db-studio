export interface EncodingCandidate {
    file: string;
    layer?: string;
    source: string;
    declared: string | null;
    detected: string | null;
    confidence: number | null;
    previewSample: string[];
}
export interface EncodingDecision {
    file: string;
    layer?: string;
    chosenEncoding: string;
    decidedAt: string;
    basis: "user-confirmed" | "metadata" | "format" | "skipped";
    note?: string;
}
export interface DecisionLedger {
    decisions: EncodingDecision[];
    upsert(decision: EncodingDecision): void;
    find(file: string, layer?: string): EncodingDecision | undefined;
    toJSON(): string;
}
export declare function createDecisionLedger(existing?: EncodingDecision[]): DecisionLedger;
export declare function needsUserDecision(candidate: EncodingCandidate): boolean;
//# sourceMappingURL=encoding-decision.d.ts.map