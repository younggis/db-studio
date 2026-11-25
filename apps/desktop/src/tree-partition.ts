// Pure table/partition grouping used by the object tree. Kept free of React
// imports so it can be unit-tested without a DOM environment.

export interface FlatTable {
  key: string;
  title: string;
  parentName?: string | null;
}

export interface GroupedTable extends FlatTable {
  partitions: FlatTable[];
}

/** Group partition children under their parent table, preserving order. */
export function groupTablesByParent<T extends FlatTable>(tables: T[]): Array<T & { partitions: T[] }> {
  const byName = new Map(tables.map((table) => [table.title, table]));
  const childrenByParent = new Map<string, T[]>();
  const roots: T[] = [];
  for (const table of tables) {
    const raw = table.parentName;
    const parentName = raw?.includes(".") ? raw.slice(raw.indexOf(".") + 1) : raw;
    const parent = parentName ? byName.get(parentName) : undefined;
    if (parent && parent !== table) {
      const list = childrenByParent.get(parentName!) ?? [];
      list.push(table);
      childrenByParent.set(parentName!, list);
    } else {
      roots.push(table);
    }
  }
  return roots.map((table) => ({ ...table, partitions: childrenByParent.get(table.title) ?? [] }));
}
