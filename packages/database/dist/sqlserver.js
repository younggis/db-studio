import sql from "mssql";
import { isQueryStreamCell, isSpatialTransferValue } from "@db-studio/shared";
import { assertSingleRowAffected, buildCreateTableStatement, buildTableTransferPageQuery, groupForeignKeyRows, queryStreamBatchSize, throwIfQueryStreamAborted, validateUpdateStatements } from "./adapter.js";
export function sqlServerConfigFromEnvironment(env = process.env) {
    const connectionString = env.DBSTUDIO_SQLSERVER_URL?.trim() || env.SQLSERVER_URL?.trim();
    const connectionTimeout = positiveInteger(env.SQLSERVER_CONNECT_TIMEOUT, 10_000, "SQLSERVER_CONNECT_TIMEOUT");
    const requestTimeout = positiveInteger(env.SQLSERVER_REQUEST_TIMEOUT, 30_000, "SQLSERVER_REQUEST_TIMEOUT");
    if (connectionString)
        return { connectionString, connectionTimeout, requestTimeout };
    const user = env.SQLSERVER_USER?.trim();
    if (!user)
        throw new Error("Set SQLSERVER_USER or DBSTUDIO_SQLSERVER_URL for SQL Server connections.");
    const port = positiveInteger(env.SQLSERVER_PORT, 1433, "SQLSERVER_PORT");
    if (port > 65_535)
        throw new Error("SQLSERVER_PORT must be between 1 and 65535.");
    return {
        server: env.SQLSERVER_HOST?.trim() || "127.0.0.1",
        port,
        user,
        password: env.SQLSERVER_PASSWORD ?? "",
        database: env.SQLSERVER_DATABASE?.trim() || undefined,
        encrypt: parseBoolean(env.SQLSERVER_ENCRYPT, true, "SQLSERVER_ENCRYPT"),
        trustServerCertificate: parseBoolean(env.SQLSERVER_TRUST_SERVER_CERTIFICATE, true, "SQLSERVER_TRUST_SERVER_CERTIFICATE"),
        connectionTimeout,
        requestTimeout,
    };
}
export class SqlServerAdapter {
    pool;
    connection;
    constructor(config) {
        const timeout = config.connectionTimeout ?? 10_000;
        const requestTimeout = config.requestTimeout ?? 30_000;
        const driverConfig = config.connectionString ?? {
            server: config.server ?? "127.0.0.1",
            port: config.port ?? 1433,
            user: config.user,
            password: config.password,
            database: config.database,
            connectionTimeout: timeout,
            requestTimeout,
            pool: { max: 4, min: 0, idleTimeoutMillis: 10_000 },
            options: {
                encrypt: config.encrypt ?? true,
                trustServerCertificate: config.trustServerCertificate ?? true,
            },
        };
        this.pool = new sql.ConnectionPool(driverConfig);
    }
    async testConnection() {
        const result = await (await this.connect()).request().query("SELECT DB_NAME() AS [database], CONVERT(nvarchar(128), SERVERPROPERTY('ProductVersion')) AS server_version");
        const row = result.recordset[0];
        if (!row)
            throw new Error("SQL Server returned no connection details.");
        return { database: row.database, serverVersion: row.server_version };
    }
    async query(statement, parameters = []) {
        const pool = await this.connect();
        const request = pool.request();
        bindParameters(request, parameters);
        return queryResult(await request.query(statement), statement);
    }
    async *queryStream(statement, parameters = [], options = {}) {
        const batchSize = queryStreamBatchSize(options);
        throwIfQueryStreamAborted(options.signal);
        const request = (await this.connect()).request();
        bindParameters(request, parameters);
        request.stream = true;
        let columns = [];
        request.on("recordset", (metadata) => { columns = Object.keys(metadata); });
        const stream = request.toReadableStream({ highWaterMark: batchSize, objectMode: true });
        const onAbort = () => request.cancel();
        options.signal?.addEventListener("abort", onAbort, { once: true });
        const completion = request.query(statement);
        const command = statement.trimStart().split(/\s+/, 1)[0]?.toUpperCase();
        let rows = [];
        let yielded = false;
        let completed = false;
        try {
            for await (const row of stream) {
                throwIfQueryStreamAborted(options.signal);
                rows.push(row);
                if (rows.length < batchSize)
                    continue;
                yielded = true;
                yield { columns, rows, rowCount: rows.length, command };
                rows = [];
            }
            const result = await completion;
            completed = true;
            throwIfQueryStreamAborted(options.signal);
            if (columns.length > 0) {
                if (rows.length > 0 || !yielded)
                    yield { columns, rows, rowCount: rows.length, command };
            }
            else {
                const affectedRows = result.rowsAffected?.reduce((total, count) => total + count, 0) ?? 0;
                yield { columns: [], rows: [], rowCount: affectedRows, command };
            }
        }
        finally {
            options.signal?.removeEventListener("abort", onAbort);
            if (!completed) {
                request.cancel();
                await completion.catch(() => undefined);
            }
        }
    }
    async updateRows(statements) {
        const batch = validateUpdateStatements(statements);
        if (batch.length === 0)
            return [];
        const transaction = new sql.Transaction(await this.connect());
        const results = [];
        await transaction.begin(sql.ISOLATION_LEVEL.READ_COMMITTED);
        try {
            for (const statement of batch) {
                const request = new sql.Request(transaction);
                bindParameters(request, statement.parameters);
                const result = queryResult(await request.query(statement.sql), statement.sql);
                assertSingleRowAffected(result.rowCount);
                results.push(result);
            }
            await transaction.commit();
            return results;
        }
        catch (error) {
            await transaction.rollback().catch(() => undefined);
            throw error;
        }
    }
    async listDatabases() {
        const result = await (await this.connect()).request().query("SELECT name FROM sys.databases WHERE state = 0 AND database_id > 0 ORDER BY name");
        return result.recordset.map((row) => row.name);
    }
    async listSchemas() {
        const result = await (await this.connect()).request().query("SELECT SCHEMA_NAME AS name FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME NOT IN ('sys', 'INFORMATION_SCHEMA') ORDER BY SCHEMA_NAME");
        return result.recordset.map((row) => row.name);
    }
    async listTables(schema = "dbo") {
        const request = (await this.connect()).request();
        request.input("schema", schema);
        const result = await request.query("SELECT TABLE_SCHEMA AS [schema], TABLE_NAME AS name, TABLE_TYPE AS table_type FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = @schema AND TABLE_TYPE IN ('BASE TABLE', 'VIEW') ORDER BY TABLE_NAME");
        return result.recordset.map((row) => ({
            schema: row.schema,
            name: row.name,
            type: row.table_type === "VIEW" ? "view" : "table",
        }));
    }
    async getTableColumns(table, schema = "dbo") {
        const request = (await this.connect()).request();
        request.input("schema", schema);
        request.input("table", table);
        const result = await request.query(`SELECT
         c.COLUMN_NAME AS name,
         c.DATA_TYPE AS data_type,
         c.CHARACTER_MAXIMUM_LENGTH AS maximum_length,
         CAST(CASE WHEN c.IS_NULLABLE = 'YES' THEN 1 ELSE 0 END AS bit) AS nullable,
         c.COLUMN_DEFAULT AS default_value,
         CAST(CASE WHEN EXISTS (
           SELECT 1
           FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS AS tc
           JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE AS kcu
             ON kcu.CONSTRAINT_CATALOG = tc.CONSTRAINT_CATALOG
            AND kcu.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA
            AND kcu.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
            AND kcu.TABLE_SCHEMA = tc.TABLE_SCHEMA
            AND kcu.TABLE_NAME = tc.TABLE_NAME
           WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
             AND tc.TABLE_SCHEMA = c.TABLE_SCHEMA
             AND tc.TABLE_NAME = c.TABLE_NAME
             AND kcu.COLUMN_NAME = c.COLUMN_NAME
         ) THEN 1 ELSE 0 END AS bit) AS primary_key,
         c.ORDINAL_POSITION AS ordinal_position
       FROM INFORMATION_SCHEMA.COLUMNS AS c
       WHERE c.TABLE_SCHEMA = @schema AND c.TABLE_NAME = @table
       ORDER BY c.ORDINAL_POSITION`);
        return result.recordset.map((row) => ({
            name: row.name,
            dataType: row.data_type,
            ...(row.maximum_length === null ? {} : { maximumLength: Number(row.maximum_length) }),
            nullable: row.nullable,
            defaultValue: row.default_value,
            primaryKey: row.primary_key,
            ordinalPosition: Number(row.ordinal_position),
        }));
    }
    async getTableForeignKeys(table, schema = "dbo") {
        const request = (await this.connect()).request();
        request.input("schema", schema);
        request.input("table", table);
        const result = await request.query("SELECT fk.CONSTRAINT_NAME AS name, fk.COLUMN_NAME AS column_name, " +
            "pk.TABLE_SCHEMA AS referenced_schema, pk.TABLE_NAME AS referenced_table, pk.COLUMN_NAME AS referenced_column " +
            "FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS AS rc " +
            "JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE AS fk " +
            "ON fk.CONSTRAINT_SCHEMA = rc.CONSTRAINT_SCHEMA AND fk.CONSTRAINT_NAME = rc.CONSTRAINT_NAME " +
            "JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE AS pk " +
            "ON pk.CONSTRAINT_SCHEMA = rc.UNIQUE_CONSTRAINT_SCHEMA " +
            "AND pk.CONSTRAINT_NAME = rc.UNIQUE_CONSTRAINT_NAME AND pk.ORDINAL_POSITION = fk.ORDINAL_POSITION " +
            "WHERE fk.TABLE_SCHEMA = @schema AND fk.TABLE_NAME = @table " +
            "ORDER BY fk.CONSTRAINT_NAME, fk.ORDINAL_POSITION");
        return groupForeignKeyRows(result.recordset);
    }
    async readTable(table, schema = "dbo") {
        return this.query(`SELECT * FROM ${quoteIdentifier(schema)}.${quoteIdentifier(table)}`);
    }
    async readTablePage(table, columns, primaryKeys, cursor, limit, schema = "dbo", options = {}) {
        if (options.streamLobs && Object.keys(options.streamLobColumns ?? {}).length > 0) {
            return this.readTablePageWithStreamedLobs(table, columns, primaryKeys, cursor, limit, schema, options);
        }
        const query = buildTableTransferPageQuery("sqlserver", schema, table, columns, primaryKeys, cursor, limit, options);
        return this.query(query.sql, query.parameters);
    }
    async readTablePageWithStreamedLobs(table, columns, primaryKeys, cursor, limit, schema, options) {
        const streamColumns = Object.entries(options.streamLobColumns ?? {});
        const streamNames = new Set(streamColumns.map(([column]) => column));
        if (streamNames.size !== streamColumns.length
            || streamColumns.some(([column]) => !columns.includes(column) || primaryKeys.includes(column))) {
            throw new Error("SQL Server streamed LOB columns must be unique selected columns outside the primary key.");
        }
        const columnMetadata = await this.getTableColumns(table, schema);
        const metadataByName = new Map(columnMetadata.map((column) => [column.name, column]));
        for (const [column, encoding] of streamColumns) {
            const metadata = metadataByName.get(column);
            const dataType = metadata?.dataType.trim().toUpperCase();
            const textType = /^(?:CHAR|NCHAR|VARCHAR|NVARCHAR|TEXT|NTEXT)$/.test(dataType ?? "");
            const binaryType = /^(?:BINARY|VARBINARY|IMAGE)$/.test(dataType ?? "");
            if (!metadata || (encoding === "utf8" ? !textType : !binaryType)) {
                throw new Error(`SQL Server column '${column}' is not compatible with streamed ${encoding} LOB reads.`);
            }
        }
        const baseColumns = columns.filter((column) => !streamNames.has(column));
        const page = buildTableTransferPageQuery("sqlserver", schema, table, baseColumns, primaryKeys, cursor, limit, {
            exactNumericColumns: (options.exactNumericColumns ?? []).filter((column) => baseColumns.includes(column)),
            jsonTextColumns: (options.jsonTextColumns ?? []).filter((column) => baseColumns.includes(column)),
            spatialWkbColumns: (options.spatialWkbColumns ?? []).filter((column) => baseColumns.includes(column)),
        });
        const source = `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
        const flags = streamColumns.map((_, index) => `__dbstudio_lob_present_${index}`);
        const usedNames = new Set(columns.map((column) => column.toLocaleLowerCase("en-US")));
        for (let index = 0; index < flags.length; index += 1) {
            const original = flags[index];
            let candidate = original;
            let suffix = 0;
            while (usedNames.has(candidate.toLocaleLowerCase("en-US")))
                candidate = `${original}_${++suffix}`;
            flags[index] = candidate;
            usedNames.add(candidate.toLocaleLowerCase("en-US"));
        }
        const joins = primaryKeys.map((key) => `page.${quoteIdentifier(key)} = source.${quoteIdentifier(key)}`).join(" AND ");
        const flagSelect = streamColumns.map(([column], index) => `CASE WHEN source.${quoteIdentifier(column)} IS NULL THEN CAST(0 AS bit) ELSE CAST(1 AS bit) END AS ${quoteIdentifier(flags[index])}`).join(", ");
        const orderBy = primaryKeys.map((key) => `page.${quoteIdentifier(key)}`).join(", ");
        const request = (await this.connect()).request();
        bindParameters(request, page.parameters);
        const result = await request.query(`SELECT page.*, ${flagSelect} FROM (${page.sql}) AS page ` +
            `JOIN ${source} AS source ON ${joins} ORDER BY ${orderBy}`);
        const rows = result.recordset;
        return {
            columns,
            rows: rows.map((row) => {
                const output = { ...row };
                streamColumns.forEach(([column, encoding], index) => {
                    const present = output[flags[index]];
                    delete output[flags[index]];
                    output[column] = present === true
                        ? this.createSqlServerLobCell(table, schema, column, primaryKeys, primaryKeys.map((key) => output[key]), encoding)
                        : null;
                });
                return output;
            }),
            rowCount: rows.length,
            command: "SELECT",
        };
    }
    createSqlServerLobCell(table, schema, column, primaryKeys, keyValues, encoding) {
        const controller = new AbortController();
        const target = `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
        const columnIdentifier = quoteIdentifier(column);
        const keyPredicates = primaryKeys.map((key, index) => `${quoteIdentifier(key)} = @key${index}`).join(" AND ");
        const cell = {
            __dbStudioQueryStreamCell: true,
            encoding,
            stream: (async function* (adapter) {
                const transaction = new sql.Transaction(await adapter.connect());
                let transactionStarted = false;
                try {
                    await transaction.begin(sql.ISOLATION_LEVEL.REPEATABLE_READ);
                    transactionStarted = true;
                    let offset = 1;
                    let pendingHighSurrogate = "";
                    const chunkLength = encoding === "buffer" ? 256 * 1024 : 64 * 1024;
                    while (!controller.signal.aborted) {
                        const request = new sql.Request(transaction);
                        request.input("offset", sql.Int, offset);
                        request.input("chunkLength", sql.Int, chunkLength);
                        keyValues.forEach((value, index) => bindSqlServerParameter(request, `key${index}`, value));
                        const expression = encoding === "buffer"
                            ? `SUBSTRING(CONVERT(varbinary(max), ${columnIdentifier}), @offset, @chunkLength)`
                            : `SUBSTRING(CONVERT(nvarchar(max), ${columnIdentifier}) COLLATE Latin1_General_100_BIN2, @offset, @chunkLength)`;
                        const onAbort = () => request.cancel();
                        controller.signal.addEventListener("abort", onAbort, { once: true });
                        let result;
                        try {
                            if (controller.signal.aborted)
                                throw new Error("SQL Server LOB stream was cancelled.");
                            result = await request.query(`SELECT ${expression} AS [value] FROM ${target} WHERE ${keyPredicates}`);
                        }
                        finally {
                            controller.signal.removeEventListener("abort", onAbort);
                        }
                        const row = result.recordset[0];
                        if (!row)
                            throw new Error(`SQL Server source row for LOB column '${column}' disappeared during transfer.`);
                        const value = row.value;
                        if (value === null || value === undefined) {
                            throw new Error(`SQL Server source LOB column '${column}' became NULL during transfer.`);
                        }
                        if (encoding === "buffer") {
                            if (!(value instanceof Uint8Array))
                                throw new Error(`SQL Server binary LOB column '${column}' returned non-binary data.`);
                            const chunk = Buffer.from(value);
                            if (chunk.byteLength === 0)
                                break;
                            offset += chunk.byteLength;
                            yield chunk;
                            continue;
                        }
                        if (typeof value !== "string")
                            throw new Error(`SQL Server text LOB column '${column}' returned non-text data.`);
                        if (value.length === 0)
                            break;
                        offset += value.length;
                        let text = pendingHighSurrogate + value;
                        pendingHighSurrogate = "";
                        if (text.length > 0) {
                            const lastCodeUnit = text.charCodeAt(text.length - 1);
                            if (lastCodeUnit >= 0xD800 && lastCodeUnit <= 0xDBFF) {
                                pendingHighSurrogate = text.at(-1);
                                text = text.slice(0, -1);
                            }
                        }
                        if (!isWellFormedUtf16(text)) {
                            throw new Error(`SQL Server text LOB column '${column}' contains an unpaired UTF-16 surrogate.`);
                        }
                        if (text.length > 0)
                            yield text;
                    }
                    if (pendingHighSurrogate) {
                        throw new Error(`SQL Server text LOB column '${column}' ends with an unpaired UTF-16 surrogate.`);
                    }
                    if (controller.signal.aborted)
                        throw new Error(`SQL Server LOB stream '${column}' was cancelled.`);
                    await transaction.commit();
                    transactionStarted = false;
                }
                catch (error) {
                    if (transactionStarted)
                        await transaction.rollback().catch(() => undefined);
                    transactionStarted = false;
                    if (controller.signal.aborted)
                        throw new Error(`SQL Server LOB stream '${column}' was cancelled.`, { cause: error });
                    throw error;
                }
                finally {
                    if (transactionStarted)
                        await transaction.rollback().catch(() => undefined);
                }
            })(this),
            destroy() {
                controller.abort();
            },
        };
        return cell;
    }
    async createTable(table, columns, schema = "dbo") {
        await this.query(buildCreateTableStatement("sqlserver", table, columns, schema));
    }
    async insertRows(table, columns, rows, schema = "dbo") {
        if (columns.length === 0)
            throw new Error("At least one destination column is required.");
        if (columns.length > 2_000)
            throw new Error("SQL Server table imports support at most 2000 columns per batch.");
        if (rows.some((row) => row.length !== columns.length))
            throw new Error("Every imported row must match the destination column count.");
        if (rows.length === 0)
            return 0;
        const pool = await this.connect();
        const transaction = new sql.Transaction(pool);
        const target = `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
        const columnList = columns.map(quoteIdentifier).join(", ");
        const maxParametersPerRow = rows.reduce((maximum, row) => Math.max(maximum, row.reduce((count, value) => count + (isSpatialTransferValue(value) ? 2 : 1), 0)), columns.length);
        if (maxParametersPerRow > 2_000)
            throw new Error("A SQL Server transfer row exceeds the 2000-parameter safety limit.");
        const batchSize = Math.max(1, Math.min(500, Math.floor(2_000 / maxParametersPerRow)));
        await transaction.begin(sql.ISOLATION_LEVEL.READ_COMMITTED);
        try {
            for (let offset = 0; offset < rows.length; offset += batchSize) {
                const batch = rows.slice(offset, offset + batchSize);
                let parameterIndex = 0;
                const parameters = [];
                const tuples = batch.map((row) => `(${row.map((value) => {
                    if (isSpatialTransferValue(value)) {
                        const wkbParameter = `@p${++parameterIndex}`;
                        parameters.push(Buffer.from(value.wkb));
                        const sridParameter = `@p${++parameterIndex}`;
                        parameters.push(value.srid);
                        return `${value.spatialType}::STGeomFromWKB(${wkbParameter}, ${sridParameter})`;
                    }
                    parameters.push(value);
                    return `@p${++parameterIndex}`;
                }).join(", ")})`);
                const request = new sql.Request(transaction);
                bindParameters(request, parameters);
                await request.query(`INSERT INTO ${target} (${columnList}) VALUES ${tuples.join(", ")}`);
            }
            await transaction.commit();
            return rows.length;
        }
        catch (error) {
            await transaction.rollback().catch(() => undefined);
            throw error;
        }
    }
    async insertRowWithStreamedLobs(table, columns, row, schema = "dbo") {
        if (columns.length === 0 || row.length !== columns.length) {
            throw new Error("A streamed transfer row must match its destination columns.");
        }
        if (columns.length > 2_000)
            throw new Error("SQL Server streamed transfers support at most 2000 columns per row.");
        const streamed = row.flatMap((value, index) => isQueryStreamCell(value)
            ? [{ index, column: columns[index], cell: value }]
            : []);
        if (streamed.length === 0)
            throw new Error("A streamed transfer row must contain at least one LOB stream.");
        let transactionStarted = false;
        let transaction;
        try {
            const pool = await this.connect();
            const [targetColumns, targetLobColumns] = await Promise.all([
                this.getTableColumns(table, schema),
                pool.request()
                    .input("schema", schema)
                    .input("table", table)
                    .query(`SELECT c.name, t.name AS type_name, c.max_length
             FROM sys.columns AS c
             JOIN sys.tables AS tb ON tb.object_id = c.object_id
             JOIN sys.schemas AS s ON s.schema_id = tb.schema_id
             JOIN sys.types AS t ON t.user_type_id = c.user_type_id
             WHERE s.name = @schema AND tb.name = @table`),
            ]);
            const targetColumnsByName = new Map(targetColumns.map((column) => [column.name, column]));
            const targetLobColumnsByName = new Map(targetLobColumns.recordset.map((column) => [column.name, column]));
            for (const item of streamed) {
                const targetColumn = targetColumnsByName.get(item.column);
                const targetLobColumn = targetLobColumnsByName.get(item.column);
                if (!targetColumn || !targetLobColumn)
                    throw new Error(`Destination column '${item.column}' was not found.`);
                const typeName = targetLobColumn.type_name.toLowerCase();
                const compatible = item.cell.encoding === "buffer"
                    ? typeName === "varbinary" && targetLobColumn.max_length === -1
                    : typeName === "nvarchar" && targetLobColumn.max_length === -1;
                if (!compatible) {
                    const expected = item.cell.encoding === "buffer" ? "VARBINARY(MAX)" : "NVARCHAR(MAX)";
                    throw new Error(`Cannot stream ${item.cell.encoding === "utf8" ? "text" : "binary"} LOB data into SQL Server '${item.column}'; expected ${expected}.`);
                }
            }
            const primaryKeys = targetColumns.filter((column) => column.primaryKey);
            if (primaryKeys.length === 0) {
                throw new Error("SQL Server streamed LOB transfer requires a destination primary key to locate the inserted row.");
            }
            const keyAliases = primaryKeys.map((_, index) => `__dbstudio_key_${index}`);
            const target = `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
            const columnList = columns.map(quoteIdentifier).join(", ");
            let parameterIndex = 0;
            const parameters = [];
            const addParameter = (value, largeValueType) => {
                parameters.push({ value, largeValueType });
                return `@p${++parameterIndex}`;
            };
            const values = row.map((value, columnIndex) => {
                if (isQueryStreamCell(value)) {
                    return value.encoding === "utf8" ? "CAST(N'' AS nvarchar(max))" : "CAST(0x AS varbinary(max))";
                }
                if (isSpatialTransferValue(value)) {
                    const wkbParameter = addParameter(Buffer.from(value.wkb));
                    const sridParameter = addParameter(value.srid);
                    return `${value.spatialType}::STGeomFromWKB(${wkbParameter}, ${sridParameter})`;
                }
                const targetLobColumn = targetLobColumnsByName.get(columns[columnIndex]);
                const largeValueType = value === null || value === undefined
                    ? targetLobColumn?.type_name === "nvarchar" && targetLobColumn.max_length === -1
                        ? "text"
                        : targetLobColumn?.type_name === "varbinary" && targetLobColumn.max_length === -1 ? "binary" : undefined
                    : undefined;
                return addParameter(value, largeValueType);
            });
            const output = primaryKeys.map((column, index) => `INSERTED.${quoteIdentifier(column.name)} AS ${quoteIdentifier(keyAliases[index])}`).join(", ");
            const activeTransaction = new sql.Transaction(pool);
            transaction = activeTransaction;
            await activeTransaction.begin(sql.ISOLATION_LEVEL.READ_COMMITTED);
            transactionStarted = true;
            const insertRequest = new sql.Request(activeTransaction);
            parameters.forEach(({ value, largeValueType }, index) => {
                const name = `p${index + 1}`;
                if (largeValueType === "text")
                    insertRequest.input(name, sql.NVarChar(sql.MAX), value);
                else if (largeValueType === "binary")
                    insertRequest.input(name, sql.VarBinary(sql.MAX), value);
                else
                    bindSqlServerParameter(insertRequest, name, value);
            });
            const inserted = await insertRequest.query(`INSERT INTO ${target} (${columnList}) OUTPUT ${output} VALUES (${values.join(", ")})`);
            if (inserted.recordset.length !== 1) {
                throw new Error(`SQL Server inserted ${inserted.recordset.length} streamed transfer rows; expected exactly one.`);
            }
            const insertedRow = inserted.recordset[0];
            const keyValues = keyAliases.map((alias) => insertedRow[alias]);
            if (keyValues.some((value) => value === null || value === undefined)) {
                throw new Error("SQL Server did not return a complete primary key for the inserted streamed transfer row.");
            }
            for (const item of streamed) {
                const pendingText = [];
                const pendingBuffers = [];
                let pendingBytes = 0;
                let chunksRead = 0;
                let bytesRead = 0;
                const keyPredicates = primaryKeys.map((column, index) => `${quoteIdentifier(column.name)} = @key${index}`).join(" AND ");
                const flush = async () => {
                    if (pendingBytes === 0)
                        return;
                    const chunk = item.cell.encoding === "utf8" ? pendingText.join("") : Buffer.concat(pendingBuffers);
                    const updateRequest = new sql.Request(activeTransaction);
                    keyValues.forEach((value, index) => bindSqlServerParameter(updateRequest, `key${index}`, value));
                    if (item.cell.encoding === "utf8")
                        updateRequest.input("chunk", sql.NVarChar(sql.MAX), chunk);
                    else
                        updateRequest.input("chunk", sql.VarBinary(sql.MAX), chunk);
                    const result = await updateRequest.query(`UPDATE ${target} SET ${quoteIdentifier(item.column)}.WRITE(@chunk, NULL, 0) WHERE ${keyPredicates}`);
                    const affected = result.rowsAffected.reduce((total, count) => total + count, 0);
                    if (affected !== 1) {
                        throw new Error(`SQL Server affected ${affected} rows while appending streamed LOB column '${item.column}'.`);
                    }
                    pendingText.length = 0;
                    pendingBuffers.length = 0;
                    pendingBytes = 0;
                };
                try {
                    for await (const chunk of item.cell.stream) {
                        chunksRead += 1;
                        if (item.cell.encoding === "utf8") {
                            if (typeof chunk !== "string")
                                throw new Error(`Text LOB stream '${item.column}' emitted non-text data.`);
                            pendingText.push(chunk);
                            const chunkBytes = Buffer.byteLength(chunk, "utf16le");
                            pendingBytes += chunkBytes;
                            bytesRead += chunkBytes;
                        }
                        else {
                            if (!(chunk instanceof Uint8Array))
                                throw new Error(`Binary LOB stream '${item.column}' emitted non-binary data.`);
                            const buffer = Buffer.from(chunk);
                            pendingBuffers.push(buffer);
                            pendingBytes += buffer.byteLength;
                            bytesRead += buffer.byteLength;
                        }
                        if (pendingBytes >= 256 * 1024)
                            await flush();
                    }
                }
                catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    throw new Error(`Reading streamed ${item.cell.encoding === "utf8" ? "text" : "binary"} LOB column '${item.column}' failed after ${chunksRead} chunks (${bytesRead} bytes): ${message}`, { cause: error });
                }
                await flush();
            }
            await activeTransaction.commit();
            transactionStarted = false;
            return 1;
        }
        catch (error) {
            if (transactionStarted && transaction)
                await transaction.rollback().catch(() => undefined);
            throw error;
        }
        finally {
            for (const item of streamed)
                item.cell.destroy();
        }
    }
    async close() {
        if (!this.connection)
            return;
        const pool = await this.connection;
        await pool.close();
        this.connection = undefined;
    }
    connect() {
        this.connection ??= this.pool.connect().catch((error) => {
            this.connection = undefined;
            throw error;
        });
        return this.connection;
    }
}
function queryResult(result, statement) {
    const rows = (result.recordset ?? []);
    const metadata = result.recordset?.columns ?? {};
    const columns = Object.values(metadata).sort((left, right) => left.index - right.index).map((column) => column.name);
    return {
        columns,
        rows,
        rowCount: rows.length > 0 ? rows.length : result.rowsAffected.reduce((total, count) => total + count, 0),
        command: statement.trim().match(/^[a-z]+/i)?.[0].toUpperCase(),
    };
}
function bindParameters(request, parameters) {
    parameters.forEach((value, index) => {
        bindSqlServerParameter(request, `p${index + 1}`, value);
    });
}
function bindSqlServerParameter(request, name, value) {
    if (value instanceof Uint8Array) {
        request.input(name, sql.VarBinary(sql.MAX), Buffer.from(value));
        return;
    }
    request.input(name, value);
}
function quoteIdentifier(identifier) {
    if (!identifier.trim())
        throw new Error("SQL Server identifier cannot be empty.");
    return `[${identifier.replaceAll("]", "]]")}]`;
}
function isWellFormedUtf16(value) {
    for (let index = 0; index < value.length; index += 1) {
        const codeUnit = value.charCodeAt(index);
        if (codeUnit >= 0xD800 && codeUnit <= 0xDBFF) {
            const next = value.charCodeAt(index + 1);
            if (!(next >= 0xDC00 && next <= 0xDFFF))
                return false;
            index += 1;
        }
        else if (codeUnit >= 0xDC00 && codeUnit <= 0xDFFF) {
            return false;
        }
    }
    return true;
}
function positiveInteger(value, fallback, name) {
    const parsed = value === undefined || value.trim() === "" ? fallback : Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1)
        throw new Error(`${name} must be a positive integer.`);
    return parsed;
}
function parseBoolean(value, fallback, name) {
    if (value === undefined || value.trim() === "")
        return fallback;
    if (/^(1|true|yes)$/i.test(value.trim()))
        return true;
    if (/^(0|false|no)$/i.test(value.trim()))
        return false;
    throw new Error(`${name} must be true or false.`);
}
//# sourceMappingURL=sqlserver.js.map