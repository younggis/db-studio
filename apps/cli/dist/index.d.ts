#!/usr/bin/env node
import { Command } from "commander";
import { StructuredLogger } from "@db-studio/shared/structured-log";
export declare function createProgram(): Command;
export declare let cliLogger: StructuredLogger;
export declare function configureCliLogger(verbose: boolean): void;
export declare function main(argv?: string[]): Promise<void>;
//# sourceMappingURL=index.d.ts.map