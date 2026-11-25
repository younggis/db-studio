export type AutomationJobType = "backup" | "query";
export interface AutomationJob {
    id: string;
    name: string;
    type: AutomationJobType;
    connectionId: string;
    schema?: string;
    sql?: string;
    outputPath?: string;
    includeData?: boolean;
    intervalMinutes: number;
    enabled: boolean;
    createdAt: string;
    lastRunAt?: string;
    lastStatus?: "success" | "failed";
    lastError?: string;
}
export declare function automationStorePath(userDataDir: string): string;
export declare function loadAutomationJobs(userDataDir: string): Promise<AutomationJob[]>;
export declare function saveAutomationJobs(userDataDir: string, jobs: AutomationJob[]): Promise<void>;
export declare function isJobDue(job: AutomationJob, now?: number): boolean;
export declare function validateJob(input: Partial<AutomationJob>): AutomationJob;
//# sourceMappingURL=automation-store.d.ts.map