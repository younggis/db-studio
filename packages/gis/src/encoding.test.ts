import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { detectGisEncoding, encodingForGisDriver, effectiveSourceEncoding, findInvalidDbfUtf8Field, normalizeTextEncoding, prepareGisInput, toGdalEncodingName } from "./encoding.js";

const temporaryDirectories: string[] = [];

async function makeDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dbstudio-gis-encoding-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

interface TestDbfField {
  name: string;
  type: "C" | "N";
  length: number;
}

function makeDbf(rows: string[], options: { ldid?: number; fieldLength?: number; fields?: TestDbfField[] } = {}): Buffer {
  const fields = options.fields ?? [{ name: "NAME", type: "C", length: options.fieldLength ?? 80 }];
  const headerLength = 32 + fields.length * 32 + 1;
  const recordLength = fields.reduce((total, field) => total + field.length, 1);
  const header = Buffer.alloc(32);
  header[0] = 0x03;
  header.writeUInt32LE(rows.length, 4);
  header.writeUInt16LE(headerLength, 8);
  header.writeUInt16LE(recordLength, 10);
  header[29] = options.ldid ?? 0;
  const descriptors = fields.map((definition) => {
    const field = Buffer.alloc(32);
    field.write(definition.name, 0, "ascii");
    field[11] = definition.type.charCodeAt(0);
    field[16] = definition.length;
    return field;
  });
  const terminator = Buffer.from([0x0d]);
  const records = rows.map((hex) => {
    const record = Buffer.alloc(recordLength, 0x20);
    record[0] = 0x20;
    Buffer.from(hex, "hex").copy(record, 1, 0, recordLength - 1);
    return record;
  });
  return Buffer.concat([header, ...descriptors, terminator, ...records, Buffer.from([0x1a])]);
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("GIS source encoding", () => {
  it("keeps ZIP member-name encoding separate from source text encoding for virtual TAB paths", async () => {
    const input = "/vsizip/F:/datasets/线路.zip/数据/线路.TAB";
    const baseEnvironment = { PATH: "", CPL_ZIP_ENCODING: "CP437" };

    await expect(detectGisEncoding(input)).resolves.toMatchObject({
      source: "unknown",
      confidence: null,
      warnings: [expect.stringContaining("inside a GDAL virtual ZIP path")],
    });
    await expect(detectGisEncoding(input, "CP936")).resolves.toMatchObject({
      source: "user",
      detectedEncoding: "CP936",
    });

    const prepared = await prepareGisInput(input, "CP936", baseEnvironment, "UTF-8");
    expect(prepared.path).toBe(input);
    expect(prepared.openOptions).toEqual(["ENCODING=CP936"]);
    expect(prepared.env.CPL_ZIP_ENCODING).toBe("UTF-8");
    expect(baseEnvironment.CPL_ZIP_ENCODING).toBe("CP437");
    await prepared.cleanup();
  });

  it("rejects unsafe ZIP filename encoding values before passing them to GDAL", async () => {
    await expect(prepareGisInput(
      "/vsizip/C:/datasets/roads.zip/roads.TAB",
      undefined,
      process.env,
      "UTF-8\nCPL_DEBUG=ON",
    )).rejects.toThrow("ZIP filename encoding must be a GDAL/ICONV encoding name");
  });

  it("uses the MVT format's UTF-8 string rule only after GDAL identifies the driver", () => {
    const unknown = {
      source: "unknown" as const,
      confidence: null,
      warnings: ["No encoding metadata reader is available for this format."],
    };

    expect(encodingForGisDriver("MVT", unknown)).toMatchObject({
      source: "format",
      declaredEncoding: "UTF-8",
      confidence: 1,
    });
    expect(effectiveSourceEncoding(encodingForGisDriver("MVT", unknown))).toBe("UTF-8");
    expect(encodingForGisDriver("OSM", unknown)).toBe(unknown);
  });

  it("allows only an explicit UTF-8 choice for PBF input", async () => {
    const directory = await makeDirectory();
    const pbf = path.join(directory, "tile.pbf");
    await writeFile(pbf, Buffer.from([0x1a, 0x00]));

    await expect(detectGisEncoding(pbf, "UTF-8")).resolves.toMatchObject({ source: "user", detectedEncoding: "UTF-8" });
    await expect(detectGisEncoding(pbf, "CP936")).rejects.toThrow("PBF input accepts only UTF-8");
  });

  it("requires an explicit encoding for legacy GeoJSON and streams it to a UTF-8 temporary copy", async () => {
    const directory = await makeDirectory();
    const geojson = path.join(directory, "legacy.geojson");
    const prefix = Buffer.from('{"type":"FeatureCollection","features":[{"type":"Feature","properties":{"name":"', "ascii");
    const padding = Buffer.alloc(65_536 - prefix.length - 1, 0x61);
    const legacyChinese = Buffer.from("D6D0CEC4B5C0C2B7C3FBB3C6B1B1BEA9CAD0C2B7", "hex");
    const suffix = Buffer.from('"},"geometry":null}]}', "ascii");
    const original = Buffer.concat([prefix, padding, legacyChinese, suffix]);
    await writeFile(geojson, original);

    const detected = await detectGisEncoding(geojson);
    expect(detected).toMatchObject({ source: "unknown", confidence: null });
    expect(detected).not.toHaveProperty("detectedEncoding");
    expect(detected.warnings[0]).toContain("JSON text contains invalid UTF-8 byte sequences");

    const overridden = await detectGisEncoding(geojson, "GBK");
    expect(overridden).toMatchObject({ source: "user", detectedEncoding: "CP936" });
    expect(overridden.warnings.some((warning) => warning.includes("transcoded into a UTF-8 temporary copy"))).toBe(true);

    const prepared = await prepareGisInput(geojson, "GBK", process.env);
    expect(prepared.path).not.toBe(geojson);
    try {
      const transcoded = await readFile(prepared.path, "utf8");
      const parsed = JSON.parse(transcoded) as { features: Array<{ properties: { name: string } }> };
      expect(parsed.features[0]?.properties.name).toBe(
        padding.toString("ascii") + "中文道路名称北京市路",
      );
      expect(await readFile(geojson)).toEqual(original);
    } finally {
      await prepared.cleanup();
    }
    await expect(readFile(prepared.path)).rejects.toThrow();
  });

  it("detects valid CSV byte-order marks and safely decodes fully ASCII no-BOM CSV", async () => {
    const directory = await makeDirectory();
    const utf8Csv = path.join(directory, "utf8.csv");
    const noBomCsv = path.join(directory, "no-bom.csv");
    await writeFile(utf8Csv, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("name,value\n路,1\n", "utf8")]));
    await writeFile(noBomCsv, Buffer.from("name,value\nroad,1\n", "utf8"));

    await expect(detectGisEncoding(utf8Csv)).resolves.toMatchObject({
      source: "metadata",
      declaredEncoding: "UTF-8",
      confidence: 1,
    });
    const asciiCompatible = await detectGisEncoding(noBomCsv);
    expect(asciiCompatible).toMatchObject({ source: "ascii-compatible", detectedEncoding: "UTF-8", confidence: null });
    expect(effectiveSourceEncoding(asciiCompatible)).toBe("UTF-8");
    expect(asciiCompatible.warnings[0]).toContain("original source encoding remains unknown");
  });

  it("does not infer UTF-8 when non-ASCII bytes occur after the initial CSV sample", async () => {
    const directory = await makeDirectory();
    const csv = path.join(directory, "ascii-prefix.csv");
    await writeFile(csv, Buffer.concat([
      Buffer.alloc(256 * 1024, 0x61),
      Buffer.from([0xc3, 0xa9]),
    ]));

    const result = await detectGisEncoding(csv);
    expect(result).toMatchObject({ source: "unknown", confidence: null });
    expect(result.warnings[0]).toContain("complete-file validation found non-ASCII or NUL bytes");
  });

  it("does not treat a BOM-less UTF-16-like file with NUL bytes as ASCII-compatible", async () => {
    const directory = await makeDirectory();
    const csv = path.join(directory, "nul-after-sample.csv");
    await writeFile(csv, Buffer.concat([
      Buffer.alloc(256 * 1024, 0x61),
      Buffer.from([0]),
    ]));

    const result = await detectGisEncoding(csv);
    expect(result).toMatchObject({ source: "unknown", confidence: null });
    expect(result.warnings[0]).toContain("complete-file validation found non-ASCII or NUL bytes");
  });

  it("infers a high-confidence legacy CSV encoding only after strict whole-file validation", async () => {
    const directory = await makeDirectory();
    const csv = path.join(directory, "legacy-high-confidence.csv");
    const row = Buffer.concat([
      Buffer.from("D6D0CEC4B5C0C2B7", "hex"),
      Buffer.from(",", "ascii"),
      Buffer.from("B1B1BEA9CAD0C2B7", "hex"),
      Buffer.from("\r\n", "ascii"),
    ]);
    await writeFile(csv, Buffer.concat([
      Buffer.from("road,city\r\n", "ascii"),
      ...Array.from({ length: 120 }, () => row),
    ]));

    const detected = await detectGisEncoding(csv);
    expect(detected).toMatchObject({ source: "heuristic", detectedEncoding: "GB18030" });
    expect(detected.confidence).toBeGreaterThanOrEqual(0.9);
    expect(detected.warnings[0]).toContain("complete file");
    const sourceEncoding = effectiveSourceEncoding(detected);
    expect(sourceEncoding).toBe("GB18030");

    const prepared = await prepareGisInput(csv, sourceEncoding!, process.env);
    try {
      expect(await readFile(prepared.path, "utf8")).toContain("中文道路");
      expect((await readFile(csv)).includes(Buffer.from("D6D0CEC4", "hex"))).toBe(true);
    } finally {
      await prepared.cleanup();
    }
  });

  it("keeps a high-scoring legacy candidate uncertain when bytes beyond the sample are invalid", async () => {
    const directory = await makeDirectory();
    const csv = path.join(directory, "invalid-after-sample.csv");
    const row = Buffer.concat([
      Buffer.from("D6D0CEC4B5C0C2B7", "hex"),
      Buffer.from(",", "ascii"),
      Buffer.from("B1B1BEA9CAD0C2B7", "hex"),
      Buffer.from("\r\n", "ascii"),
    ]);
    await writeFile(csv, Buffer.concat([
      Buffer.from("road,city\r\n", "ascii"),
      ...Array.from({ length: 20_000 }, () => row),
      Buffer.from([0x81]),
    ]));

    const detected = await detectGisEncoding(csv);
    expect(detected.source).toBe("unknown");
    expect(effectiveSourceEncoding(detected)).toBeUndefined();
    expect(detected.warnings[0]).toContain("full-file-decodable");
  });

  it("detects DXF ANSI code-page declarations and keeps unsupported declarations explicit", async () => {
    const directory = await makeDirectory();
    const dxf = path.join(directory, "roads.dxf");
    await writeFile(dxf, "0\r\nSECTION\r\n2\r\nHEADER\r\n9\r\n$DWGCODEPAGE\r\n3\r\nANSI_936\r\n0\r\nENDSEC\r\n");

    await expect(detectGisEncoding(dxf)).resolves.toMatchObject({
      source: "metadata",
      declaredEncoding: "CP936",
      confidence: 1,
    });
    await expect(detectGisEncoding(dxf, "GBK")).resolves.toMatchObject({
      source: "user",
      declaredEncoding: "CP936",
      detectedEncoding: "CP936",
    });

    await writeFile(dxf, "0\r\nSECTION\r\n2\r\nHEADER\r\n9\r\n$DWGCODEPAGE\r\n3\r\nANSI_99999\r\n0\r\nENDSEC\r\n");
    const unsupported = await detectGisEncoding(dxf);
    expect(unsupported).toMatchObject({ source: "unknown", confidence: null });
    expect(unsupported.warnings[0]).toContain("unsupported $DWGCODEPAGE value: ANSI_99999");
  });

  it("leaves a DXF code-page declaration for the GDAL DXF driver to apply", async () => {
    const directory = await makeDirectory();
    const dxf = path.join(directory, "roads.dxf");
    await writeFile(dxf, "0\r\nSECTION\r\n2\r\nHEADER\r\n9\r\n$DWGCODEPAGE\r\n3\r\nANSI_936\r\n0\r\nENDSEC\r\n");

    const prepared = await prepareGisInput(dxf, "CP936", process.env);
    expect(prepared.path).toBe(dxf);
    expect(prepared.env).toBe(process.env);
    await prepared.cleanup();
  });

  it("transcodes a manually selected legacy CSV encoding without changing the source", async () => {
    const directory = await makeDirectory();
    const csv = path.join(directory, "legacy.csv");
    const original = Buffer.concat([
      Buffer.from("name,city\r\n", "ascii"),
      Buffer.from("B1B1BEA9CAD0C2B7", "hex"),
      Buffer.from(",", "ascii"),
      Buffer.from("C3FBB3C6", "hex"),
      Buffer.from("\r\n", "ascii"),
    ]);
    await writeFile(csv, original);

    const detected = await detectGisEncoding(csv);
    expect(detected.source).toBe("unknown");
    expect(effectiveSourceEncoding(detected)).toBeUndefined();
    const overridden = await detectGisEncoding(csv, "GBK");
    expect(overridden).toMatchObject({ source: "user", detectedEncoding: "CP936" });
    expect(overridden.warnings.some((warning) => warning.includes("CSV source will be transcoded into a UTF-8 temporary copy"))).toBe(true);

    const prepared = await prepareGisInput(csv, "GBK", process.env);
    expect(prepared.path).not.toBe(csv);
    try {
      expect(await readFile(prepared.path, "utf8")).toBe("name,city\r\n北京市路,名称\r\n");
      expect(await readFile(csv)).toEqual(original);
    } finally {
      await prepared.cleanup();
    }
    await expect(readFile(prepared.path)).rejects.toThrow();
  });

  it("detects and normalizes UTF-16LE CSV to a UTF-8 temporary copy", async () => {
    const directory = await makeDirectory();
    const csv = path.join(directory, "utf16.csv");
    const original = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("name,value\r\n道路,1\r\n", "utf16le")]);
    await writeFile(csv, original);

    await expect(detectGisEncoding(csv)).resolves.toMatchObject({
      source: "metadata",
      declaredEncoding: "UTF-16LE",
      confidence: 1,
    });
    const prepared = await prepareGisInput(csv, "UTF-16LE", process.env);
    expect(prepared.path).not.toBe(csv);
    try {
      expect(await readFile(prepared.path, "utf8")).toBe("name,value\r\n道路,1\r\n");
      expect(await readFile(csv)).toEqual(original);
    } finally {
      await prepared.cleanup();
    }
    await expect(readFile(prepared.path)).rejects.toThrow();
  });

  it("prefers a Shapefile CPG declaration and reads case-insensitive sidecars", async () => {
    const directory = await makeDirectory();
    const shape = path.join(directory, "roads.SHP");
    await writeFile(shape, Buffer.from([0]));
    await writeFile(path.join(directory, "roads.CPG"), "GBK\r\n");
    await writeFile(path.join(directory, "roads.DBF"), makeDbf([], { ldid: 0x57 }));

    const result = await detectGisEncoding(shape);
    expect(result).toMatchObject({ source: "metadata", declaredEncoding: "CP936", confidence: 1 });
    expect(result.warnings).toContain("The Shapefile .cpg declares CP936, but DBF LDID declares ISO-8859-1; .cpg takes precedence, so verify the attribute preview.");
  });

  it("rejects a CPG declaration that cannot decode sampled DBF text and accepts a manual override", async () => {
    const directory = await makeDirectory();
    const shape = path.join(directory, "roads.shp");
    const chineseGbk = "D6D0CEC4B5C0C2B7C3FBB3C6B1B1BEA9CAD0C2B7";
    await writeFile(shape, Buffer.from([0]));
    await writeFile(path.join(directory, "roads.cpg"), "UTF-8");
    await writeFile(path.join(directory, "roads.dbf"), makeDbf(Array(20).fill(chineseGbk)));

    const detected = await detectGisEncoding(shape);
    expect(detected).toMatchObject({ source: "unknown", declaredEncoding: "UTF-8", confidence: null });
    expect(detected.warnings[0]).toContain("sampled DBF character fields are not valid UTF-8");

    const overridden = await detectGisEncoding(shape, "GBK");
    expect(overridden).toMatchObject({ source: "user", declaredEncoding: "UTF-8", detectedEncoding: "CP936" });
    expect(overridden.warnings.some((warning) => warning.includes("sampled DBF character fields are not valid UTF-8"))).toBe(true);
  });

  it("rejects a UTF-8 CPG when a malformed DBF cell appears beyond the encoding sample window", async () => {
    const directory = await makeDirectory();
    const shape = path.join(directory, "roads.shp");
    const validAscii = Buffer.from("Main Road", "ascii").toString("hex");
    const rows = Array(500).fill(validAscii);
    rows.push("4d61696e20e522");
    await writeFile(shape, Buffer.from([0]));
    await writeFile(path.join(directory, "roads.cpg"), "UTF-8");
    await writeFile(path.join(directory, "roads.dbf"), makeDbf(rows, { fields: [{ name: "COUNTY", type: "C", length: 80 }] }));

    const detected = await detectGisEncoding(shape);

    expect(detected).toMatchObject({ source: "unknown", declaredEncoding: "UTF-8", confidence: null });
    expect(effectiveSourceEncoding(detected)).toBeUndefined();
    expect(detected.warnings[0]).toContain("DBF record 501, field COUNTY");

    const overridden = await detectGisEncoding(shape, "CP936");
    expect(overridden).toMatchObject({ source: "user", declaredEncoding: "UTF-8", detectedEncoding: "CP936" });
    expect(overridden.warnings.some((warning) => warning.includes("DBF record 501, field COUNTY"))).toBe(true);
  });

  it("uses DBF LDID metadata when there is no CPG file", async () => {
    const directory = await makeDirectory();
    const shape = path.join(directory, "roads.shp");
    await writeFile(shape, Buffer.from([0]));
    await writeFile(path.join(directory, "roads.dbf"), makeDbf([], { ldid: 0x7a }));

    const result = await detectGisEncoding(shape);
    expect(result).toMatchObject({ source: "metadata", declaredEncoding: "CP936", confidence: 0.95 });
    expect(result.warnings[0]).toContain("LDID declarations can be inaccurate");
  });

  it("scopes Shapefile source encoding to the GDAL open option", async () => {
    const directory = await makeDirectory();
    const input = path.join(directory, "roads.shp");
    const environment = { SHAPE_ENCODING: "UTF-8", GIS_TEST_VALUE: "preserved" };

    const prepared = await prepareGisInput(input, "GBK", environment);

    expect(prepared.openOptions).toEqual(["ENCODING=CP936"]);
    expect(prepared.env).toMatchObject({ GIS_TEST_VALUE: "preserved" });
    expect(prepared.env).not.toHaveProperty("SHAPE_ENCODING");
    expect(environment.SHAPE_ENCODING).toBe("UTF-8");
  });

  it("marks complete ASCII-only DBF text as safely decodable without identifying its code page", async () => {
    const directory = await makeDirectory();
    const shape = path.join(directory, "roads.shp");
    await writeFile(shape, Buffer.from([0]));
    await writeFile(path.join(directory, "roads.dbf"), makeDbf([Buffer.from("Road Name", "ascii").toString("hex")]));

    const result = await detectGisEncoding(shape);
    expect(result).toMatchObject({ source: "ascii-compatible", detectedEncoding: "UTF-8", confidence: null });
    expect(result.warnings[0]).toContain("original code page remains unknown");
  });

  it("allows trailing NUL-padded DBF fields only after complete-file validation", async () => {
    const directory = await makeDirectory();
    const shape = path.join(directory, "roads.shp");
    const dbf = makeDbf([Buffer.from("Road", "ascii").toString("hex")]);
    const headerLength = dbf.readUInt16LE(8);
    dbf.fill(0, headerLength + 1 + 4, headerLength + dbf.readUInt16LE(10));
    await writeFile(shape, Buffer.from([0]));
    await writeFile(path.join(directory, "roads.dbf"), dbf);

    const result = await detectGisEncoding(shape);
    expect(result).toMatchObject({ source: "ascii-compatible", detectedEncoding: "UTF-8", confidence: null });
    expect(result.warnings[0]).toContain("trailing NUL padding");
  });

  it("keeps a DBF unknown when a non-ASCII byte appears outside the bounded sample", async () => {
    const directory = await makeDirectory();
    const shape = path.join(directory, "roads.shp");
    const dbf = makeDbf(Array(501).fill(Buffer.from("Road", "ascii").toString("hex")));
    const headerLength = dbf.readUInt16LE(8);
    const recordLength = dbf.readUInt16LE(10);
    dbf[headerLength + 500 * recordLength + 1] = 0xe7;
    await writeFile(shape, Buffer.from([0]));
    await writeFile(path.join(directory, "roads.dbf"), dbf);

    const result = await detectGisEncoding(shape);
    expect(result.source).toBe("unknown");
    expect(result.warnings[0]).toContain("only ASCII text");
  });

  it("rejects NUL bytes embedded before later DBF text", async () => {
    const directory = await makeDirectory();
    const shape = path.join(directory, "roads.shp");
    await writeFile(shape, Buffer.from([0]));
    await writeFile(path.join(directory, "roads.dbf"), makeDbf(["410042"], { fieldLength: 16 }));

    const result = await detectGisEncoding(shape);
    expect(result.source).toBe("unknown");
    expect(result.warnings[0]).toContain("only ASCII text");
  });

  it("detects a high-confidence GB18030-compatible Chinese DBF sample", async () => {
    const directory = await makeDirectory();
    const shape = path.join(directory, "roads.shp");
    const chineseGbk = "D6D0CEC4B5C0C2B7C3FBB3C6B1B1BEA9CAD0C2B7";
    await writeFile(shape, Buffer.from([0]));
    await writeFile(path.join(directory, "roads.dbf"), makeDbf(Array(20).fill(chineseGbk)));

    const result = await detectGisEncoding(shape);
    expect(result.source).toBe("heuristic");
    expect(result.detectedEncoding).toBe("GB18030");
    expect(result.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it("samples character fields at their declared offsets after numeric DBF fields", async () => {
    const directory = await makeDirectory();
    const shape = path.join(directory, "roads.shp");
    const chineseGbk = "D6D0CEC4B5C0C2B7C3FBB3C6B1B1BEA9CAD0C2B7";
    const text = Buffer.alloc(30, 0x20);
    Buffer.from(chineseGbk, "hex").copy(text);
    const fields: TestDbfField[] = [
      ...Array.from({ length: 10 }, (_, index) => ({ name: `NUMBER${index}`, type: "N" as const, length: 10 })),
      { name: "NAME", type: "C", length: text.length },
    ];
    const row = Buffer.concat([...Array.from({ length: 10 }, () => Buffer.from("0123456789", "ascii")), text]).toString("hex");
    await writeFile(shape, Buffer.from([0]));
    await writeFile(path.join(directory, "roads.dbf"), makeDbf(Array(20).fill(row), { fields }));

    const result = await detectGisEncoding(shape);

    expect(result.source).toBe("heuristic");
    expect(result.detectedEncoding).toBe("GB18030");
  });

  it("finds a malformed UTF-8 DBF cell beyond the encoding sample window", async () => {
    const directory = await makeDirectory();
    const shape = path.join(directory, "roads.shp");
    const valid = Buffer.from("Main Road", "ascii").toString("hex");
    const rows = Array(500).fill(valid);
    rows.push("4d61696e20e522");
    await writeFile(shape, Buffer.from([0]));
    await writeFile(path.join(directory, "roads.dbf"), makeDbf(rows, { fields: [{ name: "CITY", type: "C", length: 80 }] }));

    await expect(findInvalidDbfUtf8Field(shape)).resolves.toEqual({ recordNumber: 501, fieldName: "CITY" });
  });

  it("stages malformed UTF-8 DBF field names with stable aliases without changing source files", async () => {
    const directory = await makeDirectory();
    const shape = path.join(directory, "roads.shp");
    const dbf = path.join(directory, "roads.dbf");
    await writeFile(shape, Buffer.from([0]));
    const malformed = makeDbf([Buffer.from("Main Road", "ascii").toString("hex")], {
      fields: [
        { name: "BROKEN", type: "C", length: 80 },
        { name: "DBF1", type: "C", length: 8 },
      ],
    });
    malformed.fill(0, 32, 43);
    malformed.set([0xe7, 0x22, 0x20], 32);
    await writeFile(dbf, malformed);

    const prepared = await prepareGisInput(shape, "UTF-8", process.env);
    try {
      expect(prepared.path).not.toBe(shape);
      expect(prepared.warnings?.[0]).toContain("1→DBF1_2");
      expect(prepared.warnings?.[0]).toContain("source files are unchanged");
      expect(prepared.openOptions).toEqual(["ENCODING=UTF-8"]);
      expect((await readFile(path.join(path.dirname(prepared.path), "roads.dbf"))).subarray(32, 43).toString("ascii").replace(/\0+$/, ""))
        .toBe("DBF1_2");
      expect((await readFile(path.join(path.dirname(prepared.path), "roads.dbf"))).subarray(64, 75).toString("ascii").replace(/\0+$/, ""))
        .toBe("DBF1");
      expect(await readFile(dbf)).toEqual(malformed);
    } finally {
      await prepared.cleanup();
    }
  });

  it("replaces only incomplete UTF-8 terminal code points in a staged Shapefile copy", async () => {
    const directory = await makeDirectory();
    const shape = path.join(directory, "roads.shp");
    const dbf = path.join(directory, "roads.dbf");
    const originalDbf = makeDbf(["e68890e983", "c2", "f09f92", "414243"], {
      fields: [{ name: "CITY", type: "C", length: 12 }],
    });
    await writeFile(shape, Buffer.from([1, 2, 3]));
    await writeFile(path.join(directory, "roads.shx"), Buffer.from([4, 5, 6]));
    await writeFile(path.join(directory, "roads.cpg"), "UTF-8");
    await writeFile(path.join(directory, "roads.qix"), Buffer.from([7, 8, 9]));
    await writeFile(dbf, originalDbf);

    const prepared = await prepareGisInput(shape, "UTF-8", process.env, undefined, true);
    try {
      expect(prepared.path).not.toBe(shape);
      expect(prepared.warnings?.[0]).toContain('CITY: 3 record(s)');
      expect(prepared.warnings?.[0]).toContain('replaced with "?"');
      expect(prepared.warnings?.[0]).toContain("source files are unchanged");
      expect(await readFile(path.join(path.dirname(prepared.path), "roads.qix"))).toEqual(Buffer.from([7, 8, 9]));
      const stagedDbf = await readFile(path.join(path.dirname(prepared.path), "roads.dbf"));
      expect(stagedDbf.readUInt16LE(10)).toBe(originalDbf.readUInt16LE(10));
      const headerLength = stagedDbf.readUInt16LE(8);
      const recordLength = stagedDbf.readUInt16LE(10);
      const cells = [0, 1, 2, 3].map((row) => stagedDbf.subarray(headerLength + row * recordLength + 1, headerLength + (row + 1) * recordLength).toString("utf8"));
      expect(cells[0]).toBe(`成?${" ".repeat(8)}`);
      expect(cells[1]).toBe(`?${" ".repeat(11)}`);
      expect(cells[2]).toBe(`?${" ".repeat(11)}`);
      expect(cells[3]).toBe(`ABC${" ".repeat(9)}`);
      expect(await readFile(dbf)).toEqual(originalDbf);
    } finally {
      await prepared.cleanup();
    }
  });

  it("keeps incomplete UTF-8 tail replacement opt-in and rejects internal malformed bytes", async () => {
    const directory = await makeDirectory();
    const shape = path.join(directory, "roads.shp");
    const dbf = path.join(directory, "roads.dbf");
    const malformed = makeDbf(["41e52242"], { fieldLength: 12 });
    await writeFile(shape, Buffer.from([1]));
    await writeFile(dbf, malformed);

    const strict = await prepareGisInput(shape, "UTF-8", process.env);
    expect(strict.path).toBe(shape);
    expect(strict.warnings).toBeUndefined();
    await strict.cleanup();
    await expect(prepareGisInput(shape, "UTF-8", process.env, undefined, true))
      .rejects.toThrow('record 1, field "NAME" contains invalid UTF-8');
    expect(await readFile(dbf)).toEqual(malformed);
  });

  it("limits incomplete UTF-8 tail replacement to explicitly selected UTF-8 standalone Shapefiles", async () => {
    await expect(prepareGisInput("roads.shp", undefined, process.env, undefined, true))
      .rejects.toThrow("Choose UTF-8 explicitly");
    await expect(prepareGisInput("roads.shp", "CP936", process.env, undefined, true))
      .rejects.toThrow("Choose UTF-8 explicitly");
    await expect(prepareGisInput("roads.tab", "UTF-8", process.env, undefined, true))
      .rejects.toThrow("only for standalone Shapefile");
    await expect(prepareGisInput("/vsizip/C:/data/roads.zip/roads.shp", "UTF-8", process.env, undefined, true))
      .rejects.toThrow("not virtual ZIP paths");
  });

  it("reads MapInfo charset metadata and stages manual overrides without changing source files", async () => {
    const directory = await makeDirectory();
    const tab = path.join(directory, "roads.tab");
    const original = "!table\r\n!version 300\r\n!charset WindowsLatin1\r\nDefinition Table\r\n";
    await writeFile(tab, original, "latin1");
    await writeFile(path.join(directory, "roads.dat"), Buffer.from([1, 2, 3]));
    await writeFile(path.join(directory, "roads.map"), Buffer.from([4, 5, 6]));

    expect(await detectGisEncoding(tab)).toMatchObject({ source: "metadata", declaredEncoding: "CP1252" });
    const prepared = await prepareGisInput(tab, "GBK", process.env);
    try {
      expect(prepared.path).not.toBe(tab);
      expect((await readFile(prepared.path, "latin1"))).toContain("!charset WindowsSimpChinese");
      expect(await readFile(tab, "latin1")).toBe(original);
      expect(await readFile(path.join(path.dirname(prepared.path), "roads.dat"))).toEqual(Buffer.from([1, 2, 3]));
    } finally {
      await prepared.cleanup();
    }
  });

  it("applies an explicit UTF-8 override to MapInfo TAB headers", async () => {
    const directory = await makeDirectory();
    const tab = path.join(directory, "roads.tab");
    const original = "!table\r\n!version 300\r\n!charset WindowsLatin1\r\nDefinition Table\r\n";
    await writeFile(tab, original, "latin1");
    await writeFile(path.join(directory, "roads.dat"), Buffer.from([1, 2, 3]));

    const prepared = await prepareGisInput(tab, "UTF-8", process.env);
    try {
      expect((await readFile(prepared.path, "latin1"))).toContain("!charset UTF-8");
      expect(await readFile(tab, "latin1")).toBe(original);
    } finally {
      await prepared.cleanup();
    }
  });

  it("normalizes unsupported TAB field punctuation in an isolated byte-preserving copy", async () => {
    const directory = await makeDirectory();
    const tab = path.join(directory, "roads.tab");
    const prefix = Buffer.from("!table\r\n!version 300\r\n!charset Neutral\r\nDefinition Table\r\n  Type NATIVE Charset \"Neutral\"\r\n  Fields 1\r\n    ", "ascii");
    const dbcsTrail = Buffer.from([0xc1, 0x5c]);
    const suffix = Buffer.from("CGI(5G) Char (50) ;\r\n", "ascii");
    const original = Buffer.concat([prefix, dbcsTrail, suffix]);
    await writeFile(tab, original);
    await writeFile(path.join(directory, "roads.dat"), Buffer.from([1, 2, 3]));

    const prepared = await prepareGisInput(tab, undefined, process.env);
    try {
      expect(prepared.path).not.toBe(tab);
      expect(prepared.warnings).toEqual([
        "MapInfo TAB field names contained unsupported ASCII characters; an isolated copy replaces punctuation with underscores and prefixes leading digits. The source files are unchanged.",
      ]);
      const staged = await readFile(prepared.path);
      expect(staged.indexOf(Buffer.concat([dbcsTrail, Buffer.from("CGI_5G_ Char (50) ;", "ascii")]))).toBeGreaterThanOrEqual(0);
      expect(staged.indexOf(Buffer.from("Char (50)", "ascii"))).toBeGreaterThanOrEqual(0);
      expect(await readFile(tab)).toEqual(original);
      expect(await readFile(path.join(path.dirname(prepared.path), "roads.dat"))).toEqual(Buffer.from([1, 2, 3]));
    } finally {
      await prepared.cleanup();
    }
  });

  it("normalizes common encoding aliases and rejects unsupported labels", () => {
    expect(normalizeTextEncoding("GBK")).toBe("CP936");
    expect(normalizeTextEncoding("936")).toBe("CP936");
    expect(normalizeTextEncoding("windows-1252")).toBe("CP1252");
    expect(() => normalizeTextEncoding("made-up-codepage")).toThrow("Unsupported text encoding");
  });

  it("uses GDAL-compatible Windows code-page labels for Shapefile overrides", async () => {
    for (const codePage of [1250, 1251, 1252, 1253, 1254, 1255, 1256, 1258]) {
      expect(toGdalEncodingName(`CP${codePage}`)).toBe(`WINDOWS-${codePage}`);
    }
    const prepared = await prepareGisInput("roads.shp", "windows-1252", process.env);
    expect(prepared.openOptions).toEqual(["ENCODING=WINDOWS-1252"]);
  });
});
