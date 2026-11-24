import { describe, expect, it } from "vitest";
import { Readable, Writable } from "node:stream";
import type { QueryResultBatch } from "@db-studio/shared";
import { formatQueryResult, writeQueryResultNdjsonStream } from "./format.js";

const result = {
  columns: ["id", "name", "active"],
  rows: [
    { id: 1, name: 'A,"B"', active: true },
    { id: 2, name: "second line\ncontinued", active: null },
  ],
  rowCount: 2,
};

describe("formatQueryResult", () => {
  it("escapes CSV values and preserves nulls as empty cells", () => {
    expect(formatQueryResult(result, "csv")).toBe(
      'id,name,active\n1,"A,""B""",true\n2,"second line\ncontinued",',
    );
  });

  it("renders one JSON document with column and row metadata", () => {
    expect(JSON.parse(formatQueryResult(result, "json"))).toEqual(result);
  });

  it("renders one JSON value per line for NDJSON", () => {
    expect(formatQueryResult(result, "ndjson").split("\n").map((line) => JSON.parse(line))).toEqual(result.rows);
  });

  it("renders a readable table", () => {
    expect(formatQueryResult(result, "table")).toContain("(2 rows)");
    expect(formatQueryResult(result, "table")).toMatch(/^\| id\s+\| name\s+\| active \|$/m);
    expect(formatQueryResult(result, "table")).toContain("second line↵continued");
  });
});

describe("writeQueryResultNdjsonStream", () => {
  it("writes streamed rows as NDJSON while honoring writable backpressure", async () => {
    let output = "";
    const writable = new Writable({
      highWaterMark: 1,
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        setTimeout(callback, 1);
      },
    });
    async function* batches(): AsyncGenerator<QueryResultBatch> {
      yield { columns: ["id"], rows: [{ id: 1 }, { id: 2 }, { id: 3 }], rowCount: 3 };
    }

    await expect(writeQueryResultNdjsonStream(batches(), writable)).resolves.toBe(3);
    expect(output).toBe('{"id":1}\n{"id":2}\n{"id":3}\n');
    writable.end();
  });

  it("stops waiting for writable backpressure when the query is cancelled", async () => {
    let releaseWrite: (() => void) | undefined;
    const writable = new Writable({
      highWaterMark: 1,
      write(_chunk, _encoding, callback) {
        releaseWrite = callback;
      },
    });
    const controller = new AbortController();
    async function* batches(): AsyncGenerator<QueryResultBatch> {
      yield { columns: ["id"], rows: [{ id: 1 }], rowCount: 1 };
    }

    const pending = writeQueryResultNdjsonStream(batches(), writable, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow("Query streaming was cancelled.");
    expect(writable.listenerCount("drain")).toBe(0);
    expect(writable.listenerCount("error")).toBe(0);
    expect(writable.listenerCount("close")).toBe(0);
    releaseWrite?.();
    writable.end();
  });

  it("fails if output closes before writable backpressure is relieved", async () => {
    const writable = new Writable({
      highWaterMark: 1,
      write() {},
    });
    async function* batches(): AsyncGenerator<QueryResultBatch> {
      yield { columns: ["id"], rows: [{ id: 1 }], rowCount: 1 };
    }

    const pending = writeQueryResultNdjsonStream(batches(), writable);
    writable.destroy();
    await expect(pending).rejects.toThrow("Query output stream closed before it could drain.");
  });

  it("serializes streamed CLOB text as a JSON string across chunk boundaries", async () => {
    let output = "";
    const writable = new Writable({
      write(chunk, _encoding, callback) { output += chunk.toString(); callback(); },
    });
    async function* batches(): AsyncGenerator<QueryResultBatch> {
      yield {
        columns: ["id", "description"],
        rows: [{
          id: 1,
          description: {
            __dbStudioQueryStreamCell: true,
            encoding: "utf8",
            stream: Readable.from(["中文\"", "\\路径\n", "😀"]),
            destroy() {},
          },
        }],
        rowCount: 1,
      };
    }

    await expect(writeQueryResultNdjsonStream(batches(), writable)).resolves.toBe(1);
    expect(JSON.parse(output)).toEqual({ id: 1, description: '中文"\\路径\n😀' });
    writable.end();
  });

  it("preserves the existing Buffer JSON shape while streaming BLOB chunks", async () => {
    let output = "";
    const writable = new Writable({
      write(chunk, _encoding, callback) { output += chunk.toString(); callback(); },
    });
    async function* batches(): AsyncGenerator<QueryResultBatch> {
      yield {
        columns: ["payload"],
        rows: [{
          payload: {
            __dbStudioQueryStreamCell: true,
            encoding: "buffer",
            stream: Readable.from([Buffer.from([0, 255]), Buffer.from([16])]),
            destroy() {},
          },
        }],
        rowCount: 1,
      };
    }

    await expect(writeQueryResultNdjsonStream(batches(), writable)).resolves.toBe(1);
    expect(JSON.parse(output)).toEqual({ payload: { type: "Buffer", data: [0, 255, 16] } });
    writable.end();
  });
});
