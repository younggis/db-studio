// Reusable workbench primitives for all page refactors.
// Every page must use these components + the wb-* tokens from workbench-theme.css
// so sizing, borders, typography and states stay identical across the product.
import type { Key, ReactNode } from "react";
import { Table, Tabs, Tooltip, Tree } from "antd";
import type { TableProps } from "antd/es/table";
import type { DataNode } from "antd/es/tree";

/* ---------------- Top toolbar ---------------- */
export function WbToolbar({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`wb-toolbar ${className}`}>{children}</div>;
}

export function WbToolbarGroup({ children }: { children: ReactNode }) {
  return <div className="wb-toolbar-group">{children}</div>;
}

export function WbToolButton({
  icon, label, tooltip, onClick, disabled, active, danger,
}: {
  icon?: ReactNode;
  label?: string;
  tooltip?: string;
  onClick?: () => void;
  disabled?: boolean;
  active?: boolean;
  danger?: boolean;
}) {
  const button = (
    <button
      type="button"
      className={`wb-tool-btn${active ? " is-active" : ""}${danger ? " is-danger" : ""}`}
      onClick={onClick}
      disabled={disabled}
    >
      {icon}
      {label && <span>{label}</span>}
    </button>
  );
  return tooltip ? <Tooltip title={tooltip}>{button}</Tooltip> : button;
}

/* ---------------- Data table ---------------- */
export function WbDataTable<RecordType extends object>(props: TableProps<RecordType>) {
  const { className = "", size = "small", rowClassName, ...rest } = props;
  return (
    <div className="wb-table-wrap">
      <Table<RecordType>
        {...rest}
        size={size}
        className={`wb-table ${className}`}
        rowClassName={(record, index) => {
          const custom = typeof rowClassName === "function"
            ? rowClassName(record, index, 0)
            : rowClassName ?? "";
          return `wb-row-${index % 2 === 0 ? "even" : "odd"} ${custom}`.trim();
        }}
      />
    </div>
  );
}

/* ---------------- Left tree sidebar ---------------- */
export function WbTreeSidebar({
  treeData, expandedKeys, onExpand, selectedKeys, onSelect, loading, title, actions, height = 600,
}: {
  treeData: DataNode[];
  expandedKeys?: Key[];
  onExpand?: (keys: Key[]) => void;
  selectedKeys?: Key[];
  onSelect?: (keys: Key[]) => void;
  loading?: boolean;
  title?: ReactNode;
  actions?: ReactNode;
  height?: number;
}) {
  return (
    <aside className="wb-sidebar">
      {title && <div className="wb-sidebar-head"><span>{title}</span>{actions}</div>}
      <div className="wb-sidebar-search">
        <input aria-label="过滤对象" placeholder="过滤对象…" />
      </div>
      <div className="wb-tree-host">
        {loading ? <div className="wb-tree-loading">加载中…</div> : (
          <Tree
            blockNode
            showIcon
            virtual
            height={height}
            treeData={treeData}
            expandedKeys={expandedKeys}
            onExpand={(keys) => onExpand?.(keys)}
            selectedKeys={selectedKeys}
            onSelect={(keys) => onSelect?.(keys)}
          />
        )}
      </div>
    </aside>
  );
}

/* ---------------- Multi-tab workspace ---------------- */
export function WbTabContainer<T extends string>({
  activeKey, onChange, items,
}: {
  activeKey: T;
  onChange: (key: T) => void;
  items: Array<{ key: T; label: ReactNode; children: ReactNode; closable?: boolean }>;
}) {
  return (
    <div className="wb-tab-container">
      <Tabs
        activeKey={activeKey}
        onChange={(key) => onChange(key as T)}
        type="card"
        items={items.map((item) => ({
          key: item.key,
          label: item.label,
          closable: item.closable,
          children: <div className="wb-tab-body">{item.children}</div>,
        }))}
      />
    </div>
  );
}

/* ---------------- Right inspector / bottom panel ---------------- */
export function WbInspector({
  open, title, onClose, children, width = 360,
}: {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  width?: number;
}) {
  if (!open) return null;
  return (
    <section className="wb-inspector" style={{ width }} aria-label="属性检查器">
      <header className="wb-inspector-head">
        <b>{title}</b>
        <button type="button" className="wb-tool-btn" onClick={onClose} aria-label="关闭检查器">×</button>
      </header>
      <div className="wb-inspector-body">{children}</div>
    </section>
  );
}

/* ---------------- Status bar ---------------- */
export function WbStatusBar({ left, right }: { left?: ReactNode; right?: ReactNode }) {
  return (
    <footer className="wb-statusbar">
      <span>{left}</span>
      <span>{right}</span>
    </footer>
  );
}

/* ---------------- Page shell ---------------- */
export function WbWorkbench({
  toolbar, sidebar, children, inspector, statusbar,
}: {
  toolbar?: ReactNode;
  sidebar?: ReactNode;
  children: ReactNode;
  inspector?: ReactNode;
  statusbar?: ReactNode;
}) {
  return (
    <div className="wb-app">
      {toolbar}
      <div className="wb-main">
        {sidebar}
        <main className="wb-workspace">{children}</main>
        {inspector}
      </div>
      {statusbar}
    </div>
  );
}
