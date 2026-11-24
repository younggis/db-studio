export declare function commitConnectionRemoval<T extends {
    id: string;
}>(connections: T[], id: string, cleanup: () => Promise<void>, write: (next: T[]) => Promise<void>): Promise<void>;
//# sourceMappingURL=connection-store-mutations.d.ts.map