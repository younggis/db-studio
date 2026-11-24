// Phase 1.6: structured, redacted logging shared by CLI and the main process.
// Every record is JSON-serialisable so a failed task can be reproduced from
// its report without leaking credentials, document field values or WKB.

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogRecord {
  timestamp: string;
  level: LogLevel;
  event: string;
  operationId?: string;
  connectionId?: string;
  durationMs?: number;
  detail?: string;
  data?: Record<string, unknown>;
}

const SECRET_KEY = /(api[-_]?key|password|passphrase|private[-_]?key|secret|token|uri|connection[-_]?string)/i;
const WKB_PATTERN = /\b(?:0x)?[0-9a-f]{80,}\b/i;
const LONG_LINE = 4096;

function redactValue(value: unknown): unknown {
  if (typeof value === "string") {
    let text = value.replace(WKB_PATTERN, "[redacted-binary]");
    if (text.length > LONG_LINE) text = `${text.slice(0, LONG_LINE)}…[truncated]`;
    return text;
  }
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === "object") return redactObject(value as Record<string, unknown>);
  return value;
}

function redactObject(value: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    output[key] = SECRET_KEY.test(key) ? "[redacted]" : redactValue(entry);
  }
  return output;
}

export function redactLogData(data: Record<string, unknown> = {}): Record<string, unknown> {
  return redactObject(data);
}

export interface StructuredLoggerOptions {
  now?: () => Date;
  emit?: (line: string) => void;
  minLevel?: LogLevel;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export class StructuredLogger {
  private readonly now: () => Date;
  private readonly emit: (line: string) => void;
  private readonly minLevel: LogLevel;

  constructor(options: StructuredLoggerOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.emit = options.emit ?? ((line) => { process.stderr.write(`${line}\n`); });
    this.minLevel = options.minLevel ?? "info";
  }

  log(level: LogLevel, event: string, fields: Omit<LogRecord, "timestamp" | "level" | "event"> = {}): LogRecord {
    const record: LogRecord = {
      timestamp: this.now().toISOString(),
      level,
      event,
      ...fields,
      data: fields.data ? redactLogData(fields.data) : undefined,
    };
    if (LEVEL_ORDER[level] >= LEVEL_ORDER[this.minLevel]) this.emit(JSON.stringify(record));
    return record;
  }

  debug(event: string, fields?: Omit<LogRecord, "timestamp" | "level" | "event">): LogRecord {
    return this.log("debug", event, fields);
  }

  info(event: string, fields?: Omit<LogRecord, "timestamp" | "level" | "event">): LogRecord {
    return this.log("info", event, fields);
  }

  warn(event: string, fields?: Omit<LogRecord, "timestamp" | "level" | "event">): LogRecord {
    return this.log("warn", event, fields);
  }

  error(event: string, fields?: Omit<LogRecord, "timestamp" | "level" | "event">): LogRecord {
    return this.log("error", event, fields);
  }

  /** Serialise an operation report as stable JSON (already redacted by callers). */
  report(report: unknown): string {
    return JSON.stringify(report, null, 2);
  }
}
