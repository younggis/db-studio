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

// Navicat-style visual grouping, previously injected into the compiled chunk.
// Implemented here in real source so `pnpm build` no longer needs a dist patch.
const SUBGROUPS = ["Fields", "Indexes", "Foreign Keys", "Uniques", "Checks", "Rules", "Triggers"];

function navicatTransform(nodes: DataNode[]): DataNode[] {
  return nodes.map((node) => {
    if (!node.children?.length) return node;
    return {
      ...node,
      children: node.children.map((schema) => {
        if (!schema.children?.length) return schema;
        const tables = schema.children.map((table) => ({
          ...table,
          children: SUBGROUPS.map((group) => ({
            key: `${String(table.key)}:${group}`,
            title: group,
            icon: <span className="tree-sub-icon" />,
            isLeaf: true,
            selectable: false,
            disabled: true,
          })),
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
        treeData={navicatTransform(data)}
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
