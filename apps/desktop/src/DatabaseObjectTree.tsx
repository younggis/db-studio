import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Key } from "react";
import { Button, Dropdown, Space, Spin, Tooltip, Tree, Typography } from "antd";
import type { MenuProps } from "antd";
import type { DataNode } from "antd/es/tree";
import { RefreshCw, Search } from "lucide-react";

const { Text } = Typography;

interface DatabaseObjectTreeProps {
  data: DataNode[];
  loading: boolean;
  error?: string;
  onSearch: () => void;
  onRefresh: () => void;
  onSelect: (keys: Key[]) => void;
  getContextMenuItems?: (node: DataNode) => MenuProps["items"];
}

interface TableRef { connectionId: string; schema: string; table: string }
interface FieldInfo { name: string; dataType: string; primaryKey: boolean; nullable: boolean }

function parseTableRef(key: string): TableRef | undefined {
  const colon = key.indexOf(":");
  if (colon < 0) return undefined;
  const connectionId = key.slice(0, colon);
  const qualified = key.slice(colon + 1).replace(/:fields$/, "");
  const dot = qualified.indexOf(".");
  if (dot < 0) return undefined;
  return { connectionId, schema: qualified.slice(0, dot), table: qualified.slice(dot + 1) };
}

function isFieldsNode(key: string) { return key.endsWith(":fields"); }
function isFieldLeaf(key: string) { return key.includes(":fields:"); }

// Navicat-style grouping: Tables group with a lazy Fields child. Subgroups
// without an IPC API are intentionally omitted instead of shown as dead nodes.
function navicatTransform(nodes: DataNode[]): DataNode[] {
  return nodes.map((node) => {
    if (!node.children?.length) return node;
    return {
      ...node,
      children: node.children.map((schema) => {
        if (!schema.children?.length) return schema;
        const tables = schema.children.map((table) => ({
          ...table,
          children: [{
            key: `${String(table.key)}:fields`,
            title: "Fields",
            icon: <span className="tree-sub-icon" />,
          }],
        }));
        return {
          ...schema,
          children: [{
            key: `${String(schema.key)}:tables`,
            title: "Tables",
            icon: <span className="tree-group-icon" />,
            children: tables,
          }],
        };
      }),
    };
  });
}

export default function DatabaseObjectTree({
  data,
  loading,
  error,
  onSearch,
  onRefresh,
  onSelect,
  getContextMenuItems,
}: DatabaseObjectTreeProps) {
  const [fieldCache, setFieldCache] = useState<Record<string, FieldInfo[]>>({});
  const [expandedKeys, setExpandedKeys] = useState<Key[]>([]);
  const [filter, setFilter] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const rawTreeData = navicatTransform(data);

  // Default: expand only the connection(s), never the whole tree.
  useEffect(() => {
    if (data.length && !expandedKeys.length) {
      setExpandedKeys(data.map((node) => node.key).filter((key): key is Key => key != null));
    }
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  // Cmd/Ctrl+P focuses the tree filter.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "p") {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Filter tree by table/schema name; keep ancestors of matches.
  const treeData = useMemo(() => {
    const term = filter.trim().toLowerCase();
    if (!term) return rawTreeData;
    const filterNodes = (nodes: DataNode[]): DataNode[] => nodes.flatMap((node) => {
      const label = typeof node.title === "string" ? node.title.toLowerCase() : "";
      const children = node.children ? filterNodes(node.children) : undefined;
      if (label.includes(term) || (children && children.length)) {
        return [{ ...node, children }];
      }
      return [];
    });
    return filterNodes(rawTreeData);
  }, [rawTreeData, filter]);

  const loadData = useCallback(async (node: DataNode) => {
    const key = String(node.key ?? "");
    if (!isFieldsNode(key)) return;
    if (fieldCache[key]) return;
    const ref = parseTableRef(key);
    if (!ref) return;
    try {
      const columns = await window.dbStudio.database.columns(ref.connectionId, ref.table, ref.schema);
      setFieldCache((current) => ({
        ...current,
        [key]: columns.map((column) => ({
          name: column.name,
          dataType: column.dataType,
          primaryKey: column.primaryKey,
          nullable: column.nullable,
        })),
      }));
    } catch {
      setFieldCache((current) => ({ ...current, [key]: [] }));
    }
  }, [fieldCache]);

  const withFields = (nodes: DataNode[]): DataNode[] => nodes.map((node) => {
    const key = String(node.key ?? "");
    if (isFieldsNode(key) && fieldCache[key]) {
      return {
        ...node,
        isLeaf: fieldCache[key].length === 0,
        selectable: false,
        children: fieldCache[key].map((field, index) => ({
          key: `${key}:${index}`,
          title: field.name,
          isLeaf: true,
          selectable: false,
        })),
      };
    }
    return node.children ? { ...node, children: withFields(node.children) } : node;
  });

  // Look up field metadata for a leaf from its key (`...:fields:<index>`).
  const fieldFor = (key: string): FieldInfo | undefined => {
    const marker = key.lastIndexOf(":fields:");
    if (marker < 0) return undefined;
    const fieldsKey = key.slice(0, marker + 7);
    const index = Number(key.slice(marker + 8));
    return fieldCache[fieldsKey]?.[index];
  };

  return (
    <div className="object-tree">
      <div className="tree-label">
        <span>对象浏览器</span>
        <Space size={0}>
          <Tooltip title="搜索数据库对象（Ctrl/⌘+P）">
            <Button type="text" size="small" icon={<Search size={13} />} aria-label="搜索数据库对象" onClick={() => searchRef.current?.focus()} />
          </Tooltip>
          <Tooltip title="刷新对象列表">
            <Button type="text" size="small" icon={<RefreshCw size={13} />} onClick={onRefresh} />
          </Tooltip>
        </Space>
      </div>
      <div className="tree-filter-wrap">
        <div className="tree-filter-shell">
          <input
            ref={searchRef}
            className="tree-filter"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="过滤表 / Schema…"
            aria-label="过滤数据库对象"
          />
          <kbd className="tree-filter-kbd">⌘P</kbd>
        </div>
      </div>
      {loading ? <Spin size="small" /> : <Tree
        showIcon
        blockNode
        expandedKeys={expandedKeys}
        onExpand={(keys) => setExpandedKeys(keys)}
        selectedKeys={[]}
        treeData={withFields(treeData)}
        loadData={loadData}
        onSelect={(keys) => onSelect(keys)}
        titleRender={(node) => {
          const key = String(node.key ?? "");
          if (isFieldLeaf(key)) {
            const field = fieldFor(key);
            if (field) {
              return (
                <span className="tree-field">
                  <span className="tree-field-name">{field.name}</span>
                  <span className="tree-field-type">{field.dataType}</span>
                  {field.primaryKey && <span className="tree-field-pk">PK</span>}
                </span>
              );
            }
          }
          const items = getContextMenuItems?.(node);
          const title = typeof node.title === "function" ? node.title(node) : node.title;
          return items?.length ? (
            <Dropdown menu={{ items }} trigger={["contextMenu"]} destroyPopupOnHide>
              <span className="tree-node-title" onContextMenu={(event) => event.preventDefault()}><span className="tree-node-title-text">{title}</span></span>
            </Dropdown>
          ) : (
            <span className="tree-node-title"><span className="tree-node-title-text">{title}</span></span>
          );
        }}
      />}
      {error && <Text type="danger" className="tree-error">{error}</Text>}
    </div>
  );
}
