import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { CoreService } from "@db-studio/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "./index.js";

const environmentNames = [
  "DBSTUDIO_DATABASE_TYPE", "DBSTUDIO_SQLITE_PATH", "DBSTUDIO_USER_DATA_DIR",
  "MODEL_OPENAI_BASE_URL", "MODEL_OPENAI_MODEL", "MODEL_OPENAI_API_KEY", "MODEL_OPENAI_TEMPERATURE",
  "MODEL_OPENAI_MAX_OUTPUT_TOKENS", "MODEL_OPENAI_TIMEOUT_MS", "MODEL_OPENAI_STREAMING",
  "DBSTUDIO_AI_BASE_URL", "DBSTUDIO_AI_MODEL", "DBSTUDIO_AI_API_KEY",
] as const;
const originalEnvironment = new Map<string, string | undefined>();
let directory: string | undefined;
let mockServer: Server | undefined;

afterEach(async () => {
  for (const name of environmentNames) {
    const original = originalEnvironment.get(name);
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
  }
  originalEnvironment.clear();
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
  if (mockServer) {
    await new Promise<void>((resolve, reject) => {
      mockServer!.close((error) => error ? reject(error) : resolve());
    });
    mockServer = undefined;
  }
  vi.restoreAllMocks();
});

describe("ai sql explain-plan CLI", () => {
  it("interprets a supplied plan without executing the supplied SQL", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "dbstudio-cli-plan-"));
    for (const name of environmentNames) originalEnvironment.set(name, process.env[name]);

    const databasePath = path.join(directory, "acceptance.sqlite");
    const userDataPath = path.join(directory, "user-data");
    const sqlPath = path.join(directory, "query.sql");
    const planPath = path.join(directory, "plan.txt");
    await writeFile(sqlPath, "DELETE FROM cli_plan_guard WHERE id = 1;", "utf8");
    await writeFile(planPath, "SCAN cli_plan_guard; estimated rows: 1", "utf8");

    process.env.DBSTUDIO_DATABASE_TYPE = "sqlite";
    process.env.DBSTUDIO_SQLITE_PATH = databasePath;
    process.env.DBSTUDIO_USER_DATA_DIR = userDataPath;
    const core = CoreService.fromEnvironment();
    await core.query("CREATE TABLE cli_plan_guard (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
    await core.query("INSERT INTO cli_plan_guard (id, value) VALUES (1, 'preserve')");

    let requestBody: { messages?: Array<{ role: string; content: string }> } | undefined;
    let requestCount = 0;
    const modelOutput = JSON.stringify({
      task: "explain-plan", dialect: "SQLite", explanation: "The supplied plan scans the table; its row count is an estimate.",
      referencedObjects: ["main.cli_plan_guard"], assumptions: [], warnings: [],
    });
    mockServer = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
        response.writeHead(404, { connection: "close" });
        response.end();
        return;
      }
      requestCount += 1;
      requestBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as typeof requestBody;
      response.writeHead(200, { "content-type": "application/json", connection: "close" });
      response.end(JSON.stringify({
        id: "local-test", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: modelOutput }, finish_reason: "stop" }],
      }));
    });
    await new Promise<void>((resolve, reject) => {
      mockServer!.once("error", reject);
      mockServer!.listen(0, "127.0.0.1", resolve);
    });
    const address = mockServer.address();
    if (!address || typeof address === "string") throw new Error("Explain-plan CLI local mock server did not bind to TCP.");
    process.env.MODEL_OPENAI_BASE_URL = `http://127.0.0.1:${address.port}/v1`;
    process.env.MODEL_OPENAI_MODEL = "local-test-model";
    delete process.env.MODEL_OPENAI_API_KEY;

    let stdout = "";
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
      stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    }) as typeof process.stdout.write);

    await createProgram().parseAsync([
      "ai", "sql", "explain-plan", "--file", sqlPath, "--plan-file", planPath,
      "--request", "Explain the scan and estimated rows.", "--format", "json",
    ], { from: "user" });

    const output = JSON.parse(stdout) as { result: { explanation: string; sql?: string } };
    expect(output.result.explanation).toContain("scans the table");
    expect(output.result.sql).toBeUndefined();
    expect(requestCount).toBe(1);
    expect(mockServer.listening).toBe(true);
    const submittedContext = JSON.parse(requestBody?.messages?.[1]?.content ?? "{}") as {
      databaseContext?: { selectedSql?: string; executionPlan?: string };
    };
    expect(submittedContext.databaseContext?.selectedSql).toContain("DELETE FROM cli_plan_guard");
    expect(submittedContext.databaseContext?.executionPlan).toContain("SCAN cli_plan_guard");
    const rows = await core.query("SELECT value FROM cli_plan_guard WHERE id = 1");
    expect(rows.rows[0]?.value).toBe("preserve");
  }, 20_000);
});
