// Reconstructed from vendor chunk DatabaseObjectSearchModal-DhNX8EvY.js.
import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Empty, Input, Modal, Select, Spin, Tag, Typography } from "antd";
import { ArrowRight, Search } from "lucide-react";
import type { TableInfo } from "@db-studio/shared";

const { Text } = Typography;
const ALL_SCHEMAS = "__all_schemas__";

interface DatabaseObjectSearchModalProps {
  open: boolean;
  connectionId: string;
  connectionName: string;
  schemas: string[];
  currentSchema?: string;
  schemasLoading?: boolean;
  schemasError?: boolean;
  onClose: () => void;
  onOpenTable: (table: TableInfo) => void;
}

interface ScannedSchema {
  schema: string;
  tables?: TableInfo[];
}

interface ObjectSearchResult {
  tables: TableInfo[];
  failedSchemas: string[];
}

async function fetchTablesInParallel(
  schemas: string[],
  load: (schema: string) => Promise<TableInfo[]>,
  concurrency = 4,
  signal?: AbortSignal,
): Promise<ObjectSearchResult> {
  const unique = [...new Set(schemas)];
  const results: ScannedSchema[] = new Array(unique.length);
  let next = 0;
  async function worker() {
    for (;;) {
      if (signal?.aborted) return;
      const index = next++;
      if (index >= unique.length) return;
      const schema = unique[index];
      try {
        results[index] = { schema, tables: await load(schema) };
      } catch {
        results[index] = { schema };
      }
    }
  }
  const workers = Math.min(unique.length, Math.max(1, Math.floor(concurrency)));
  await Promise.all(Array.from({ length: workers }, () => worker()));
  if (signal?.aborted) throw new Error("Object search cancelled");
  return {
    tables: results.filter((item) => !!item?.tables).flatMap((item) => item.tables!),
    failedSchemas: results.filter((item) => !item?.tables).map((item) => item.schema),
  };
}

function scoreObjects(tables: TableInfo[], query: string, limit = 100) {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle || limit <= 0) return [];
  const tokens = needle.split(/\s+/);
  return tables
    .map((table) => {
      const name = table.name.toLocaleLowerCase();
      const schema = table.schema.toLocaleLowerCase();
      const comment = (table.comment ?? "").toLocaleLowerCase();
      const haystack = [name, schema, comment];
      if (!tokens.every((token) => haystack.some((value) => value.includes(token)))) return undefined;
      const score = name === needle ? 0 : name.startsWith(needle) ? 1 : name.includes(needle) ? 2 : schema.includes(needle) ? 3 : 4;
      return { table, score };
    })
    .filter((item): item is { table: TableInfo; score: number } => item !== undefined)
    .sort((a, b) => a.score - b.score
      || a.table.name.length - b.table.name.length
      || a.table.schema.localeCompare(b.table.schema)
      || a.table.name.localeCompare(b.table.name))
    .slice(0, Math.floor(limit));
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function DatabaseObjectSearchModal({
  open,
  connectionId,
  connectionName,
  schemas,
  currentSchema,
  schemasLoading = false,
  schemasError = false,
  onClose,
  onOpenTable,
}: DatabaseObjectSearchModalProps) {
  const [search, setSearch] = useState("");
  const [scope, setScope] = useState(ALL_SCHEMAS);
  const allSchemas = useMemo(() => [...new Set([...schemas, ...(currentSchema ? [currentSchema] : [])])], [schemas, currentSchema]);
  const scopedSchemas = useMemo(() => scope === ALL_SCHEMAS ? allSchemas : allSchemas.includes(scope) ? [scope] : [], [allSchemas, scope]);
  const schemasKey = scopedSchemas.join("\0");
  const [objects, setObjects] = useState<ObjectSearchResult>();
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<unknown>();
  const requestRef = useRef<AbortController | undefined>(undefined);

  useEffect(() => { setScope(ALL_SCHEMAS); setSearch(""); }, [connectionId]);

  useEffect(() => {
    requestRef.current?.abort();
    if (!open) return;
    if (schemasLoading || schemasError || !connectionId || !scopedSchemas.length) return;
    const controller = new AbortController();
    requestRef.current = controller;
    setLoading(true);
    setLoadError(undefined);
    fetchTablesInParallel(
      scopedSchemas,
      (schema) => window.dbStudio.database.tables(connectionId, schema),
      4,
      controller.signal,
    ).then((result) => {
      if (!controller.signal.aborted) setObjects(result);
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setLoadError(error);
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [open, connectionId, schemasKey, schemasLoading, schemasError]); // eslint-disable-line react-hooks/exhaustive-deps

  const matches = useMemo(() => scoreObjects(objects?.tables ?? [], search), [objects?.tables, search]);
  const term = search.trim();
  const allFailed = !!objects?.failedSchemas.length && (objects?.tables.length ?? 0) === 0;

  return (
    <Modal
      title={<span><Search size={16} />　数据库对象搜索</span>}
      open={open}
      onCancel={onClose}
      footer={null}
      width={720}
      destroyOnHidden
    >
      <Text type="secondary">{connectionName} · 搜索表、视图名称及注释。只读取元数据，不查询业务行。</Text>
      <div className="object-search-controls">
        <Input
          autoFocus
          allowClear
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="输入表名、Schema 或注释关键词"
          prefix={<Search size={15} />}
          aria-label="搜索数据库对象"
        />
        <Select
          value={scope}
          onChange={setScope}
          aria-label="Schema 搜索范围"
          options={[{ value: ALL_SCHEMAS, label: `全部 Schema (${allSchemas.length})` }, ...allSchemas.map((item) => ({ value: item, label: item }))]}
          style={{ width: 220, flex: "none" }}
        />
      </div>
      <div className="object-search-results" aria-live="polite">
        {schemasError
          ? <Alert showIcon type="error" message="读取 Schema 列表失败" />
          : schemasLoading
            ? <div className="object-search-state"><Spin size="small" /><Text type="secondary">正在读取 Schema 列表…</Text></div>
            : loading
              ? <div className="object-search-state"><Spin size="small" /><Text type="secondary">{`正在读取 ${scopedSchemas.length} 个 Schema 的表和视图…`}</Text></div>
              : !!loadError
                ? <Alert showIcon type="error" message="读取数据库对象失败" description={describeError(loadError)} />
                : allFailed
                  ? <Alert showIcon type="error" message="无法读取对象元数据" description="请检查连接状态和 Schema 读取权限。" />
                  : <>
                      {!!objects?.failedSchemas.length && (
                        <Alert showIcon type="warning" className="object-search-warning" message={`${objects.failedSchemas.length} 个 Schema 读取失败，结果仅包含可读取的 Schema。`} />
                      )}
                      {term
                        ? matches.length === 0
                          ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有匹配的数据库对象" />
                          : <>
                              <div className="object-search-summary">{`匹配 ${matches.length} 项`}{matches.length === 100 ? "（最多显示 100 项）" : ""}</div>
                              {matches.map(({ table }) => (
                                <div className="object-search-row" key={`${table.schema}.${table.name}`}>
                                  <div className="object-search-name">
                                    <span className="object-search-qualified">{table.schema}.{table.name}</span>
                                    <Tag color={table.type === "view" ? "purple" : "blue"}>{table.type === "view" ? "视图" : "数据表"}</Tag>
                                    {table.comment && <Text type="secondary" className="object-search-comment" title={table.comment}>{table.comment}</Text>}
                                  </div>
                                  <Button type="link" size="small" icon={<ArrowRight size={14} />} iconPosition="end" onClick={() => onOpenTable(table)}>打开 SQL 草稿</Button>
                                </div>
                              ))}
                            </>
                        : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="输入关键词搜索表和视图" />}
                    </>}
      </div>
    </Modal>
  );
}
