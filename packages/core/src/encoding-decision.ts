// Phase 4.3: first-class encoding candidate workflow. Records a user's
// confirmation decision for an ambiguous encoding so it can be audited and
// reused, instead of silently relying on a heuristic guess.
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

export function createDecisionLedger(existing: EncodingDecision[] = []): DecisionLedger {
  const decisions = new Map<string, EncodingDecision>();
  const key = (file: string, layer?: string) => `${file}\0${layer ?? ""}`;
  for (const decision of existing) decisions.set(key(decision.file, decision.layer), decision);
  return {
    get decisions() { return [...decisions.values()]; },
    upsert(decision) { decisions.set(key(decision.file, decision.layer), decision); },
    find(file, layer) { return decisions.get(key(file, layer)); },
    toJSON() { return JSON.stringify([...decisions.values()], null, 2); },
  };
}

export function needsUserDecision(candidate: EncodingCandidate): boolean {
  if (candidate.source === "metadata" || candidate.source === "format" || candidate.source === "user") return false;
  if (candidate.confidence != null && candidate.confidence >= 0.9) return false;
  return true;
}
