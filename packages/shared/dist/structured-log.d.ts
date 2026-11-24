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
export declare function redactLogData(data?: Record<string, unknown>): Record<string, unknown>;
export interface StructuredLoggerOptions {
    now?: () => Date;
    emit?: (line: string) => void;
    minLevel?: LogLevel;
}
export declare class StructuredLogger {
    private readonly now;
    private readonly emit;
    private readonly minLevel;
    constructor(options?: StructuredLoggerOptions);
    log(level: LogLevel, event: string, fields?: Omit<LogRecord, "timestamp" | "level" | "event">): LogRecord;
    debug(event: string, fields?: Omit<LogRecord, "timestamp" | "level" | "event">): LogRecord;
    info(event: string, fields?: Omit<LogRecord, "timestamp" | "level" | "event">): LogRecord;
    warn(event: string, fields?: Omit<LogRecord, "timestamp" | "level" | "event">): LogRecord;
    error(event: string, fields?: Omit<LogRecord, "timestamp" | "level" | "event">): LogRecord;
    /** Serialise an operation report as stable JSON (already redacted by callers). */
    report(report: unknown): string;
}
//# sourceMappingURL=structured-log.d.ts.map