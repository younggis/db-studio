import { Menu } from 'antd';
import { Copy, FileText, Braces, Code, Table as TableIcon } from 'lucide-react';
import type { ItemType } from 'antd/es/menu/interface';

export interface CopyContextMenuProps {
  hasSelection: boolean;
  selectionStats: {
    cellCount: number;
    rowCount: number;
    colCount: number;
  };
  onCopy: (format: 'plain' | 'csv' | 'json' | 'insert') => void;
  onCopyWithHeaders: () => void;
  onCopyRow: () => void;
  onCopyColumn: () => void;
  onCopyColumnName: () => void;
  contextCell?: { row: number; col: number };
}

/**
 * Context menu for copy operations in query result table
 *
 * Features:
 * - Copy selection in multiple formats
 * - Copy entire row/column
 * - Copy column name
 * - Shows selection statistics
 */
export default function CopyContextMenu({
  hasSelection,
  selectionStats,
  onCopy,
  onCopyWithHeaders,
  onCopyRow,
  onCopyColumn,
  onCopyColumnName,
  contextCell,
}: CopyContextMenuProps) {
  const items: ItemType[] = [];

  if (hasSelection) {
    // Selection exists - show copy options
    const selectionLabel = selectionStats.cellCount === 1
      ? '1 个单元格'
      : selectionStats.rowCount === 1
        ? `${selectionStats.colCount} 列`
        : selectionStats.colCount === 1
          ? `${selectionStats.rowCount} 行`
          : `${selectionStats.rowCount} × ${selectionStats.colCount}`;

    items.push(
      {
        key: 'copy-plain',
        label: '复制（纯文本）',
        icon: <Copy size={14} />,
        onClick: () => onCopy('plain'),
      },
      {
        key: 'copy-with-headers',
        label: '复制（带列名）',
        icon: <FileText size={14} />,
        onClick: () => onCopyWithHeaders(),
      },
      {
        key: 'copy-csv',
        label: '复制为 CSV',
        icon: <TableIcon size={14} />,
        onClick: () => onCopy('csv'),
      },
      {
        key: 'copy-json',
        label: '复制为 JSON',
        icon: <Braces size={14} />,
        onClick: () => onCopy('json'),
      },
      {
        key: 'copy-insert',
        label: '复制为 INSERT 语句',
        icon: <Code size={14} />,
        onClick: () => onCopy('insert'),
      },
      { type: 'divider' },
      {
        key: 'selection-info',
        label: (
          <span style={{ color: '#8c8c8c', fontSize: 12, fontStyle: 'italic' }}>
            已选择: {selectionLabel}
          </span>
        ),
        disabled: true,
      }
    );
  }

  if (contextCell) {
    // Context cell - show row/column operations
    if (items.length > 0) {
      items.push({ type: 'divider' });
    }

    items.push(
      {
        key: 'copy-row',
        label: '复制整行',
        icon: <Copy size={14} />,
        onClick: () => onCopyRow(),
      },
      {
        key: 'copy-column',
        label: '复制整列',
        icon: <Copy size={14} />,
        onClick: () => onCopyColumn(),
      },
      { type: 'divider' },
      {
        key: 'copy-column-name',
        label: '复制列名',
        icon: <FileText size={14} />,
        onClick: () => onCopyColumnName(),
      }
    );
  }

  if (items.length === 0) {
    // No selection - show disabled message
    items.push({
      key: 'no-selection',
      label: '未选择单元格',
      disabled: true,
    });
  }

  return <Menu items={items} />;
}

/**
 * Helper to format selection size for display
 */
export function formatSelectionSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
