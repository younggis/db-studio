import chardet from "chardet";
import { createReadStream, createWriteStream } from "node:fs";
import { copyFile, mkdtemp, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export type EncodingSource = "metadata" | "format" | "user" | "heuristic" | "ascii-compatible" | "unknown";

export interface EncodingDetectionResult {
  declaredEncoding?: string;
  detectedEncoding?: string;
  source: EncodingSource;
  confidence: number | null;
  warnings: string[];
}

export interface PreparedGisInput {
  path: string;
  env: NodeJS.ProcessEnv;
  openOptions?: string[];
  warnings?: string[];
  cleanup(): Promise<void>;
}

export function isVirtualZipPath(filePath: string): boolean {
  return /^\/vsizip\//i.test(filePath);
}

function normalizeZipFilenameEncoding(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const normalized = value.trim();
  if (normalized.length > 64 || !/^[A-Za-z0-9._-]+$/.test(normalized)) {
    throw new Error("ZIP filename encoding must be a GDAL/ICONV encoding name of at most 64 ASCII letters, digits, dots, underscores, or hyphens.");
  }
  return normalized;
}

const DBF_LDID_ENCODINGS: Record<number, string> = {
  0x01: "CP437", 0x02: "CP850", 0x03: "CP1252", 0x04: "MACINTOSH",
  0x08: "CP865", 0x09: "CP437", 0x0b: "CP437", 0x0d: "CP437", 0x0f: "CP437",
  0x10: "CP850", 0x11: "CP437", 0x12: "CP850", 0x13: "CP932", 0x14: "CP850",
  0x15: "CP437", 0x16: "CP850", 0x17: "CP865", 0x18: "CP437", 0x19: "CP437",
  0x1a: "CP850", 0x1b: "CP437", 0x1c: "CP863", 0x1d: "CP850", 0x1f: "CP852",
  0x22: "CP852", 0x23: "CP852", 0x24: "CP860", 0x25: "CP850", 0x26: "CP866",
  0x37: "CP850", 0x40: "CP852", 0x4d: "CP936", 0x4e: "CP949", 0x4f: "CP950",
  0x50: "CP874", 0x57: "ISO-8859-1", 0x58: "CP1252", 0x64: "CP852", 0x65: "CP866",
  0x66: "CP865", 0x67: "CP861", 0x68: "CP895", 0x69: "CP620", 0x6a: "CP737",
  0x6b: "CP857", 0x6c: "CP863", 0x78: "CP950", 0x79: "CP949", 0x7a: "CP936",
  0x7b: "CP932", 0x7c: "CP874", 0x7d: "CP1255", 0x7e: "CP1256", 0x86: "CP737",
  0x87: "CP852", 0x88: "CP857", 0x96: "CP10007", 0x97: "CP10006", 0x98: "CP10029",
  0xc8: "CP1250", 0xc9: "CP1251", 0xca: "CP1254", 0xcb: "CP1253", 0xcc: "CP1257",
  0xcd: "CP1258", 0xf0: "CP437", 0xf1: "CP850", 0xf2: "CP852", 0xf3: "CP860",
  0xf4: "CP863", 0xf5: "CP865", 0xf6: "CP866", 0xf7: "CP1257", 0xf8: "CP950",
  0xf9: "CP949", 0xfa: "CP936", 0xfb: "CP932", 0xfc: "CP874", 0xfd: "CP1255",
  0xfe: "CP1256",
};

const MAX_TEXT_ENCODING_SAMPLE_BYTES = 256 * 1024;

const ENCODING_ALIASES: Record<string, string> = {
  UTF8: "UTF-8", UTF8SIG: "UTF-8", 65001: "UTF-8",
  UTF16: "UTF-16", UTF16LE: "UTF-16LE", 1200: "UTF-16LE", UTF16BE: "UTF-16BE", 1201: "UTF-16BE",
  UTF32LE: "UTF-32LE", UTF32BE: "UTF-32BE",
  GBK: "CP936", CP936: "CP936", GB2312: "CP936", 936: "CP936",
  GB18030: "GB18030", 54936: "GB18030",
  BIG5: "CP950", CP950: "CP950", 950: "CP950",
  SHIFTJIS: "CP932", SJIS: "CP932", CP932: "CP932", 932: "CP932",
  EUCKR: "CP949", CP949: "CP949", 949: "CP949",
  WINDOWS1250: "CP1250", CP1250: "CP1250", 1250: "CP1250",
  WINDOWS1251: "CP1251", CP1251: "CP1251", 1251: "CP1251",
  WINDOWS1252: "CP1252", CP1252: "CP1252", 1252: "CP1252",
  WINDOWS1253: "CP1253", CP1253: "CP1253", 1253: "CP1253",
  WINDOWS1254: "CP1254", CP1254: "CP1254", 1254: "CP1254",
  WINDOWS1255: "CP1255", CP1255: "CP1255", 1255: "CP1255",
  WINDOWS1256: "CP1256", CP1256: "CP1256", 1256: "CP1256",
  WINDOWS1257: "CP1257", CP1257: "CP1257", 1257: "CP1257",
  WINDOWS1258: "CP1258", CP1258: "CP1258", 1258: "CP1258", MACROMAN: "MACINTOSH", MACINTOSH: "MACINTOSH",
  ISO88591: "ISO-8859-1", LATIN1: "ISO-8859-1", 28591: "ISO-8859-1",
  ISO88592: "ISO-8859-2", LATIN2: "ISO-8859-2", 28592: "ISO-8859-2",
  ISO88595: "ISO-8859-5", 28595: "ISO-8859-5",
  ISO88596: "ISO-8859-6", 28596: "ISO-8859-6",
  ISO88597: "ISO-8859-7", 28597: "ISO-8859-7",
  ISO88598: "ISO-8859-8", 28598: "ISO-8859-8",
  ISO88599: "ISO-8859-9", 28599: "ISO-8859-9",
  ASCII: "ASCII", USASCII: "ASCII",
};

const GDAL_ENCODING_NAMES: Record<string, string> = {
  CP1250: "WINDOWS-1250",
  CP1251: "WINDOWS-1251",
  CP1252: "WINDOWS-1252",
  CP1253: "WINDOWS-1253",
  CP1254: "WINDOWS-1254",
  CP1255: "WINDOWS-1255",
  CP1256: "WINDOWS-1256",
  CP1258: "WINDOWS-1258",
};

const DECODER_LABELS: Record<string, string> = {
  CP437: "ibm437", CP620: "ibm852", CP737: "ibm737", CP852: "ibm852", CP857: "ibm857",
  CP860: "ibm860", CP861: "ibm861", CP863: "ibm863", CP865: "ibm865", CP866: "ibm866",
  CP895: "windows-1250", CP932: "shift_jis", CP936: "gbk", CP949: "euc-kr", CP950: "big5",
  CP10006: "macintosh", CP10007: "x-mac-cyrillic", CP10029: "x-mac-ce",
  CP1250: "windows-1250", CP1251: "windows-1251", CP1252: "windows-1252", CP1253: "windows-1253",
  CP1254: "windows-1254", CP1255: "windows-1255", CP1256: "windows-1256", CP1257: "windows-1257", CP1258: "windows-1258",
  CP874: "windows-874", MACINTOSH: "macintosh",
  "ISO-8859-1": "iso-8859-1", "ISO-8859-2": "iso-8859-2",
  "ISO-8859-5": "iso-8859-5", "ISO-8859-6": "iso-8859-6", "ISO-8859-7": "iso-8859-7",
  "ISO-8859-8": "iso-8859-8", "ISO-8859-9": "iso-8859-9", "UTF-8": "utf-8",
  "UTF-16": "utf-16le", "UTF-16LE": "utf-16le", "UTF-16BE": "utf-16be", "UTF-32LE": "utf-32le",
  "UTF-32BE": "utf-32be", GB18030: "gb18030",
  ASCII: "windows-1252",
};

const MAPINFO_CHARSETS: Record<string, string> = {
  "UTF-8": "UTF-8", CP936: "WindowsSimpChinese", CP950: "WindowsTradChinese",
  CP1252: "WindowsLatin1", "ISO-8859-1": "WindowsLatin1", CP1250: "WindowsLatin2", "ISO-8859-2": "WindowsLatin2",
  CP1251: "WindowsCyrillic", CP1253: "WindowsGreek", CP1254: "WindowsTurkish", CP1255: "WindowsHebrew",
  CP1256: "WindowsArabic", CP1257: "WindowsBalticRim", CP1258: "WindowsVietnamese", CP874: "WindowsThai",
};

export function normalizeTextEncoding(value: string): string {
  const trimmed = value.trim().replace(/^['"]|['"]$/g, "");
  if (!trimmed) throw new Error("Source encoding cannot be empty.");
  const key = trimmed.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const normalized = ENCODING_ALIASES[key] ?? ENCODING_ALIASES[trimmed.toUpperCase()] ?? trimmed.toUpperCase();
  const decoder = DECODER_LABELS[normalized] ?? normalized;
  if (DECODER_LABELS[normalized]) return normalized;
  try {
    new TextDecoder(decoder);
  } catch {
    throw new Error(`Unsupported text encoding: ${value}`);
  }
  return normalized;
}

function textDecoderLabel(encoding: string): string {
  return DECODER_LABELS[encoding] ?? encoding;
}

async function isFileValidEncoding(filePath: string, encoding: string): Promise<boolean> {
  const decoder = new TextDecoder(textDecoderLabel(encoding), { fatal: true });
  try {
    for await (const chunk of createReadStream(filePath)) {
      decoder.decode(chunk, { stream: true });
    }
    decoder.decode();
    return true;
  } catch (error) {
    if (error instanceof TypeError) return false;
    throw error;
  }
}

async function transcodeFileToUtf8(sourcePath: string, outputPath: string, encoding: string): Promise<void> {
  const decoder = new TextDecoder(textDecoderLabel(encoding), { fatal: true });
  const invalidSequence = () => new Error("The source file contains byte sequences that are invalid for " + encoding + ".");
  const converter = new Transform({
    transform(chunk, _encoding, callback) {
      try {
        callback(null, Buffer.from(decoder.decode(chunk, { stream: true }), "utf8"));
      } catch {
        callback(invalidSequence());
      }
    },
    flush(callback) {
      try {
        callback(null, Buffer.from(decoder.decode(), "utf8"));
      } catch {
        callback(invalidSequence());
      }
    },
  });
  await pipeline(
    createReadStream(sourcePath),
    converter,
    createWriteStream(outputPath, { flags: "wx" }),
  );
}

export function toGdalEncodingName(value: string): string {
  const normalized = normalizeTextEncoding(value);
  return GDAL_ENCODING_NAMES[normalized] ?? normalized;
}

export async function detectGisEncoding(filePath: string, userOverride?: string): Promise<EncodingDetectionResult> {
  const automatic = isVirtualZipPath(filePath)
    ? encodingResult("unknown", undefined, null, userOverride?.trim()
      ? []
      : ["Source text encoding cannot be inspected directly inside a GDAL virtual ZIP path; specify --source-encoding when the layer has text fields."])
    : await detectDeclaredOrHeuristicEncoding(filePath);
  if (userOverride === undefined || userOverride.trim() === "") return automatic;
  const normalized = normalizeTextEncoding(userOverride);
  const extension = path.extname(filePath).toLowerCase();
  const supportsTextTranscoding = extension === ".geojson" || extension === ".json" || extension === ".csv";
  if (isVirtualZipPath(filePath) && supportsTextTranscoding && normalized !== "UTF-8") {
    throw new Error("A non-UTF-8 source encoding override cannot be transcoded from a GDAL virtual ZIP path; extract the member first or use UTF-8.");
  }
  if (extension === ".pbf") {
    if (normalized !== "UTF-8") {
      throw new Error("PBF input accepts only UTF-8 as an explicit source encoding.");
    }
    return {
      detectedEncoding: normalized,
      source: "user",
      confidence: 1,
      warnings: [...automatic.warnings, "Source encoding was explicitly set to UTF-8; verify the attribute preview before importing."],
    };
  }
  if (extension !== ".shp" && extension !== ".tab" && !supportsTextTranscoding &&
      (!automatic.declaredEncoding || normalizeTextEncoding(automatic.declaredEncoding) !== normalized)) {
    throw new Error(`${extension || "This"} format manages its text encoding internally and does not support a ${normalized} override.`);
  }
  return {
    ...(automatic.declaredEncoding ? { declaredEncoding: automatic.declaredEncoding } : {}),
    detectedEncoding: normalized,
    source: "user",
    confidence: 1,
    warnings: [
      ...automatic.warnings,
      "Source encoding was explicitly set to " + normalized + "; verify the attribute preview before importing.",
      ...(supportsTextTranscoding && normalized !== "UTF-8"
        ? [`The ${extension === ".csv" ? "CSV" : "JSON"} source will be transcoded into a UTF-8 temporary copy; the original file will not be changed.`]
        : []),
    ],
  };
}

export function effectiveSourceEncoding(result: EncodingDetectionResult): string | undefined {
  if (result.source === "metadata" || result.source === "format") return result.declaredEncoding;
  if (result.source === "heuristic" || result.source === "ascii-compatible") return result.detectedEncoding;
  if (result.source === "user") return result.detectedEncoding ?? result.declaredEncoding;
  return undefined;
}

export function encodingForGisDriver(driverShortName: string, result: EncodingDetectionResult): EncodingDetectionResult {
  if (driverShortName.toLocaleUpperCase("en-US") !== "MVT" || result.source !== "unknown") return result;
  return encodingResult("format", "UTF-8", 1);
}

function normalizeMapInfoFieldNames(header: Buffer): { header: Buffer; changed: boolean } {
  const text = header.toString("latin1");
  const usedNames = new Set<string>();
  let changed = false;
  const normalized = text.replace(
    /^([\t ]*)([^\r\n]*?)([\t ]+(?:Char|Integer|SmallInt|Decimal|Float|Date|Logical)\b[^\r\n]*;[\t ]*)$/gim,
    (_line, indent: string, originalName: string, typeAndTerminator: string) => {
      // Bytes below 0x40 cannot be trailing bytes in GBK, Big5, or Shift-JIS;
      // preserve 0x40-0x7e because those ranges can occur inside multibyte names.
      let name = originalName.replace(/[\x20-\x3f]/g, (character) =>
        /[A-Za-z0-9_]/.test(character) ? character : "_",
      );
      if (/^[0-9]/.test(name)) name = `_${name}`;
      if (name === "") name = "_field";
      const baseName = name;
      let suffix = 2;
      while (usedNames.has(name.toLowerCase())) {
        name = `${baseName}_${suffix++}`;
      }
      usedNames.add(name.toLowerCase());
      if (name !== originalName) changed = true;
      return `${indent}${name}${typeAndTerminator}`;
    },
  );
  return { header: changed ? Buffer.from(normalized, "latin1") : header, changed };
}

export async function prepareGisInput(
  filePath: string,
  encoding: string | undefined,
  baseEnvironment: NodeJS.ProcessEnv,
  zipFilenameEncoding?: string,
  replaceIncompleteUtf8Tails = false,
): Promise<PreparedGisInput> {
  const extension = path.extname(filePath).toLowerCase();
  const normalized = encoding ? normalizeTextEncoding(encoding) : undefined;
  const normalizedZipEncoding = normalizeZipFilenameEncoding(zipFilenameEncoding);
  const env = normalizedZipEncoding
    ? { ...baseEnvironment, CPL_ZIP_ENCODING: normalizedZipEncoding }
    : baseEnvironment;

  if (replaceIncompleteUtf8Tails) {
    if (isVirtualZipPath(filePath)) {
      throw new Error("Incomplete UTF-8 tail replacement is available only for standalone Shapefile files, not virtual ZIP paths.");
    }
    if (extension !== ".shp") {
      throw new Error("Incomplete UTF-8 tail replacement is available only for standalone Shapefile input.");
    }
    if (normalized !== "UTF-8") {
      throw new Error("Choose UTF-8 explicitly before replacing incomplete UTF-8 tails in a Shapefile.");
    }
  }

  if (isVirtualZipPath(filePath)) {
    if (normalized && ![".shp", ".tab"].includes(extension) && normalized !== "UTF-8") {
      throw new Error(`The ${extension || "source"} format cannot apply a ${normalized} override directly inside a GDAL virtual ZIP path.`);
    }
    return {
      path: filePath,
      env,
      ...([".shp", ".tab"].includes(extension) && normalized
        ? { openOptions: [`ENCODING=${toGdalEncodingName(normalized)}`] }
        : {}),
      ...(extension === ".shp" && normalized === "UTF-8"
        ? { warnings: ["A Shapefile inside a GDAL virtual ZIP path is read directly; invalid DBF field-name descriptors cannot be rewritten in a temporary copy."] }
        : {}),
      cleanup: async () => undefined,
    };
  }
  if (extension === ".shp") {
    const shapefileEnvironment = { ...env };
    delete shapefileEnvironment.SHAPE_ENCODING;
    const repairedCopy = replaceIncompleteUtf8Tails
      ? await stageShapefileWithIncompleteUtf8Tails(filePath)
      : undefined;
    let fieldNameCopy: Awaited<ReturnType<typeof stageShapefileWithSafeFieldNames>>;
    try {
      fieldNameCopy = normalized === "UTF-8"
        ? await stageShapefileWithSafeFieldNames(repairedCopy?.path ?? filePath)
        : undefined;
    } catch (error) {
      await repairedCopy?.cleanup();
      throw error;
    }
    const aliasSummary = fieldNameCopy?.aliases.slice(0, 8).map((field) => `${field.column}→${field.name}`).join(", ");
    const omittedAliases = Math.max(0, (fieldNameCopy?.aliases.length ?? 0) - 8);
    const warnings = [
      ...(repairedCopy ? [repairedCopy.warning] : []),
      ...(fieldNameCopy ? [`Invalid UTF-8 DBF field-name descriptors were replaced in a temporary copy (${aliasSummary}${omittedAliases > 0 ? `, and ${omittedAliases} more` : ""}); source files are unchanged.`] : []),
    ];
    return {
      path: fieldNameCopy?.path ?? repairedCopy?.path ?? filePath,
      env: shapefileEnvironment,
      ...(normalized ? { openOptions: [`ENCODING=${toGdalEncodingName(normalized)}`] } : {}),
      ...(warnings.length ? { warnings } : {}),
      cleanup: async () => {
        await fieldNameCopy?.cleanup();
        await repairedCopy?.cleanup();
      },
    };
  }
  if (!encoding && extension !== ".tab") return { path: filePath, env, cleanup: async () => undefined };
  if (extension === ".dxf") {
    // DXF declares its code page in $DWGCODEPAGE; GDAL reads that declaration
    // itself, and does not accept an encoding override for this driver.
    return { path: filePath, env, cleanup: async () => undefined };
  }
  if (extension === ".tab") {
    const charset = normalized ? MAPINFO_CHARSETS[normalized] : undefined;
    if (normalized && !charset) throw new Error(`MapInfo TAB cannot apply the ${normalized} encoding override. Choose UTF-8, GBK/CP936, Big5/CP950, or a supported Windows/ISO-8859 charset.`);
    const originalHeader = await readFile(filePath);
    const normalizedHeader = normalizeMapInfoFieldNames(originalHeader);
    if (!normalized && !normalizedHeader.changed) return { path: filePath, env, cleanup: async () => undefined };
    const directory = await mkdtemp(path.join(os.tmpdir(), "dbstudio-gis-"));
    try {
      const originalBase = path.basename(filePath, path.extname(filePath));
      const sourceDirectory = path.dirname(path.resolve(filePath));
      const entries = await readdir(sourceDirectory);
      const companionSuffixes = new Set([".tab", ".dat", ".map", ".id", ".ind"]);
      const companions = entries.filter((entry) => {
        const lower = entry.toLowerCase();
        return lower.startsWith(`${originalBase.toLowerCase()}.`) && companionSuffixes.has(lower.slice(originalBase.length));
      });
      if (!companions.some((entry) => entry.toLowerCase().endsWith(".tab"))) throw new Error("MapInfo TAB header was not found.");
      for (const entry of companions) await copyFile(path.join(sourceDirectory, entry), path.join(directory, entry));
      const tabName = companions.find((entry) => entry.toLowerCase().endsWith(".tab"))!;
      const tabPath = path.join(directory, tabName);
      let rewritten = normalizedHeader.header.toString("latin1");
      if (charset) {
        const originalText = originalHeader.toString("latin1");
        rewritten = rewritten.replace(/^\s*!charset\s+([^\r\n]+)$/im, `!charset ${charset}`);
        rewritten = rewritten.replace(/(\bCharset\s+")[^"]*(")/i, `$1${charset}$2`);
        if (rewritten === normalizedHeader.header.toString("latin1")) {
          const versionLine = /(^!version[^\r\n]*\r?\n)/im;
          rewritten = versionLine.test(originalText)
            ? originalText.replace(versionLine, `$1!charset ${charset}\r\n`)
            : `!charset ${charset}\r\n${originalText}`;
          rewritten = normalizeMapInfoFieldNames(Buffer.from(rewritten, "latin1")).header.toString("latin1");
        }
      }
      await writeFile(tabPath, Buffer.from(rewritten, "latin1"));
      return {
        path: tabPath,
        env,
        ...(normalizedHeader.changed ? { warnings: ["MapInfo TAB field names contained unsupported ASCII characters; an isolated copy replaces punctuation with underscores and prefixes leading digits. The source files are unchanged."] } : {}),
        cleanup: async () => rm(directory, { recursive: true, force: true }),
      };
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }
  if ([".geojson", ".json", ".csv"].includes(extension) && normalized !== "UTF-8") {
    const directory = await mkdtemp(path.join(os.tmpdir(), "dbstudio-gis-"));
    const utf8Path = path.join(directory, path.basename(filePath));
    try {
      await transcodeFileToUtf8(filePath, utf8Path, normalized!);
      return {
        path: utf8Path,
        env,
        cleanup: async () => rm(directory, { recursive: true, force: true }),
      };
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }
  if ([".geojson", ".json", ".kml", ".gpkg", ".mif"].includes(extension)) {
    return { path: filePath, env, cleanup: async () => undefined };
  }
  if (normalized !== "UTF-8") {
    throw new Error(`The ${extension || "source"} format manages text encoding internally and does not support a ${normalized} override.`);
  }
  return { path: filePath, env, cleanup: async () => undefined };
}

function encodingResult(source: EncodingSource, encoding: string | undefined, confidence: number | null, warnings: string[] = []): EncodingDetectionResult {
  return {
    ...(encoding ? source === "metadata" || source === "format" ? { declaredEncoding: encoding } : { detectedEncoding: encoding } : {}),
    source,
    confidence,
    warnings,
  };
}

async function detectDeclaredOrHeuristicEncoding(filePath: string): Promise<EncodingDetectionResult> {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".shp") {
    const cpgPath = await findCompanion(filePath, ".cpg");
    if (cpgPath) {
      try {
        const cpg = (await readFile(cpgPath, "utf8")).replace(/^\uFEFF/, "").trim().split(/[\r\n;]/, 1)[0]?.trim();
        if (cpg) {
          try {
            const declaredEncoding = normalizeTextEncoding(cpg);
            const warnings: string[] = [];
            const dbfPath = await findCompanion(filePath, ".dbf");
            if (dbfPath) {
              const ldid = await readDbfLdid(dbfPath);
              const ldidEncoding = ldid === undefined || ldid === 0 ? undefined : DBF_LDID_ENCODINGS[ldid];
              if (ldidEncoding && normalizeTextEncoding(ldidEncoding) !== declaredEncoding) {
                warnings.push(`The Shapefile .cpg declares ${declaredEncoding}, but DBF LDID declares ${ldidEncoding}; .cpg takes precedence, so verify the attribute preview.`);
              }
              const sample = await readDbfCharacterSample(dbfPath);
              if (sample.fields.length > 0 && declaredEncoding === "UTF-8" && isDbfSampleDecodable(sample.fields, declaredEncoding)) {
                const invalidField = await findInvalidDbfUtf8Field(filePath);
                if (invalidField) {
                  return {
                    declaredEncoding,
                    source: "unknown",
                    confidence: null,
                    warnings: [`The Shapefile .cpg declares UTF-8, but DBF record ${invalidField.recordNumber}, field ${invalidField.fieldName}, contains invalid UTF-8 bytes. Specify the source encoding manually and verify the attribute preview.`],
                  };
                }
              }
              if (sample.fields.length > 0 && !isDbfSampleDecodable(sample.fields, declaredEncoding)) {
                return {
                  declaredEncoding,
                  source: "unknown",
                  confidence: null,
                  warnings: [`The Shapefile .cpg declares ${declaredEncoding}, but sampled DBF character fields are not valid ${declaredEncoding}. Specify the source encoding manually and verify the preview.`],
                };
              }
            }
            return encodingResult("metadata", declaredEncoding, 1, warnings);
          }
          catch { return encodingResult("unknown", undefined, null, [`The Shapefile .cpg declaration is not recognized: ${cpg}. Specify the source encoding manually.`]); }
        }
      } catch { /* An unreadable .cpg is treated as absent. */ }
    }
    const dbfPath = await findCompanion(filePath, ".dbf");
    const ldid = dbfPath ? await readDbfLdid(dbfPath) : undefined;
    if (ldid !== undefined && ldid !== 0) {
      const mapped = DBF_LDID_ENCODINGS[ldid];
      if (mapped) {
        const sample = await readDbfCharacterSample(dbfPath!);
        if (sample.fields.length > 0 && !isDbfSampleDecodable(sample.fields, mapped)) {
          return {
            declaredEncoding: normalizeTextEncoding(mapped),
            source: "unknown",
            confidence: null,
            warnings: [`DBF LDID 0x${ldid.toString(16).padStart(2, "0").toUpperCase()} maps to ${mapped}, but sampled character fields are not valid ${mapped}. Specify the source encoding manually and verify the preview.`],
          };
        }
        return encodingResult("metadata", normalizeTextEncoding(mapped), 0.95, [
          `Encoding came from DBF LDID 0x${ldid.toString(16).padStart(2, "0").toUpperCase()}; LDID declarations can be inaccurate, so confirm the preview.`,
        ]);
      }
      return encodingResult("unknown", undefined, null, [`DBF LDID 0x${ldid.toString(16).padStart(2, "0").toUpperCase()} is not mapped. Specify the source encoding manually.`]);
    }
    return dbfPath
      ? detectDbfTextEncoding(dbfPath)
      : encodingResult("unknown", undefined, null, ["Shapefile DBF attributes are missing; specify the source encoding manually if attributes are required."]);
  }
  if (extension === ".tab" || extension === ".mif") {
    try {
      const header = await readHeader(filePath);
      const charset = header.match(/^\s*!charset\s+["']?([^\r\n"']+)/im)?.[1]
        ?? header.match(/\bCharset\s+["']([^"']+)["']/i)?.[1];
      if (charset) {
        const normalized = mapInfoCharsetToEncoding(charset.trim());
        return normalized
          ? encodingResult("metadata", normalized, 1)
          : encodingResult("unknown", undefined, null, [`MapInfo declares Charset "${charset.trim()}"; choose a concrete source encoding if the attribute preview is incorrect.`]);
      }
    } catch { /* Missing or unreadable header is reported below. */ }
    return encodingResult("unknown", undefined, null, ["MapInfo has no recognized Charset declaration. Specify the source encoding manually before importing."]);
  }
  if (extension === ".dxf") {
    try {
      const header = (await readHeaderBytes(filePath, 65_536)).toString("latin1");
      const codePage = header.match(/(?:^|\r?\n)\s*9\s*\r?\n\s*\$DWGCODEPAGE\s*\r?\n\s*3\s*\r?\n\s*([^\r\n]+)/i)?.[1]?.trim();
      if (codePage) {
        const normalized = mapDxfCodePageToEncoding(codePage);
        return normalized
          ? encodingResult("metadata", normalized, 1)
          : encodingResult("unknown", undefined, null, [`DXF declares an unsupported $DWGCODEPAGE value: ${codePage}. Specify the source encoding manually.`]);
      }
    } catch { /* Missing or unreadable header is reported below. */ }
    return encodingResult("unknown", undefined, null, ["DXF has no recognized $DWGCODEPAGE declaration. Specify the source encoding manually before importing."]);
  }
  if (extension === ".csv") {
    const headerBytes = await readHeaderBytes(filePath, 4096);
    const bomEncoding = detectBom(headerBytes);
    if (!bomEncoding) {
      return detectHeuristicTextEncoding(filePath);
    }
    if (!["UTF-8", "UTF-16LE", "UTF-16BE"].includes(bomEncoding)) {
      return encodingResult("unknown", undefined, null, [
        `CSV declares ${bomEncoding} with a byte-order mark, which is not supported for automatic CSV decoding. Choose a supported source encoding manually.`,
      ]);
    }
    if (!(await isFileValidEncoding(filePath, bomEncoding))) {
      return {
        declaredEncoding: bomEncoding,
        source: "unknown",
        confidence: null,
        warnings: [`CSV text contains invalid ${bomEncoding} byte sequences. Choose the source encoding manually before importing.`],
      };
    }
    return encodingResult("metadata", bomEncoding, 1);
  }
  if (extension === ".geojson" || extension === ".json") {
    const headerBytes = await readHeaderBytes(filePath, 4096);
    const bomEncoding = detectBom(headerBytes);
    const detectedEncoding = bomEncoding ?? "UTF-8";
    if (!(await isFileValidEncoding(filePath, detectedEncoding))) {
      return {
        ...(bomEncoding ? { declaredEncoding: bomEncoding } : {}),
        source: "unknown",
        confidence: null,
        warnings: [
          "JSON text contains invalid " + detectedEncoding + " byte sequences. Choose the source encoding manually before importing.",
        ],
      };
    }
    return encodingResult("metadata", detectedEncoding, 1);
  }
  if (extension === ".kml") {
    const headerBytes = await readHeaderBytes(filePath, 4096);
    const header = headerBytes.toString("latin1");
    const bom = detectBom(headerBytes);
    if (bom) return encodingResult("metadata", bom, 1);
    if (extension === ".kml") {
      const declared = header.match(/^\s*<\?xml[^>]*\bencoding\s*=\s*["']([^"']+)["']/i)?.[1];
      if (declared) {
        try { return encodingResult("metadata", normalizeTextEncoding(declared), 1); }
        catch { return encodingResult("unknown", undefined, null, [`KML XML declares an unsupported encoding: ${declared}.`]); }
      }
    }
    return encodingResult("metadata", "UTF-8", 1);
  }
  if (extension === ".gpkg") {
    const header = await readHeaderBytes(filePath, 64);
    const sqliteEncoding = header.length >= 60 ? header.readUInt32BE(56) : 1;
    if (sqliteEncoding === 2) return encodingResult("metadata", "UTF-16LE", 1);
    if (sqliteEncoding === 3) return encodingResult("metadata", "UTF-16BE", 1);
    return encodingResult("metadata", "UTF-8", 1);
  }
  return encodingResult("unknown", undefined, null, ["No encoding metadata reader is available for this format."]);
}

async function findCompanion(filePath: string, suffix: string): Promise<string | undefined> {
  const directory = path.dirname(path.resolve(filePath));
  const baseName = path.basename(filePath, path.extname(filePath));
  const expected = `${baseName}${suffix}`.toLowerCase();
  const entry = (await readdir(directory)).find((candidate) => candidate.toLowerCase() === expected);
  return entry ? path.join(directory, entry) : undefined;
}

function findIncompleteUtf8Tail(bytes: Buffer): number | undefined {
  for (let offset = 0; offset < bytes.length;) {
    const first = bytes[offset]!;
    if (first <= 0x7f) {
      offset += 1;
      continue;
    }

    const sequenceLength = first >= 0xc2 && first <= 0xdf ? 2
      : first >= 0xe0 && first <= 0xef ? 3
        : first >= 0xf0 && first <= 0xf4 ? 4
          : 0;
    if (sequenceLength === 0) throw new Error("Invalid UTF-8 lead or continuation byte.");

    const remaining = bytes.length - offset;
    const availableContinuationBytes = Math.min(sequenceLength - 1, remaining - 1);
    for (let index = 1; index <= availableContinuationBytes; index += 1) {
      const byte = bytes[offset + index]!;
      if (byte < 0x80 || byte > 0xbf) throw new Error("Invalid UTF-8 continuation byte.");
      if (index === 1 && first === 0xe0 && byte < 0xa0) throw new Error("Overlong UTF-8 sequence.");
      if (index === 1 && first === 0xed && byte > 0x9f) throw new Error("UTF-8 encoded surrogate value.");
      if (index === 1 && first === 0xf0 && byte < 0x90) throw new Error("Overlong UTF-8 sequence.");
      if (index === 1 && first === 0xf4 && byte > 0x8f) throw new Error("UTF-8 code point is out of range.");
    }
    if (remaining < sequenceLength) return offset;

    offset += sequenceLength;
  }
  return undefined;
}

async function stageShapefileWithIncompleteUtf8Tails(filePath: string): Promise<{
  path: string;
  warning: string;
  cleanup(): Promise<void>;
} | undefined> {
  const sourceDbf = await findCompanion(filePath, ".dbf");
  if (!sourceDbf) throw new Error("Could not find the DBF companion file needed to inspect UTF-8 text fields.");

  const directory = await mkdtemp(path.join(os.tmpdir(), "dbstudio-gis-utf8-tail-"));
  let handle;
  try {
    const sourceDirectory = path.dirname(path.resolve(filePath));
    const sourceBase = path.basename(filePath, path.extname(filePath));
    const stagedPath = path.join(directory, path.basename(filePath));
    const entries = await readdir(sourceDirectory, { withFileTypes: true });
    const companions = entries.filter((entry) => entry.isFile() && entry.name.toLowerCase().startsWith(`${sourceBase.toLowerCase()}.`));
    for (const entry of companions) await copyFile(path.join(sourceDirectory, entry.name), path.join(directory, entry.name));
    const stagedDbf = await findCompanion(stagedPath, ".dbf");
    if (!stagedDbf) throw new Error("The DBF companion file was not copied to the temporary Shapefile directory.");

    handle = await open(stagedDbf, "r+");
    const stats = await handle.stat();
    const header = Buffer.alloc(32);
    const headerRead = await handle.read(header, 0, header.length, 0);
    if (headerRead.bytesRead !== header.length) throw new Error("The DBF header is incomplete; UTF-8 tail replacement cannot continue.");
    const recordCount = header.readUInt32LE(4);
    const headerLength = header.readUInt16LE(8);
    const recordLength = header.readUInt16LE(10);
    if (headerLength < 33 || headerLength > 32_768 || recordLength < 1 || headerLength > stats.size) {
      throw new Error("The DBF header has invalid dimensions; UTF-8 tail replacement cannot continue.");
    }
    const descriptorLength = headerLength - 32;
    const descriptors = Buffer.alloc(descriptorLength);
    const descriptorRead = await handle.read(descriptors, 0, descriptorLength, 32);
    if (descriptorRead.bytesRead !== descriptorLength) throw new Error("The DBF field descriptors are incomplete; UTF-8 tail replacement cannot continue.");
    const terminator = descriptors.indexOf(0x0d);
    if (terminator < 0 || terminator % 32 !== 0) throw new Error("The DBF field descriptor terminator is invalid.");

    const characterFields: Array<{ offset: number; length: number; name: string }> = [];
    let fieldOffset = 1;
    let fieldIndex = 0;
    for (let offset = 0; offset < terminator; offset += 32, fieldIndex += 1) {
      const fieldType = String.fromCharCode(descriptors[offset + 11] ?? 0);
      const fieldLength = descriptors[offset + 16] ?? 0;
      if (fieldLength < 1) throw new Error("A DBF field has an invalid width; UTF-8 tail replacement cannot continue.");
      if (fieldType === "C") {
        const rawName = descriptors.subarray(offset, offset + 11);
        const nameEnd = rawName.indexOf(0);
        const nameBytes = rawName.subarray(0, nameEnd < 0 ? rawName.length : nameEnd);
        const name = [...nameBytes].every((byte) => byte >= 0x20 && byte <= 0x7e)
          ? nameBytes.toString("ascii")
          : `field ${fieldIndex + 1}`;
        characterFields.push({ offset: fieldOffset, length: fieldLength, name });
      }
      fieldOffset += fieldLength;
    }
    if (fieldOffset !== recordLength) throw new Error("The DBF field widths do not match the declared record width.");
    if (!characterFields.length) throw new Error("The DBF has no character fields to inspect for incomplete UTF-8 tails.");
    const requiredSize = headerLength + recordCount * recordLength;
    if (!Number.isSafeInteger(requiredSize) || requiredSize > stats.size) {
      throw new Error("The DBF record data is truncated; UTF-8 tail replacement cannot continue.");
    }

    const rowsPerChunk = Math.max(1, Math.floor((1024 * 1024) / recordLength));
    const recordBuffer = Buffer.alloc(rowsPerChunk * recordLength);
    const fieldCounts = new Map<string, number>();
    for (let firstRow = 0; firstRow < recordCount; firstRow += rowsPerChunk) {
      const requestedRows = Math.min(rowsPerChunk, recordCount - firstRow);
      const requestedBytes = requestedRows * recordLength;
      const position = headerLength + firstRow * recordLength;
      const read = await handle.read(recordBuffer, 0, requestedBytes, position);
      if (read.bytesRead !== requestedBytes) throw new Error("The DBF record data became incomplete during UTF-8 validation.");
      let changed = false;
      for (let row = 0; row < requestedRows; row += 1) {
        const rowOffset = row * recordLength;
        if (recordBuffer[rowOffset] === 0x2a) continue;
        for (const field of characterFields) {
          const valueOffset = rowOffset + field.offset;
          const valueEnd = valueOffset + field.length;
          let contentEnd = valueEnd;
          while (contentEnd > valueOffset && (recordBuffer[contentEnd - 1] === 0x20 || recordBuffer[contentEnd - 1] === 0x00)) contentEnd -= 1;
          try {
            const incompleteOffset = findIncompleteUtf8Tail(recordBuffer.subarray(valueOffset, contentEnd));
            if (incompleteOffset === undefined) continue;
            const tailOffset = valueOffset + incompleteOffset;
            recordBuffer[tailOffset] = 0x3f;
            recordBuffer.fill(0x20, tailOffset + 1, contentEnd);
            fieldCounts.set(field.name, (fieldCounts.get(field.name) ?? 0) + 1);
            changed = true;
          } catch {
            throw new Error(`DBF record ${firstRow + row + 1}, field "${field.name}" contains invalid UTF-8 before an incomplete terminal code point. Only incomplete terminal UTF-8 code points can be replaced.`);
          }
        }
      }
      if (changed) {
        const write = await handle.write(recordBuffer, 0, requestedBytes, position);
        if (write.bytesWritten !== requestedBytes) throw new Error("The temporary DBF record could not be written completely.");
      }
    }

    const total = [...fieldCounts.values()].reduce((sum, count) => sum + count, 0);
    if (total === 0) {
      await handle.close();
      handle = undefined;
      await rm(directory, { recursive: true, force: true });
      return undefined;
    }
    const summary = [...fieldCounts.entries()].map(([field, count]) => `${field}: ${count} record(s)`).join(", ");
    await handle.close();
    handle = undefined;
    return {
      path: stagedPath,
      warning: `Incomplete UTF-8 terminal code points were replaced with "?" in a temporary Shapefile copy (${summary}); source files are unchanged. Other invalid UTF-8 sequences are rejected.`,
      cleanup: async () => rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    await handle?.close();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function stageShapefileWithSafeFieldNames(filePath: string): Promise<{
  path: string;
  aliases: Array<{ column: number; name: string }>;
  cleanup(): Promise<void>;
} | undefined> {
  const dbfPath = await findCompanion(filePath, ".dbf");
  if (!dbfPath) return undefined;

  let source;
  try {
    source = await open(dbfPath, "r");
    const header = Buffer.alloc(32);
    const headerRead = await source.read(header, 0, header.length, 0);
    if (headerRead.bytesRead !== header.length) return undefined;
    const headerLength = header.readUInt16LE(8);
    if (headerLength < 33 || headerLength > 32_768) return undefined;
    const descriptorLength = headerLength - 32;
    const descriptors = Buffer.alloc(descriptorLength);
    const descriptorRead = await source.read(descriptors, 0, descriptorLength, 32);
    if (descriptorRead.bytesRead !== descriptorLength) return undefined;

    const decoder = new TextDecoder("utf-8", { fatal: true });
    const fields: Array<{ offset: number; name: string; validUtf8: boolean }> = [];
    for (let offset = 0, fieldIndex = 0; offset + 32 <= descriptors.length && descriptors[offset] !== 0x0d; offset += 32, fieldIndex += 1) {
      const rawName = descriptors.subarray(offset, offset + 11);
      const terminator = rawName.indexOf(0);
      const nameBytes = rawName.subarray(0, terminator < 0 ? rawName.length : terminator);
      let decodedName = "";
      let validUtf8 = true;
      try {
        decodedName = decoder.decode(nameBytes);
      } catch {
        validUtf8 = false;
      }
      fields.push({ offset, name: decodedName, validUtf8 });
    }
    const usedNames = new Set(fields.filter((field) => field.validUtf8).map((field) => field.name.toLowerCase()));
    const aliases: Array<{ offset: number; column: number; name: string }> = [];
    fields.forEach((field, fieldIndex) => {
      if (field.validUtf8) return;
      const baseAlias = `DBF${fieldIndex + 1}`;
      let alias = baseAlias;
      let suffix = 2;
      while (usedNames.has(alias.toLowerCase())) alias = `${baseAlias.slice(0, 7)}_${suffix++}`;
      usedNames.add(alias.toLowerCase());
      aliases.push({ offset: field.offset, column: fieldIndex + 1, name: alias });
    });
    if (aliases.length === 0) return undefined;

    const directory = await mkdtemp(path.join(os.tmpdir(), "dbstudio-gis-shp-"));
    try {
      const sourceBase = path.basename(filePath, path.extname(filePath));
      const stagedPath = path.join(directory, `${sourceBase}.shp`);
      for (const suffix of [".shp", ".shx", ".dbf", ".prj", ".cpg"] as const) {
        const companion = await findCompanion(filePath, suffix);
        if (companion) await copyFile(companion, path.join(directory, `${sourceBase}${suffix}`));
      }
      const stagedDbf = path.join(directory, `${sourceBase}.dbf`);
      let staged;
      try {
        staged = await open(stagedDbf, "r+");
        for (const alias of aliases) {
          const fieldName = Buffer.alloc(11);
          fieldName.write(alias.name, 0, 10, "ascii");
          await staged.write(fieldName, 0, fieldName.length, 32 + alias.offset);
        }
      } finally {
        await staged?.close();
      }
      return {
        path: stagedPath,
        aliases: aliases.map(({ column, name }) => ({ column, name })),
        cleanup: async () => rm(directory, { recursive: true, force: true }),
      };
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  } finally {
    await source?.close();
  }
}

async function readDbfLdid(filePath: string): Promise<number | undefined> {
  let handle;
  try {
    handle = await open(filePath, "r");
    const header = Buffer.alloc(32);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    return bytesRead >= 30 ? header[29] : undefined;
  } catch {
    return undefined;
  } finally {
    await handle?.close();
  }
}

async function detectHeuristicTextEncoding(filePath: string): Promise<EncodingDetectionResult> {
  const sample = await readHeaderBytes(filePath, MAX_TEXT_ENCODING_SAMPLE_BYTES);
  if (!sample.some((byte) => byte >= 0x80)) {
    if (await isEntireFileAsciiCompatible(filePath)) {
      return encodingResult("ascii-compatible", "UTF-8", null, [
        "The complete CSV contains only non-NUL ASCII bytes. UTF-8 and supported ASCII-compatible encodings decode its content identically; the original source encoding remains unknown.",
      ]);
    }
    return encodingResult("unknown", undefined, null, [
      "The initial CSV sample is ASCII-only, but complete-file validation found non-ASCII or NUL bytes. Specify the source encoding manually.",
    ]);
  }

  const candidates = chardet.analyse(sample)
    .map((item) => {
      try {
        return {
          encoding: normalizeTextEncoding(item.name),
          confidence: Math.max(0, Math.min(1, item.confidence / 100)),
        };
      } catch {
        return undefined;
      }
    })
    .filter((item): item is { encoding: string; confidence: number } => item !== undefined && item.encoding !== "ASCII")
    .reduce<Array<{ encoding: string; confidence: number }>>((unique, item) => {
      const existing = unique.find((candidate) => candidate.encoding === item.encoding);
      if (existing) existing.confidence = Math.max(existing.confidence, item.confidence);
      else unique.push(item);
      return unique;
    }, [])
    .sort((left, right) => right.confidence - left.confidence);

  if (candidates.length === 0) {
    return encodingResult("unknown", undefined, null, [
      "Text sample has no usable encoding candidate. Specify the source encoding manually.",
    ]);
  }

  let validated: { encoding: string; confidence: number } | undefined;
  for (const candidate of candidates) {
    if (await isFileValidEncoding(filePath, candidate.encoding)) {
      validated = candidate;
      break;
    }
  }

  const candidate = validated ?? candidates[0]!;
  const nextConfidence = candidates.find((item) => item.encoding !== candidate.encoding)?.confidence ?? 0;
  const margin = candidate.confidence - nextConfidence;
  const highConfidence = validated !== undefined && candidate.confidence >= 0.9 && margin >= 0.15;
  const message = highConfidence
    ? `${candidate.encoding} was inferred from a bounded text sample and strict decoding validated the complete file; verify the attribute preview before importing.`
    : `${candidate.encoding} is the best full-file-decodable encoding candidate (${Math.round(candidate.confidence * 100)}%) from a bounded text sample, but the confidence margin or validation is insufficient. Specify the source encoding manually and verify the attribute preview.`;
  return encodingResult(highConfidence ? "heuristic" : "unknown", candidate.encoding, candidate.confidence, [message]);
}

async function isEntireFileAsciiCompatible(filePath: string): Promise<boolean> {
  try {
    for await (const chunk of createReadStream(filePath) as AsyncIterable<Buffer>) {
      if (chunk.some((byte) => byte === 0 || byte >= 0x80)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function isDbfAsciiCompatible(filePath: string): Promise<{ compatible: boolean; hasNulPadding: boolean }> {
  let handle;
  try {
    handle = await open(filePath, "r");
    const stats = await handle.stat();
    const header = Buffer.alloc(32);
    const headerRead = await handle.read(header, 0, header.length, 0);
    if (headerRead.bytesRead !== header.length) return { compatible: false, hasNulPadding: false };
    const recordCount = header.readUInt32LE(4);
    const headerLength = header.readUInt16LE(8);
    const recordLength = header.readUInt16LE(10);
    if (recordCount === 0 || headerLength < 33 || recordLength < 1 || headerLength > stats.size ||
        headerLength + recordCount * recordLength > stats.size) {
      return { compatible: false, hasNulPadding: false };
    }

    const descriptors = Buffer.alloc(headerLength - 32);
    const descriptorRead = await handle.read(descriptors, 0, descriptors.length, 32);
    if (descriptorRead.bytesRead !== descriptors.length) return { compatible: false, hasNulPadding: false };
    const characterFields: Array<{ offset: number; length: number }> = [];
    let fieldOffset = 1;
    let foundTerminator = false;
    for (let offset = 0; offset < descriptors.length; offset += 32) {
      if (descriptors[offset] === 0x0d) {
        foundTerminator = true;
        break;
      }
      if (offset + 32 > descriptors.length) return { compatible: false, hasNulPadding: false };
      const fieldType = String.fromCharCode(descriptors[offset + 11] ?? 0);
      const fieldLength = descriptors[offset + 16] ?? 0;
      if (fieldType === "C" && fieldLength > 0) characterFields.push({ offset: fieldOffset, length: fieldLength });
      fieldOffset += fieldLength;
    }
    if (!foundTerminator || fieldOffset > recordLength || characterFields.length === 0) {
      return { compatible: false, hasNulPadding: false };
    }

    const rowsPerChunk = Math.max(1, Math.floor((1024 * 1024) / recordLength));
    const records = Buffer.alloc(rowsPerChunk * recordLength);
    let hasNulPadding = false;
    for (let firstRow = 0; firstRow < recordCount; firstRow += rowsPerChunk) {
      const rowCount = Math.min(rowsPerChunk, recordCount - firstRow);
      const byteCount = rowCount * recordLength;
      let bytesRead = 0;
      while (bytesRead < byteCount) {
        const result = await handle.read(
          records,
          bytesRead,
          byteCount - bytesRead,
          headerLength + firstRow * recordLength + bytesRead,
        );
        if (result.bytesRead === 0) return { compatible: false, hasNulPadding: false };
        bytesRead += result.bytesRead;
      }
      for (let row = 0; row < rowCount; row += 1) {
        const rowOffset = row * recordLength;
        if (records[rowOffset] === 0x2a) continue;
        for (const field of characterFields) {
          let reachedNulPadding = false;
          for (let index = 0; index < field.length; index += 1) {
            const byte = records[rowOffset + field.offset + index];
            if (byte === 0) {
              reachedNulPadding = true;
              hasNulPadding = true;
            } else if (byte >= 0x80 || reachedNulPadding) {
              return { compatible: false, hasNulPadding: false };
            }
          }
        }
      }
    }
    return { compatible: true, hasNulPadding };
  } catch {
    return { compatible: false, hasNulPadding: false };
  } finally {
    await handle?.close();
  }
}

async function detectDbfTextEncoding(filePath: string): Promise<EncodingDetectionResult> {
  const sampleResult = await readDbfCharacterSample(filePath);
  const { fields, warning } = sampleResult;
  if (fields.length === 0) {
    return encodingResult("unknown", undefined, null, [warning ?? "No usable DBF character-field sample was available. Specify the source encoding manually."]);
  }
  if (!sampleResult.hasNonAscii) {
    const ascii = await isDbfAsciiCompatible(filePath);
    if (ascii.compatible) {
      return encodingResult("ascii-compatible", "UTF-8", null, [
        ascii.hasNulPadding
          ? "Complete DBF character fields contain only ASCII bytes with trailing NUL padding; the original code page remains unknown."
          : "Complete DBF character fields contain only ASCII bytes; the original code page remains unknown.",
      ]);
    }
    return encodingResult("unknown", undefined, null, ["DBF sample contains only ASCII text, but complete-file validation found non-ASCII bytes or unsafe NUL placement. Specify the source encoding manually."]);
  }
  const sample = Buffer.concat(fields);
  let validUtf8 = true;
  try { new TextDecoder("utf-8", { fatal: true }).decode(sample); }
  catch { validUtf8 = false; }
  const candidates = chardet.analyse(sample)
    .map((item) => {
      try { return { encoding: normalizeTextEncoding(item.name), confidence: Math.max(0, Math.min(1, item.confidence / 100)) }; }
      catch { return undefined; }
    })
    .filter((item): item is { encoding: string; confidence: number } => item !== undefined && item.encoding !== "ASCII");
  const top = candidates[0];
  const next = candidates.find((item) => item.encoding !== top?.encoding);
  if (top && top.confidence >= 0.8 && top.confidence - (next?.confidence ?? 0) >= 0.1 &&
      ((validUtf8 && top.encoding === "UTF-8") || (!validUtf8 && top.encoding !== "UTF-8"))) {
    return encodingResult("heuristic", top.encoding, top.confidence, [`${top.encoding} was inferred from DBF character-field samples; detection is heuristic, so verify the preview.`]);
  }
  return encodingResult("unknown", top?.encoding, top?.confidence ?? null, ["DBF character-field samples do not identify one encoding with high confidence. Choose the source encoding manually before importing."]);
}

interface DbfCharacterSample {
  fields: Buffer[];
  hasNonAscii: boolean;
  warning?: string;
}

async function readDbfCharacterSample(filePath: string): Promise<DbfCharacterSample> {
  let handle;
  try {
    handle = await open(filePath, "r");
    const stats = await handle.stat();
    const header = Buffer.alloc(32);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (bytesRead < 32) return { fields: [], hasNonAscii: false, warning: "Shapefile DBF is too short to inspect. Specify the source encoding manually." };
    const headerLength = header.readUInt16LE(8);
    const recordLength = header.readUInt16LE(10);
    if (headerLength < 33 || recordLength < 1 || headerLength > 65535) {
      return { fields: [], hasNonAscii: false, warning: "Shapefile DBF header is invalid; specify the source encoding manually." };
    }
    const descriptorLength = Math.min(headerLength - 32, 32768);
    const descriptors = Buffer.alloc(descriptorLength);
    const descriptorRead = await handle.read(descriptors, 0, descriptorLength, 32);
    const characterFields: Array<{ offset: number; length: number }> = [];
    let fieldOffset = 1; // DBF records begin with a deletion flag.
    for (let offset = 0; offset + 32 <= descriptorRead.bytesRead && descriptors[offset] !== 0x0d; offset += 32) {
      const fieldType = String.fromCharCode(descriptors[offset + 11] ?? 0);
      const fieldLength = descriptors[offset + 16] ?? 0;
      if (fieldType === "C" && fieldLength > 0) characterFields.push({ offset: fieldOffset, length: fieldLength });
      fieldOffset += fieldLength;
    }
    if (fieldOffset > recordLength) {
      return { fields: [], hasNonAscii: false, warning: "DBF field descriptors exceed the declared record length; specify the source encoding manually." };
    }
    if (!characterFields.length || headerLength >= stats.size) {
      return { fields: [], hasNonAscii: false, warning: "No DBF character fields are available for encoding detection. Specify the source encoding manually." };
    }
    const sampleSize = Math.min(stats.size - headerLength, 4 * 1024 * 1024);
    const records = Buffer.alloc(sampleSize);
    const recordRead = await handle.read(records, 0, sampleSize, headerLength);
    const fields: Buffer[] = [];
    let sampledBytes = 0;
    let hasNonAscii = false;
    const maxRows = Math.min(Math.floor(recordRead.bytesRead / recordLength), 500);
    for (let row = 0; row < maxRows && sampledBytes < 64 * 1024; row += 1) {
      const rowOffset = row * recordLength;
      if (records[rowOffset] === 0x2a) continue;
      for (const field of characterFields) {
        const valueOffset = rowOffset + field.offset;
        if (valueOffset + field.length <= rowOffset + recordLength) {
          const value = records.subarray(valueOffset, valueOffset + field.length);
          if (sampledBytes + value.length > 64 * 1024) break;
          fields.push(value);
          sampledBytes += value.length;
          if (value.some((byte) => byte >= 0x80)) hasNonAscii = true;
        }
      }
    }
    return fields.length > 0
      ? { fields, hasNonAscii }
      : { fields: [], hasNonAscii: false, warning: "No usable DBF character-field sample was available. Specify the source encoding manually." };
  } catch {
    return { fields: [], hasNonAscii: false, warning: "No usable DBF character-field sample was available. Specify the source encoding manually." };
  } finally {
    await handle?.close();
  }
}

export interface InvalidDbfUtf8Field {
  recordNumber: number;
  fieldName: string;
}

export async function findInvalidDbfUtf8Field(shapefilePath: string): Promise<InvalidDbfUtf8Field | undefined> {
  const dbfPath = await findCompanion(shapefilePath, ".dbf");
  if (!dbfPath) return undefined;
  let handle;
  try {
    handle = await open(dbfPath, "r");
    const stats = await handle.stat();
    const header = Buffer.alloc(32);
    const headerRead = await handle.read(header, 0, header.length, 0);
    if (headerRead.bytesRead < header.length) return undefined;
    const recordCount = header.readUInt32LE(4);
    const headerLength = header.readUInt16LE(8);
    const recordLength = header.readUInt16LE(10);
    if (headerLength < 33 || recordLength < 1 || headerLength >= stats.size) return undefined;

    const descriptorLength = Math.min(headerLength - 32, 32768);
    const descriptors = Buffer.alloc(descriptorLength);
    const descriptorRead = await handle.read(descriptors, 0, descriptorLength, 32);
    const characterFields: Array<{ offset: number; length: number; name: string }> = [];
    let fieldOffset = 1;
    let fieldIndex = 0;
    for (let offset = 0; offset + 32 <= descriptorRead.bytesRead && descriptors[offset] !== 0x0d; offset += 32) {
      const fieldType = String.fromCharCode(descriptors[offset + 11] ?? 0);
      const fieldLength = descriptors[offset + 16] ?? 0;
      if (fieldType === "C" && fieldLength > 0) {
        const rawName = descriptors.subarray(offset, offset + 11);
        const terminator = rawName.indexOf(0);
        const nameBytes = rawName.subarray(0, terminator < 0 ? rawName.length : terminator);
        const name = [...nameBytes].every((byte) => byte >= 0x20 && byte <= 0x7e)
          ? nameBytes.toString("ascii")
          : `field ${fieldIndex + 1}`;
        characterFields.push({ offset: fieldOffset, length: fieldLength, name });
      }
      fieldOffset += fieldLength;
      fieldIndex += 1;
    }
    if (!characterFields.length || fieldOffset > recordLength) return undefined;

    const availableRecords = Math.floor((stats.size - headerLength) / recordLength);
    const rowsToScan = Math.min(recordCount, availableRecords);
    const rowsPerChunk = Math.max(1, Math.floor((1024 * 1024) / recordLength));
    const recordBuffer = Buffer.alloc(rowsPerChunk * recordLength);
    const bytesPerJoinedRow = characterFields.reduce((total, field) => total + field.length, 0) + characterFields.length + 1;
    const joinedBuffer = Buffer.alloc(rowsPerChunk * bytesPerJoinedRow);
    const decoder = new TextDecoder("utf-8", { fatal: true });

    for (let firstRow = 0; firstRow < rowsToScan; firstRow += rowsPerChunk) {
      const requestedRows = Math.min(rowsPerChunk, rowsToScan - firstRow);
      const requestedBytes = requestedRows * recordLength;
      const read = await handle.read(recordBuffer, 0, requestedBytes, headerLength + firstRow * recordLength);
      const readRows = Math.floor(read.bytesRead / recordLength);
      let joinedLength = 0;
      for (let row = 0; row < readRows; row += 1) {
        const rowOffset = row * recordLength;
        if (recordBuffer[rowOffset] === 0x2a) continue;
        for (const field of characterFields) {
          const valueOffset = rowOffset + field.offset;
          recordBuffer.copy(joinedBuffer, joinedLength, valueOffset, valueOffset + field.length);
          joinedLength += field.length;
          joinedBuffer[joinedLength++] = 0x20;
        }
        joinedBuffer[joinedLength++] = 0x0a;
      }
      try {
        decoder.decode(joinedBuffer.subarray(0, joinedLength));
      } catch {
        for (let row = 0; row < readRows; row += 1) {
          const rowOffset = row * recordLength;
          if (recordBuffer[rowOffset] === 0x2a) continue;
          for (const field of characterFields) {
            const valueOffset = rowOffset + field.offset;
            try {
              decoder.decode(recordBuffer.subarray(valueOffset, valueOffset + field.length));
            } catch {
              return { recordNumber: firstRow + row + 1, fieldName: field.name };
            }
          }
        }
        return undefined;
      }
      if (readRows < requestedRows) break;
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    await handle?.close();
  }
}

function isDbfSampleDecodable(fields: Buffer[], encoding: string): boolean {
  if (encoding === "ASCII") return fields.every((field) => field.every((byte) => byte < 0x80));
  const label = DECODER_LABELS[encoding] ?? encoding;
  try {
    const decoder = new TextDecoder(label, { fatal: true });
    for (const field of fields) decoder.decode(field);
    return true;
  } catch {
    return false;
  }
}

function mapInfoCharsetToEncoding(charset: string): string | undefined {
  const key = charset.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (key === "NEUTRAL") return undefined;
  const names: Record<string, string> = {
    UTF8: "UTF-8", WINDOWSSIMPCHINESE: "CP936", WINDOWSCHINESESIMPLIFIED: "CP936",
    WINDOWSTRADCHINESE: "CP950", WINDOWSCHINESETRADITIONAL: "CP950",
    WINDOWSLATIN1: "CP1252", WINDOWSLATIN2: "CP1250", WINDOWSCYRILLIC: "CP1251",
    WINDOWSGREEK: "CP1253", WINDOWSTURKISH: "CP1254", WINDOWSHEBREW: "CP1255",
    WINDOWSARABIC: "CP1256", WINDOWSBALTICRIM: "CP1257", WINDOWSVIETNAMESE: "CP1258",
    WINDOWSTHAI: "CP874", CP936: "CP936", CP950: "CP950", CP1252: "CP1252", CP1251: "CP1251",
  };
  try { return normalizeTextEncoding(names[key] ?? charset); }
  catch { return undefined; }
}

function mapDxfCodePageToEncoding(codePage: string): string | undefined {
  const value = codePage.trim();
  const label = /^ANSI[_-](\d+)$/i.exec(value)?.[1];
  if (!label) return undefined;
  try { return normalizeTextEncoding(`CP${label}`); }
  catch { return undefined; }
}

function detectBom(header: Buffer): string | undefined {
  if (header.length >= 4 && header[0] === 0x00 && header[1] === 0x00 && header[2] === 0xfe && header[3] === 0xff) return "UTF-32BE";
  if (header.length >= 4 && header[0] === 0xff && header[1] === 0xfe && header[2] === 0x00 && header[3] === 0x00) return "UTF-32LE";
  if (header.length >= 3 && header[0] === 0xef && header[1] === 0xbb && header[2] === 0xbf) return "UTF-8";
  if (header.length >= 2 && header[0] === 0xfe && header[1] === 0xff) return "UTF-16BE";
  if (header.length >= 2 && header[0] === 0xff && header[1] === 0xfe) return "UTF-16LE";
  return undefined;
}

async function readHeader(filePath: string): Promise<string> {
  return (await readHeaderBytes(filePath, 4096)).toString("latin1");
}

async function readHeaderBytes(filePath: string, length: number): Promise<Buffer> {
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function mapInfoCharsetForEncoding(encoding: string): string | undefined {
  return MAPINFO_CHARSETS[encoding];
}
