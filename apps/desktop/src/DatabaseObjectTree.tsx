import { useCallback, useState } from "react";
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

// Node keys follow `${connectionId}:${schema}.${table}`; the Fields child key
// appends `:fields`. We parse that to lazily load real column metadata.
interface TableRef { connectionId: string; schema: string; table: string }

function parseTableRef(key: string): TableRef | undefined {
  const colon = key.indexOf(":");
  if (colon < 0) return undefined;
  const connectionId = key.slice(0, colon);
  const qualified = key.slice(colon + 1).replace(/:fields$/, "");
  const dot = qualified.indexOf(".");
  if (dot < 0) return undefined;
  return { connectionId, schema: qualified.slice(0, dot), table: qualified.slice(dot + 1) };
}

// Navicat-style grouping: Tables group with each table exposing a real Fields
// node (lazy-loaded). Subgroups without an IPC API (Indexes/Foreign Keys/etc.)
// are intentionally omitted rather than shown as dead placeholders.
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
  const [fieldCache, setFieldCache] = useState<Record<string, string[]>>({});
  const treeData = navicatTransform(data);

  const loadData = useCallback(async (node: DataNode) => {
    const key = String(node.key ?? "");
    if (!key.endsWith(":fields")) return;
    if (fieldCache[key]) return;
    const ref = parseTableRef(key);
    if (!ref) return;
    try {
      const columns = await window.dbStudio.database.columns(ref.connectionId, ref.table, ref.schema);
      setFieldCache((current) => ({
        ...current,
        [key]: columns.map((column) => `${column.name} · ${column.dataType}${column.primaryKey ? " (PK)" : ""}${column.nullable ? "" : " NOT NULL"}`),
      }));
    } catch {
      setFieldCache((current) => ({ ...current, [key]: ["读取字段失败"] }));
    }
  }, [fieldCache]);

  const withFields = (nodes: DataNode[]): DataNode[] => nodes.map((node) => {
    const key = String(node.key ?? "");
    if (key.endsWith(":fields") && fieldCache[key]) {
      return {
        ...node,
        isLeaf: true,
        selectable: false,
        children: fieldCache[key].map((label, index) => ({
          key: `${key}:${index}`,
          title: label,
          isLeaf: true,
          selectable: false,
        })),
      };
    }
    return node.children ? { ...node, children: withFields(node.children) } : node;
  });

  return (
    <div className="object-tree">
      <div className="tree-label">
        <span>对象浏览器</span>
        <Space size={0}>
          <Tooltip title="搜索数据库对象">
            <Button type="text" size="small" icon={<Search size={13} />} aria-label="搜索数据库对象" onClick={onSearch} />
          </Tooltip>
          <Tooltip title="刷新对象列表">
            <Button type="text" size="small" icon={<RefreshCw size={13} />} onClick={onRefresh} />
          </Tooltip>
        </Space>
      </div>
      {loading ? <Spin size="small" /> : <Tree
        showIcon
        blockNode
        defaultExpandAll
        selectedKeys={[]}
        treeData={withFields(treeData)}
        loadData={loadData}
        onSelect={(keys) => onSelect(keys)}
        titleRender={(node) => {
          const items = getContextMenuItems?.(node);
          const title = typeof node.title === "function" ? node.title(node) : node.title;
          return items?.length ? (
            <Dropdown menu={{ items }} trigger={["contextMenu"]} destroyPopupOnHide>
              <span className="tree-node-title" onContextMenu={(event) => event.preventDefault()}>{title}</span>
            </Dropdown>
          ) : (
            <span className="tree-node-title">{title}</span>
          );
        }}
      />}
      {error && <Text type="danger" className="tree-error">{error}</Text>}
    </div>
  );
}
