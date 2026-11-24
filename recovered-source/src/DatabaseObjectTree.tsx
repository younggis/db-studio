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
        treeData={data}
        onSelect={(keys) => onSelect(keys)}
        titleRender={(node) => {
          const items = getContextMenuItems?.(node);
          return items?.length ? (
            <Dropdown menu={{ items }} trigger={["contextMenu"]} destroyPopupOnHide>
              <span className="tree-node-title" onContextMenu={(event) => event.preventDefault()}>{node.title}</span>
            </Dropdown>
          ) : (
            <span className="tree-node-title">{node.title}</span>
          );
        }}
      />}
      {error && <Text type="danger" className="tree-error">{error}</Text>}
    </div>
  );
}
