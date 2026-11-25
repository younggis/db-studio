export type ChartKind = "bar" | "line" | "area" | "pie" | "scatter";
export type ChartAggregation = "none" | "sum" | "count" | "avg";
export interface BiWidget {
    id: string;
    title: string;
    type: ChartKind;
    connectionId: string;
    sql: string;
    xField: string;
    yFields: string[];
    aggregation: ChartAggregation;
    createdAt: string;
}
export declare function biStorePath(userDataDir: string): string;
export declare function loadWidgets(userDataDir: string): Promise<BiWidget[]>;
export declare function saveWidgets(userDataDir: string, widgets: BiWidget[]): Promise<void>;
export declare function validateWidget(input: Partial<BiWidget>): BiWidget;
//# sourceMappingURL=bi-store.d.ts.map