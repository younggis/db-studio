import { quoteIdentifier } from "@db-studio/database";
function definition(engine, column, q) {
    const type = column.dataType.trim() || "TEXT";
    const nullable = column.nullable ? "NULL" : "NOT NULL";
    const def = column.defaultValue != null && column.defaultValue.trim()
        ? ` DEFAULT ${column.defaultValue.trim()}`
        : "";
    return `${q(column.name)} ${type} ${nullable}${def}`;
}
export function buildDesignerSql(engine, schema, mode, table, existingColumns = []) {
    if (!table.name.trim())
        throw new Error("表名不能为空。");
    if (!table.columns.length)
        throw new Error("至少需要一列。");
    const q = (name) => quoteIdentifier(engine, name);
    const qualified = schema ? `${q(schema)}.${q(table.name)}` : q(table.name);
    const statements = [];
    if (mode === "create") {
        const lines = table.columns.map((column) => "  " + definition(engine, column, q));
        const primaryKey = table.columns.filter((column) => column.primaryKey).map((column) => q(column.name));
        if (primaryKey.length)
            lines.push(`  PRIMARY KEY (${primaryKey.join(", ")})`);
        for (const fk of table.foreignKeys) {
            const columns = fk.columns.map(q).join(", ");
            const referenced = fk.referencedColumns.map(q).join(", ");
            const ref = fk.referencedSchema ? `${q(fk.referencedSchema)}.${q(fk.referencedTable)}` : q(fk.referencedTable);
            lines.push(`  CONSTRAINT ${q(fk.name)} FOREIGN KEY (${columns}) REFERENCES ${ref} (${referenced})`);
        }
        statements.push(`CREATE TABLE ${qualified} (\n${lines.join(",\n")}\n);`);
    }
    else {
        const existing = new Set(existingColumns);
        for (const column of table.columns) {
            if (!existing.has(column.name)) {
                statements.push(`ALTER TABLE ${qualified} ADD COLUMN ${definition(engine, column, q)};`);
            }
        }
        for (const fk of table.foreignKeys) {
            const columns = fk.columns.map(q).join(", ");
            const referenced = fk.referencedColumns.map(q).join(", ");
            const ref = fk.referencedSchema ? `${q(fk.referencedSchema)}.${q(fk.referencedTable)}` : q(fk.referencedTable);
            statements.push(`ALTER TABLE ${qualified} ADD CONSTRAINT ${q(fk.name)} FOREIGN KEY (${columns}) REFERENCES ${ref} (${referenced});`);
        }
    }
    for (const index of table.indexes) {
        const columns = index.columns.map(q).join(", ");
        statements.push(`CREATE ${index.unique ? "UNIQUE " : ""}INDEX ${q(index.name)} ON ${qualified} (${columns});`);
    }
    return statements;
}
//# sourceMappingURL=table-designer.js.map