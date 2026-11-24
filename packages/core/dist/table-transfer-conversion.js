import { isSpatialTransferValue } from "@db-studio/shared";
export function spatialTypeOf(dataType, engine) {
    const type = dataType.trim();
    const match = type.match(/^(geometry|geography)\b/i);
    if (match)
        return match[1].toLowerCase();
    if ((engine === "mysql" || engine === "mariadb" || engine === "sqlite")
        && /^(?:point|linestring|polygon|multipoint|multilinestring|multipolygon|geometrycollection)\b/i.test(type)) {
        return "geometry";
    }
    if (engine === "oracle" && /^(?:MDSYS\.)?SDO_GEOMETRY\b/i.test(type))
        return "geometry";
    return undefined;
}
export function supportsSpatialTransfer(engine, spatialType) {
    if (spatialType === "geometry")
        return ["postgres", "sqlserver", "mysql", "mariadb", "oracle", "sqlite"].includes(engine ?? "");
    return ["postgres", "sqlserver"].includes(engine ?? "");
}
function wkbDimensionCount(wkb) {
    if (wkb.length < 5 || (wkb[0] !== 0 && wkb[0] !== 1))
        return undefined;
    const bytes = Buffer.from(wkb.buffer, wkb.byteOffset, wkb.byteLength);
    const type = wkb[0] === 1 ? bytes.readUInt32LE(1) : bytes.readUInt32BE(1);
    const zFlag = (type & 0x8000_0000) !== 0;
    const mFlag = (type & 0x4000_0000) !== 0;
    if (zFlag || mFlag)
        return 2 + Number(zFlag) + Number(mFlag);
    const baseType = type & 0x1fff_ffff;
    if (baseType >= 3_000 && baseType < 4_000)
        return 4;
    if (baseType >= 1_000 && baseType < 3_000)
        return 3;
    if (baseType >= 1 && baseType <= 17)
        return 2;
    return undefined;
}
function familyOf(dataType, engine) {
    const type = dataType.trim().toUpperCase().replace(/\s+/g, " ");
    if (spatialTypeOf(type, engine))
        return "spatial";
    if (/^(?:JSON|JSONB)(?:\b|\s*\()/i.test(type))
        return "json";
    if (/^(?:BOOLEAN|BOOL)\b/.test(type) || (engine === "sqlserver" && /^BIT\b/.test(type))
        || ((engine === "mysql" || engine === "mariadb")
            && (/^TINYINT\s*\(\s*1\s*\)/.test(type) || /^BIT\s*\(\s*1\s*\)/.test(type))))
        return "boolean";
    if (/^(?:BLOB|BYTEA|RAW|LONG RAW|BINARY|VARBINARY|IMAGE)(?:\b|\s*\()/i.test(type))
        return "binary";
    if (engine === "sqlserver" && /^TIMESTAMP\b/.test(type))
        return "binary";
    if (/^(?:DATE|TIME|TIMESTAMP|TIMESTAMPTZ|TIMETZ|DATETIME|DATETIME2|DATETIMEOFFSET|SMALLDATETIME)(?:\b|\s*\()/i.test(type))
        return "temporal";
    if (/^(?:CHAR|NCHAR|VARCHAR|NVARCHAR|VARCHAR2|NVARCHAR2|CHARACTER|TEXT|TINYTEXT|MEDIUMTEXT|LONGTEXT|CLOB|NCLOB|XML|ENUM|SET|UUID|UNIQUEIDENTIFIER)(?:\b|\s*\()/i.test(type))
        return "text";
    if (/^(?:TINYINT|SMALLINT|MEDIUMINT|INT|INTEGER|BIGINT|INT2|INT4|INT8|SERIAL|SMALLSERIAL|BIGSERIAL)(?:\b|\s*\(|$)/i.test(type))
        return "integer";
    if (/^(?:DECIMAL|NUMERIC|NUMBER|MONEY|SMALLMONEY)(?:\b|\s*\()/i.test(type)) {
        const parameters = type.match(/\((\d+)\s*(?:,\s*(-?\d+)\s*)?\)/);
        if (parameters && parameters[2] !== undefined && Number(parameters[2]) === 0)
            return "integer";
        return "decimal";
    }
    if (/^(?:REAL|FLOAT|DOUBLE|BINARY_FLOAT|BINARY_DOUBLE)(?:\b|\s*\()/i.test(type))
        return "float";
    return "other";
}
function isTimeZoneAwareType(dataType, engine) {
    const type = dataType.trim().toUpperCase().replace(/\s+/g, " ");
    if (/^(?:TIMESTAMPTZ|TIMETZ|DATETIMEOFFSET)\b/.test(type))
        return true;
    if (/^(?:TIMESTAMP|TIME)(?:\s*\(\s*\d+\s*\))?\s+WITH\s+(?:LOCAL\s+)?TIME\s+ZONE\b/.test(type))
        return true;
    return (engine === "mysql" || engine === "mariadb") && /^TIMESTAMP(?:\b|\s*\()/.test(type);
}
function hasExplicitTimeZone(value) {
    const text = value.trim();
    if (!/[T ]\d{2}:\d{2}/.test(text))
        return false;
    if (/[zZ]$/.test(text))
        return true;
    const offset = text.match(/([+-])(\d{2}):?(\d{2})$/);
    if (!offset)
        return false;
    const hours = Number(offset[2]);
    const minutes = Number(offset[3]);
    return hours <= 14 && minutes < 60 && (hours < 14 || minutes === 0);
}
function parseDecimal(value) {
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint")
        return undefined;
    if (typeof value === "number" && !Number.isFinite(value))
        return undefined;
    const text = String(value).trim();
    const match = text.match(/^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/);
    if (!match)
        return undefined;
    const fraction = match[3] ?? match[4] ?? "";
    const exponent = Number(match[5] ?? 0);
    if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 10_000)
        return undefined;
    const rawDigits = `${match[2] ?? "0"}${fraction}`;
    const allDigits = rawDigits.replace(/^0+/, "") || "0";
    const scale = fraction.length - exponent;
    const integerDigits = scale <= 0
        ? `${allDigits}${"0".repeat(-scale)}`
        : allDigits.length > scale ? allDigits.slice(0, -scale) || "0" : "0";
    const fractionDigits = scale <= 0
        ? ""
        : (allDigits.length > scale ? allDigits.slice(-scale) : `${"0".repeat(scale - allDigits.length)}${allDigits}`).replace(/0+$/, "");
    const signedInteger = match[1] === "-" && integerDigits !== "0" ? `-${integerDigits}` : integerDigits;
    const hasFraction = fractionDigits.length > 0;
    if (hasFraction)
        return { integerDigits, fractionDigits, integerValue: "" };
    return { integerDigits, fractionDigits, integerValue: signedInteger };
}
function decimalTargetLimits(dataType) {
    const match = dataType.match(/\((\d+)\s*(?:,\s*(-?\d+)\s*)?\)/);
    if (!match)
        return {};
    return { precision: Number(match[1]), scale: Number(match[2] ?? 0) };
}
function serializeJson(value) {
    const ancestors = new Set();
    const validate = (current) => {
        if (current === null || typeof current === "string" || typeof current === "boolean")
            return;
        if (typeof current === "number") {
            if (!Number.isFinite(current))
                throw new Error("Non-finite numbers are not valid JSON values.");
            return;
        }
        if (typeof current !== "object" || current instanceof Date || current instanceof Uint8Array || current instanceof ArrayBuffer) {
            throw new Error("Value contains a non-JSON scalar.");
        }
        if (!Array.isArray(current) && Object.getPrototypeOf(current) !== Object.prototype && Object.getPrototypeOf(current) !== null) {
            throw new Error("Value contains a non-JSON object.");
        }
        if (ancestors.has(current))
            throw new Error("Value contains a cyclic reference.");
        ancestors.add(current);
        const children = Array.isArray(current) ? current : Object.values(current);
        for (const child of children)
            validate(child);
        ancestors.delete(current);
    };
    validate(value);
    const serialized = JSON.stringify(value);
    if (serialized === undefined)
        throw new Error("Value has no JSON representation.");
    return serialized;
}
function canonicalDecimal(value) {
    const parsed = parseDecimal(value);
    if (!parsed)
        return undefined;
    const fraction = parsed.fractionDigits;
    const isZero = parsed.integerDigits === "0" && fraction.length === 0;
    const sign = value.startsWith("-") && !isZero ? "-" : "";
    return `${sign}${parsed.integerDigits}${fraction ? `.${fraction}` : ""}`;
}
function mysqlJsonNumberRoundTrips(token) {
    if (!/[.eE]/.test(token)) {
        const integer = BigInt(token);
        if (integer >= -(1n << 63n) && integer <= (1n << 64n) - 1n)
            return true;
    }
    const numericValue = Number(token);
    if (!Number.isFinite(numericValue))
        return false;
    const source = canonicalDecimal(token);
    const roundTrip = canonicalDecimal(numericValue.toString());
    return source !== undefined && source === roundTrip;
}
function assertMySqlJsonNumbersRoundTrip(text) {
    let inString = false;
    let escaped = false;
    for (let index = 0; index < text.length; index += 1) {
        const character = text[index];
        if (inString) {
            if (escaped)
                escaped = false;
            else if (character === "\\")
                escaped = true;
            else if (character === '"')
                inString = false;
            continue;
        }
        if (character === '"') {
            inString = true;
            continue;
        }
        if (character !== "-" && (character < "0" || character > "9"))
            continue;
        const start = index;
        if (text[index] === "-")
            index += 1;
        while (index < text.length && text[index] >= "0" && text[index] <= "9")
            index += 1;
        if (text[index] === ".") {
            index += 1;
            while (index < text.length && text[index] >= "0" && text[index] <= "9")
                index += 1;
        }
        if (text[index] === "e" || text[index] === "E") {
            index += 1;
            if (text[index] === "+" || text[index] === "-")
                index += 1;
            while (index < text.length && text[index] >= "0" && text[index] <= "9")
                index += 1;
        }
        const token = text.slice(start, index);
        if (!mysqlJsonNumberRoundTrips(token)) {
            throw new Error("MySQL JSON would change this number when storing it; use a TEXT/LONGTEXT destination to preserve the JSON text.");
        }
        index -= 1;
    }
}
function integerRange(dataType, engine) {
    const type = dataType.trim().toUpperCase();
    const unsigned = /\bUNSIGNED\b/.test(type);
    if (/^TINYINT\b/.test(type)) {
        if (engine === "sqlserver")
            return { min: 0n, max: 255n };
        if (engine === "mysql" || engine === "mariadb")
            return unsigned
                ? { min: 0n, max: 255n }
                : { min: -128n, max: 127n };
    }
    if (engine === "mysql" || engine === "mariadb") {
        if (/^SMALLINT\b/.test(type))
            return unsigned
                ? { min: 0n, max: 65535n }
                : { min: -32768n, max: 32767n };
        if (/^MEDIUMINT\b/.test(type))
            return unsigned
                ? { min: 0n, max: 16777215n }
                : { min: -8388608n, max: 8388607n };
        if (/^(?:INT|INTEGER)\b/.test(type))
            return unsigned
                ? { min: 0n, max: 4294967295n }
                : { min: -2147483648n, max: 2147483647n };
        if (/^BIGINT\b/.test(type))
            return unsigned
                ? { min: 0n, max: 18446744073709551615n }
                : { min: -9223372036854775808n, max: 9223372036854775807n };
    }
    if (engine === "postgres" || engine === "sqlserver") {
        if (/^SMALLINT\b/.test(type) || (engine === "postgres" && /^INT2\b/.test(type)))
            return unsigned
                ? { min: 0n, max: 65535n }
                : { min: -32768n, max: 32767n };
        if (/^(?:INT|INTEGER|INT4)\b/.test(type))
            return { min: -2147483648n, max: 2147483647n };
        if (/^(?:BIGINT|INT8)\b/.test(type))
            return { min: -9223372036854775808n, max: 9223372036854775807n };
    }
    if (engine === "sqlite" && /^INTEGER\b/.test(type)) {
        return { min: -9223372036854775808n, max: 9223372036854775807n };
    }
    return {};
}
function requireDecimal(value, column) {
    const parsed = parseDecimal(value);
    if (!parsed)
        throw new Error(`Value is not a finite decimal number for ${column.dataType}.`);
    return parsed;
}
function normalizeBoolean(value) {
    if (typeof value === "boolean")
        return value;
    if (typeof value === "number" && (value === 0 || value === 1))
        return value === 1;
    if (typeof value === "bigint" && (value === 0n || value === 1n))
        return value === 1n;
    if (typeof value === "string") {
        const normalized = value.trim().toLowerCase();
        if (["true", "t", "yes", "y", "1"].includes(normalized))
            return true;
        if (["false", "f", "no", "n", "0"].includes(normalized))
            return false;
    }
    if (value instanceof Uint8Array && value.length === 1 && (value[0] === 0 || value[0] === 1))
        return value[0] === 1;
    throw new Error("Value cannot be converted to a boolean without guessing.");
}
function toText(value, sourceFamily) {
    if (typeof value === "string") {
        if (sourceFamily !== "json")
            return value;
        try {
            return serializeJson(JSON.parse(value));
        }
        catch {
            throw new Error("Source JSON text is invalid.");
        }
    }
    if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean")
        return String(value);
    if (value instanceof Date && Number.isFinite(value.getTime()))
        return value.toISOString();
    if (sourceFamily === "json" && value !== null && typeof value === "object" && !(value instanceof Uint8Array)) {
        try {
            return serializeJson(value);
        }
        catch {
            throw new Error("Source JSON value cannot be serialized.");
        }
    }
    throw new Error("Value is not a safely representable text scalar.");
}
export function convertTransferValue(value, source, target, sourceEngine, targetEngine, options = {}) {
    if (value === null)
        return null;
    const sourceFamily = familyOf(source.dataType, sourceEngine);
    const targetFamily = familyOf(target.dataType, targetEngine);
    try {
        if (value === undefined)
            throw new Error("Undefined cannot be transferred as a database value.");
        if (sourceFamily === "spatial" || targetFamily === "spatial") {
            const sourceSpatialType = spatialTypeOf(source.dataType, sourceEngine);
            const targetSpatialType = spatialTypeOf(target.dataType, targetEngine);
            if (!sourceSpatialType || !targetSpatialType) {
                throw new Error("Spatial columns can only be transferred to matching geometry or geography columns.");
            }
            if (sourceSpatialType !== targetSpatialType && !options.allowSpatialTypeConversion) {
                throw new Error(`Cannot convert ${sourceSpatialType} to ${targetSpatialType} without an explicit spatial-type conversion.`);
            }
            if (!supportsSpatialTransfer(sourceEngine, sourceSpatialType) || !supportsSpatialTransfer(targetEngine, targetSpatialType)) {
                throw new Error(sourceSpatialType === "geometry"
                    ? "Geometry row transfer supports PostgreSQL/PostGIS, SQL Server, MySQL, MariaDB, Oracle SDO_GEOMETRY, and SQLite/GeoPackage."
                    : "Geography row transfer supports PostgreSQL/PostGIS and SQL Server only.");
            }
            let wkb;
            let srid;
            if (isSpatialTransferValue(value)) {
                if (value.spatialType !== sourceSpatialType)
                    throw new Error("Spatial transfer source returned the wrong spatial value type.");
                wkb = Buffer.from(value.wkb);
                srid = value.srid;
            }
            else {
                if (typeof value !== "string")
                    throw new Error("Spatial transfer source did not return the WKB/SRID projection.");
                const encoded = value.trim().match(/^([0-9a-f]+):(null|-?\d+)$/i);
                if (!encoded || encoded[1].length % 2 !== 0)
                    throw new Error("Spatial transfer source returned malformed WKB/SRID data.");
                srid = encoded[2].toLowerCase() === "null" ? null : Number(encoded[2]);
                wkb = Buffer.from(encoded[1], "hex");
            }
            if (srid !== null && !Number.isSafeInteger(srid))
                throw new Error("Spatial transfer source returned an invalid SRID.");
            if ((targetEngine === "mysql" || targetEngine === "mariadb") && srid !== null && (srid < 0 || srid > 0xffff_ffff)) {
                throw new Error("MySQL/MariaDB geometry transfer requires an SRID from 0 through 4294967295.");
            }
            if (!wkb.length)
                throw new Error("Spatial transfer source returned empty WKB data.");
            if (targetEngine === "oracle" || targetEngine === "mysql" || targetEngine === "mariadb") {
                const dimensions = wkbDimensionCount(wkb);
                if (targetEngine === "oracle") {
                    // Oracle accepts XYZ/XYM/XYZM through EWKB normalization in its adapter.
                    // Keep rejecting WKB whose dimension layout cannot be recognized so an
                    // ordinate can never be silently dropped.
                    if (dimensions === undefined || dimensions < 2 || dimensions > 4) {
                        throw new Error("Oracle SDO_GEOMETRY row transfer requires a recognizable 2D, 3D or 4D WKB geometry.");
                    }
                }
                else if (dimensions !== 2) {
                    // MySQL and MariaDB reject dimensional WKB in ST_GeomFromWKB. Report
                    // that explicitly instead of surfacing the driver's opaque GIS error.
                    throw new Error("MySQL/MariaDB geometry row transfer supports XY geometries only; 3D/4D WKB is rejected to prevent ordinate loss.");
                }
            }
            return {
                kind: "db-studio-spatial-wkb",
                spatialType: targetSpatialType,
                wkb,
                // PostGIS and MySQL-family engines use SRID 0 for an unknown CRS;
                // Oracle SDO_GEOMETRY represents the same state with a NULL SDO_SRID.
                srid: targetEngine === "oracle" ? (srid === 0 ? null : srid) : (srid ?? 0),
            };
        }
        if (targetFamily === "boolean")
            return normalizeBoolean(value);
        if (targetFamily === "text")
            return toText(value, sourceFamily);
        if (targetFamily === "json") {
            const text = typeof value === "string" && sourceFamily === "json" ? value : serializeJson(value);
            if (targetEngine === "mysql")
                assertMySqlJsonNumbersRoundTrip(text);
            return text;
        }
        if (targetFamily === "binary") {
            if (value instanceof Uint8Array)
                return value;
            if (value instanceof ArrayBuffer)
                return new Uint8Array(value);
            throw new Error("Binary destinations accept byte arrays only; text encoding must be selected explicitly.");
        }
        if (targetFamily === "integer" || targetFamily === "decimal") {
            if (typeof value === "boolean")
                value = value ? 1 : 0;
            const parsed = requireDecimal(value, target);
            if (!parsed.integerValue) {
                if (targetFamily === "integer")
                    throw new Error("Fractional values cannot be transferred into an integer column.");
            }
            if (targetFamily === "integer") {
                const range = integerRange(target.dataType, targetEngine);
                const limits = decimalTargetLimits(target.dataType);
                if (limits.precision !== undefined && parsed.integerDigits.length > limits.precision) {
                    throw new Error(`Value exceeds the precision of ${target.dataType}.`);
                }
                if (parsed.integerValue && (range.min !== undefined || range.max !== undefined)) {
                    const integer = BigInt(parsed.integerValue);
                    if ((range.min !== undefined && integer < range.min) || (range.max !== undefined && integer > range.max)) {
                        throw new Error(`Value is outside the range of ${target.dataType}.`);
                    }
                }
                return typeof value === "number" && Number.isSafeInteger(value)
                    ? value
                    : parsed.integerValue;
            }
            const limits = decimalTargetLimits(target.dataType);
            if (limits.scale !== undefined && limits.scale < 0
                && (!parsed.integerValue || (parsed.integerValue !== "0"
                    && !parsed.integerValue.replace(/^-/, "").endsWith("0".repeat(-limits.scale))))) {
                throw new Error(`Value cannot be stored in ${target.dataType} without rounding.`);
            }
            if (limits.scale !== undefined && limits.scale >= 0 && parsed.fractionDigits.length > limits.scale) {
                throw new Error(`Value has more fractional digits than ${target.dataType} can store without rounding.`);
            }
            if (limits.precision !== undefined) {
                const integerDigits = parsed.integerDigits === "0" ? 0 : parsed.integerDigits.length;
                const allowedIntegerDigits = limits.precision - (limits.scale ?? 0);
                if (integerDigits > allowedIntegerDigits || parsed.fractionDigits.length > Math.max(0, limits.scale ?? 0)) {
                    throw new Error(`Value exceeds the precision of ${target.dataType}.`);
                }
            }
            if (typeof value === "string")
                return value.replace(/^([+-]?)\./, (_match, sign) => `${sign}0.`);
            return typeof value === "bigint" ? String(value) : value;
        }
        if (targetFamily === "float") {
            if (typeof value === "number" && Number.isFinite(value))
                return value;
            if (typeof value === "string" && parseDecimal(value) && Number.isFinite(Number(value)))
                return value;
            if (typeof value === "bigint" && Number.isFinite(Number(value)))
                return String(value);
            throw new Error("Value is not a finite numeric scalar.");
        }
        if (targetFamily === "temporal") {
            const sourceIsZoned = sourceFamily === "temporal" && isTimeZoneAwareType(source.dataType, sourceEngine);
            const targetIsZoned = isTimeZoneAwareType(target.dataType, targetEngine);
            if (sourceFamily === "temporal" && sourceIsZoned && !targetIsZoned) {
                throw new Error("A time-zone-aware source cannot be transferred to a time-zone-naive destination without an explicit conversion policy.");
            }
            if (sourceFamily === "temporal" && !sourceIsZoned && targetIsZoned) {
                throw new Error("A time-zone-aware destination requires a source time zone; implicit session-zone conversion is not supported.");
            }
            if (value instanceof Date) {
                if (!Number.isFinite(value.getTime()))
                    throw new Error("Date value is invalid.");
                if (targetIsZoned) {
                    if (targetEngine === "sqlserver" && /^DATETIMEOFFSET\b/i.test(target.dataType.trim())) {
                        return value.toISOString();
                    }
                    return new Date(value.getTime());
                }
                if (targetEngine !== "oracle" && target.dataType.trim().toUpperCase() === "DATE") {
                    const useUtc = sourceEngine === "sqlserver";
                    const year = useUtc ? value.getUTCFullYear() : value.getFullYear();
                    const month = (useUtc ? value.getUTCMonth() : value.getMonth()) + 1;
                    const day = useUtc ? value.getUTCDate() : value.getDate();
                    const hours = useUtc ? value.getUTCHours() : value.getHours();
                    const minutes = useUtc ? value.getUTCMinutes() : value.getMinutes();
                    const seconds = useUtc ? value.getUTCSeconds() : value.getSeconds();
                    const milliseconds = useUtc ? value.getUTCMilliseconds() : value.getMilliseconds();
                    if (hours !== 0 || minutes !== 0 || seconds !== 0 || milliseconds !== 0) {
                        throw new Error("Time-of-day would be lost when transferring into a DATE column.");
                    }
                    return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
                }
                return new Date(value.getTime());
            }
            if (typeof value === "string") {
                if (targetIsZoned) {
                    if (!hasExplicitTimeZone(value))
                        throw new Error("A time-zone-aware destination requires an explicit offset or Z suffix.");
                    const instant = new Date(value);
                    if (!Number.isFinite(instant.getTime()))
                        throw new Error("Date/time value is invalid.");
                    if (targetEngine === "sqlserver" && /^DATETIMEOFFSET\b/i.test(target.dataType.trim())) {
                        return instant.toISOString();
                    }
                    return instant;
                }
                if (hasExplicitTimeZone(value)) {
                    throw new Error("A time-zone-qualified value cannot be stored in a time-zone-naive destination without an explicit conversion policy.");
                }
                if (targetEngine === "oracle" && target.dataType.trim().toUpperCase() === "DATE" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
                    const date = new Date(`${value}T00:00:00`);
                    if (!Number.isFinite(date.getTime()))
                        throw new Error("Date value is invalid.");
                    return date;
                }
                return value;
            }
            throw new Error("Temporal destinations accept driver dates or date/time text only.");
        }
        if (sourceFamily === "binary" && !(value instanceof Uint8Array) && !(value instanceof ArrayBuffer)) {
            throw new Error("Source binary value is not a byte array.");
        }
        return value;
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`Cannot transfer '${source.name}' (${source.dataType}) to '${target.name}' (${target.dataType}): ${reason}`, { cause: error });
    }
}
//# sourceMappingURL=table-transfer-conversion.js.map