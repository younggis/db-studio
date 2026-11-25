import { quoteIdentifier } from "@db-studio/database";
function columnSql(engine, column) {
    const q = (name) => quoteIdentifier(engine, name);
    const type = column.dataType?.trim() || "TEXT";
    const nullable = column.nullable ? "NULL" : "NOT NULL";
    const def = column.defaultValue != null && column.defaultValue !== ""
        ? ` DEFAULT ${column.defaultValue}`
        : "";
    return `${q(column.name)} ${type} ${nullable}${def}`;
}
function createTableSql(engine, schema, table) {
    const q = (name) => quoteIdentifier(engine, name);
    const lines = table.columns.map((column) => "  " + columnSql(engine, column));
    const pk = table.columns.filter((column) => column.primaryKey).map((column) => q(column.name));
    if (pk.length)
        lines.push(`  PRIMARY KEY (${pk.join(", ")})`);
    const target = schema ? `${q(schema)}.${q(table.name)}` : q(table.name);
    const statements = [`CREATE TABLE ${target} (\n${lines.join(",\n")}\n);`];
    for (const index of table.indexes) {
        const columns = index.columns.map(q).join(", ");
        const unique = index.unique ? "UNIQUE " : "";
        statements.push(`CREATE ${unique}INDEX ${q(index.name)} ON ${target} (${columns});`);
    }
    return statements;
}
function alterColumnSql(engine, schema, table, column) {
    const q = (name) => quoteIdentifier(engine, name);
    const target = schema ? `${q(schema)}.${q(table)}` : q(table);
    const type = column.dataType?.trim() || "TEXT";
    const nullable = column.nullable ? "NULL" : "NOT NULL";
    const def = column.defaultValue != null && column.defaultValue !== ""
        ? ` DEFAULT ${column.defaultValue}`
        : "";
    if (engine === "postgres") {
        return `ALTER TABLE ${target} ALTER COLUMN ${q(column.name)} TYPE ${type};`;
    }
    if (engine === "mysql" || engine === "mariadb") {
        return `ALTER TABLE ${target} MODIFY COLUMN ${columnSql(engine, column)};`;
    }
    if (engine === "sqlserver") {
        return `ALTER TABLE ${target} ALTER COLUMN ${q(column.name)} ${type} ${nullable};`;
    }
    if (engine === "oracle") {
        return `ALTER TABLE ${target} MODIFY ${q(column.name)} ${type} ${nullable};`;
    }
    // SQLite cannot alter a column in place; a table rebuild is required.
    return null;
}
function fkSql(engine, schema, table, fk) {
    const q = (name) => quoteIdentifier(engine, name);
    const target = schema ? `${q(schema)}.${q(table)}` : q(table);
    const columns = fk.columns.map(q).join(", ");
    const referenced = fk.referencedColumns.map(q).join(", ");
    const ref = fk.referencedSchema
        ? `${q(fk.referencedSchema)}.${q(fk.referencedTable)}`
        : q(fk.referencedTable);
    return `ALTER TABLE ${target} ADD CONSTRAINT ${q(fk.name)} FOREIGN KEY (${columns}) REFERENCES ${ref} (${referenced});`;
}
function dropConstraintSql(engine, schema, table, name) {
    const q = (value) => quoteIdentifier(engine, value);
    const target = schema ? `${q(schema)}.${q(table)}` : q(table);
    if (engine === "mysql" || engine === "mariadb")
        return `ALTER TABLE ${target} DROP FOREIGN KEY ${q(name)};`;
    return `ALTER TABLE ${target} DROP CONSTRAINT ${q(name)};`;
}
function dropIndexSql(engine, schema, table, name) {
    const q = (value) => quoteIdentifier(engine, value);
    if (engine === "mysql" || engine === "mariadb")
        return `DROP INDEX ${q(name)} ON ${q(table)};`;
    if (engine === "sqlserver" && schema)
        return `DROP INDEX ${q(name)} ON ${q(schema)}.${q(table)};`;
    return `DROP INDEX ${q(name)};`;
}
export function diffSchemaSnapshots(source, target, options = {}) {
    const includeDrops = options.includeDrops === true;
    const statements = [];
    const push = (kind, table, reason, sql, risk = "low") => {
        statements.push({
            id: `${kind}:${table}:${statements.length + 1}`,
            kind, table, reason, sql, risk, selected: true,
        });
    };
    const sourceTables = new Map(source.tables.map((table) => [table.name, table]));
    const targetTables = new Map(target.tables.map((table) => [table.name, table]));
    const q = (name) => quoteIdentifier(target.engine, name);
    for (const table of source.tables) {
        const existing = targetTables.get(table.name);
        if (!existing) {
            const sqls = createTableSql(target.engine, target.schema, table);
            push("create-table", table.name, `目标库缺少表 ${table.name}`, sqls[0], "low");
            for (const index of table.indexes) {
                const columns = index.columns.map(q).join(", ");
                const qualifiedName = target.schema ? `${q(target.schema)}.${q(table.name)}` : q(table.name);
                push("create-index", table.name, `新建索引 ${index.name}`, `CREATE ${index.unique ? "UNIQUE " : ""}INDEX ${q(index.name)} ON ${qualifiedName} (${columns});`, "low");
            }
            continue;
        }
        const sourceColumns = new Map(table.columns.map((column) => [column.name, column]));
        const targetColumns = new Map(existing.columns.map((column) => [column.name, column]));
        const tableTarget = target.schema ? `${q(target.schema)}.${q(table.name)}` : q(table.name);
        for (const column of table.columns) {
            const current = targetColumns.get(column.name);
            if (!current) {
                push("add-column", table.name, `缺少字段 ${column.name}`, `ALTER TABLE ${tableTarget} ADD COLUMN ${columnSql(target.engine, column)};`, "medium");
                continue;
            }
            const changed = current.dataType !== column.dataType
                || current.nullable !== column.nullable
                || (current.defaultValue ?? "") !== (column.defaultValue ?? "");
            if (changed) {
                const sql = alterColumnSql(target.engine, target.schema, table.name, column);
                if (sql)
                    push("alter-column", table.name, `字段 ${column.name} 定义不同`, sql, "medium");
            }
        }
        if (includeDrops) {
            for (const column of existing.columns) {
                if (!sourceColumns.has(column.name)) {
                    push("drop-column", table.name, `目标库多出字段 ${column.name}`, `ALTER TABLE ${tableTarget} DROP COLUMN ${q(column.name)};`, "high");
                }
            }
        }
        const sourceFks = new Map(table.foreignKeys.map((fk) => [fk.name, fk]));
        const targetFks = new Map(existing.foreignKeys.map((fk) => [fk.name, fk]));
        for (const fk of table.foreignKeys) {
            if (!targetFks.has(fk.name)) {
                push("add-foreign-key", table.name, `缺少外键 ${fk.name}`, fkSql(target.engine, target.schema, table.name, fk), "medium");
            }
        }
        if (includeDrops) {
            for (const fk of existing.foreignKeys) {
                if (!sourceFks.has(fk.name)) {
                    push("drop-foreign-key", table.name, `目标库多出外键 ${fk.name}`, dropConstraintSql(target.engine, target.schema, table.name, fk.name), "high");
                }
            }
        }
        const sourceIndexes = new Map(table.indexes.map((index) => [index.name, index]));
        const targetIndexes = new Map(existing.indexes.map((index) => [index.name, index]));
        for (const index of table.indexes) {
            if (!targetIndexes.has(index.name)) {
                const columns = index.columns.map(q).join(", ");
                push("create-index", table.name, `缺少索引 ${index.name}`, `CREATE ${index.unique ? "UNIQUE " : ""}INDEX ${q(index.name)} ON ${tableTarget} (${columns});`, "low");
            }
        }
        if (includeDrops) {
            for (const index of existing.indexes) {
                if (!sourceIndexes.has(index.name)) {
                    push("drop-index", table.name, `目标库多出索引 ${index.name}`, dropIndexSql(target.engine, target.schema, table.name, index.name), "high");
                }
            }
        }
    }
    if (includeDrops) {
        for (const table of target.tables) {
            if (!sourceTables.has(table.name)) {
                const qualifiedName = target.schema ? `${q(target.schema)}.${q(table.name)}` : q(table.name);
                push("drop-table", table.name, `目标库多出表 ${table.name}`, `DROP TABLE IF EXISTS ${qualifiedName};`, "high");
            }
        }
    }
    return statements;
}
//# sourceMappingURL=schema-diff.js.map