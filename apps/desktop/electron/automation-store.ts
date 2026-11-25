// Persistent automation jobs and scheduling helpers (no Electron imports so it
// can be unit-tested). Jobs are stored as JSON in the app's userData folder.
import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

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

export function automationStorePath(userDataDir: string): string {
  return path.join(userDataDir, "automation-jobs.json");
}

export async function loadAutomationJobs(userDataDir: string): Promise<AutomationJob[]> {
  try {
    const content = await readFile(automationStorePath(userDataDir), "utf8");
    const parsed: unknown = JSON.parse(content);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is AutomationJob =>
      !!item && typeof item === "object" && typeof (item as AutomationJob).id === "string"
      && typeof (item as AutomationJob).connectionId === "string");
  } catch {
    return [];
  }
}

export async function saveAutomationJobs(userDataDir: string, jobs: AutomationJob[]): Promise<void> {
  await writeFile(automationStorePath(userDataDir), JSON.stringify(jobs, null, 2), "utf8");
}

export function isJobDue(job: AutomationJob, now = Date.now()): boolean {
  if (!job.enabled || job.intervalMinutes <= 0) return false;
  if (!job.lastRunAt) return true;
  const elapsed = now - new Date(job.lastRunAt).getTime();
  return Number.isFinite(elapsed) && elapsed >= job.intervalMinutes * 60_000;
}

export function validateJob(input: Partial<AutomationJob>): AutomationJob {
  const name = String(input.name ?? "").trim();
  const connectionId = String(input.connectionId ?? "").trim();
  if (!name || name.length > 200) throw new Error("任务名称无效。");
  if (!connectionId || connectionId.length > 200) throw new Error("请选择连接。");
  const type = input.type === "query" ? "query" : "backup";
  const intervalMinutes = Math.min(Math.max(Math.floor(Number(input.intervalMinutes) || 0), 0), 60 * 24 * 30);
  if (type === "backup" && !String(input.schema ?? "").trim()) throw new Error("备份任务需要 Schema。");
  if (type === "query" && !String(input.sql ?? "").trim()) throw new Error("查询任务需要 SQL。");
  return {
    id: String(input.id ?? "") || randomUUID(),
    name, type, connectionId,
    schema: String(input.schema ?? "").trim() || undefined,
    sql: type === "query" ? String(input.sql ?? "") : undefined,
    outputPath: String(input.outputPath ?? "").trim() || undefined,
    includeData: input.includeData !== false,
    intervalMinutes,
    enabled: input.enabled !== false,
    createdAt: String(input.createdAt ?? new Date().toISOString()),
    lastRunAt: input.lastRunAt,
    lastStatus: input.lastStatus,
    lastError: input.lastError,
  };
}
