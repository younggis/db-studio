import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Key } from "react";
import { Dropdown, Space, Tooltip } from "antd";
import type { MenuProps } from "antd";
import type { DataNode } from "antd/es/tree";
import { RefreshCw, Search } from "lucide-react";
import { groupTablesByParent } from "./tree-partition";
import { WbTreeSidebar, WbToolButton } from "./workbench/Workbench";

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

// Navicat-style grouping: Tables group with a lazy Fields child. Partition
// children are folded under their parent table so a heavily partitioned table
// does not produce thousands of sibling rows.
interface PartitionedDataNode extends DataNode {
  parentName?: string | null;
}

function tableNode(table: DataNode, extraChildren: DataNode[] = []): DataNode {
  return {
    ...table,
    isLeaf: false,
    icon: undefined,
    className: "tree-chevron-only",
    children: [
      ...extraChildren,
      {
        key: `${String(table.key)}:fields`,
        title: "Fields",
        isLeaf: false,
        className: "tree-chevron-only",
      },
    ],
  };
}

export function navicatTransform(nodes: DataNode[]): DataNode[] {
  return nodes.map((node) => {
    if (!node.children?.length) return node;
    return {
      ...node,
      children: node.children.map((schema) => {
        if (!schema.children?.length) return schema;
        const tagged = (schema.children as PartitionedDataNode[]).map((node) => ({
          key: String(node.key),
          title: String(node.title),
          parentName: node.parentName,
          node,
        }));
        const tables = groupTablesByParent(tagged).map((group) => {
          const partitionNodes = group.partitions.map((child) => tableNode(child.node));
          const extra = partitionNodes.length ? [{
            key: `${group.key}:partitions`,
            title: `分区 (${partitionNodes.length})`,
            className: "tree-chevron-only",
            children: partitionNodes,
          }] : [];
          return tableNode(group.node, extra);
        });
        return {
          ...schema,
          children: [{
            key: `${String(schema.key)}:tables`,
            title: "Tables",
            className: "tree-chevron-only",
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
  const treeHostRef = useRef<HTMLDivElement>(null);
  const [treeHeight, setTreeHeight] = useState(1);
  const rawTreeData = useMemo(() => navicatTransform(data), [data]);

  // Virtual scrolling needs an explicit height. Measure the available sidebar
  // area instead of hard-coding it so splitter/layout changes stay correct.
  useEffect(() => {
    const host = treeHostRef.current;
    if (!host) return;
    const update = () => setTreeHeight(Math.max(1, host.clientHeight));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

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
    <WbTreeSidebar
      className="object-tree"
      headClassName="tree-label"
      searchClassName="tree-filter-wrap"
      hostClassName="tree-virtual-host"
      hostRef={treeHostRef}
      height={treeHeight}
      title={<span>对象浏览器</span>}
      actions={
        <Space size={0}>
          <Tooltip title="搜索数据库对象（Ctrl/⌘+P）">
            <WbToolButton ariaLabel="搜索数据库对象" icon={<Search size={13} />} onClick={() => searchRef.current?.focus()} />
          </Tooltip>
          <Tooltip title="刷新对象列表">
            <WbToolButton ariaLabel="刷新对象列表" icon={<RefreshCw size={13} />} onClick={onRefresh} />
          </Tooltip>
        </Space>
      }
      searchValue={filter}
      onSearchChange={setFilter}
      searchPlaceholder="过滤表 / Schema…"
      searchSuffix={<kbd className="tree-filter-kbd">⌘P</kbd>}
      searchInputRef={searchRef}
      loading={loading}
      treeData={withFields(treeData)}
      expandedKeys={expandedKeys}
      onExpand={(keys) => setExpandedKeys(keys)}
      selectedKeys={[]}
      onSelect={(keys) => onSelect(keys)}
      loadData={loadData}
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
    />
  );
}
