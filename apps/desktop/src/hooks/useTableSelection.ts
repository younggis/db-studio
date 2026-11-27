import { useState, useCallback, useRef, useEffect } from 'react';

export interface CellPosition {
  row: number;
  col: number;
}

export interface SelectionRange {
  start: CellPosition;
  end: CellPosition;
}

export interface UseTableSelectionOptions {
  rowCount: number;
  colCount: number;
  onSelectionChange?: (selectedCells: Set<string>) => void;
}

export interface UseTableSelectionReturn {
  selectedCells: Set<string>;
  selectionMode: 'single' | 'multi' | 'range';
  anchorCell: CellPosition | null;
  handleCellClick: (row: number, col: number, ctrlKey: boolean, shiftKey: boolean) => void;
  handleCellMouseDown: (row: number, col: number) => void;
  handleCellMouseEnter: (row: number, col: number) => void;
  handleMouseUp: () => void;
  clearSelection: () => void;
  selectAll: () => void;
  selectRow: (row: number) => void;
  selectColumn: (col: number) => void;
  isSelected: (row: number, col: number) => boolean;
  getSelectedData: <T extends Record<string, unknown>>(rows: T[], columns: string[]) => Array<Array<unknown>>;
}

/**
 * Hook for managing table cell selection state
 *
 * Supports:
 * - Single cell selection (click)
 * - Multi-cell selection (Ctrl+Click)
 * - Range selection (Shift+Click)
 * - Drag selection (mouse down + drag)
 * - Row/column selection
 * - Select all
 */
export function useTableSelection({
  rowCount,
  colCount,
  onSelectionChange,
}: UseTableSelectionOptions): UseTableSelectionReturn {
  const [selectedCells, setSelectedCells] = useState<Set<string>>(new Set());
  const [selectionMode, setSelectionMode] = useState<'single' | 'multi' | 'range'>('single');
  const [anchorCell, setAnchorCell] = useState<CellPosition | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef<CellPosition | null>(null);

  // Helper function to generate cell key
  const cellKey = useCallback((row: number, col: number): string => {
    return `${row},${col}`;
  }, []);

  // Parse cell key back to position
  const parseCellKey = useCallback((key: string): CellPosition => {
    const [row, col] = key.split(',').map(Number);
    return { row, col };
  }, []);

  // Notify parent of selection change
  useEffect(() => {
    onSelectionChange?.(selectedCells);
  }, [selectedCells, onSelectionChange]);

  // Handle cell click (with keyboard modifiers)
  const handleCellClick = useCallback((
    row: number,
    col: number,
    ctrlKey: boolean,
    shiftKey: boolean
  ) => {
    if (shiftKey && anchorCell) {
      // Range selection: select all cells between anchor and current
      const newSelection = new Set<string>();
      const minRow = Math.min(anchorCell.row, row);
      const maxRow = Math.max(anchorCell.row, row);
      const minCol = Math.min(anchorCell.col, col);
      const maxCol = Math.max(anchorCell.col, col);

      for (let r = minRow; r <= maxRow; r++) {
        for (let c = minCol; c <= maxCol; c++) {
          newSelection.add(cellKey(r, c));
        }
      }

      setSelectedCells(newSelection);
      setSelectionMode('range');
    } else if (ctrlKey) {
      // Multi-selection: toggle cell
      const key = cellKey(row, col);
      const newSelection = new Set(selectedCells);

      if (newSelection.has(key)) {
        newSelection.delete(key);
      } else {
        newSelection.add(key);
      }

      setSelectedCells(newSelection);
      setSelectionMode('multi');
      setAnchorCell({ row, col });
    } else {
      // Single selection: select only this cell
      setSelectedCells(new Set([cellKey(row, col)]));
      setSelectionMode('single');
      setAnchorCell({ row, col });
    }
  }, [anchorCell, selectedCells, cellKey]);

  // Handle mouse down (start drag selection)
  const handleCellMouseDown = useCallback((row: number, col: number) => {
    setIsDragging(true);
    dragStartRef.current = { row, col };
    setAnchorCell({ row, col });
    setSelectedCells(new Set([cellKey(row, col)]));
    setSelectionMode('range');
  }, [cellKey]);

  // Handle mouse enter (during drag)
  const handleCellMouseEnter = useCallback((row: number, col: number) => {
    if (!isDragging || !dragStartRef.current) return;

    // Expand selection from drag start to current cell
    const newSelection = new Set<string>();
    const minRow = Math.min(dragStartRef.current.row, row);
    const maxRow = Math.max(dragStartRef.current.row, row);
    const minCol = Math.min(dragStartRef.current.col, col);
    const maxCol = Math.max(dragStartRef.current.col, col);

    for (let r = minRow; r <= maxRow; r++) {
      for (let c = minCol; c <= maxCol; c++) {
        newSelection.add(cellKey(r, c));
      }
    }

    setSelectedCells(newSelection);
  }, [isDragging, cellKey]);

  // Handle mouse up (end drag)
  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
    dragStartRef.current = null;
  }, []);

  // Clear all selection
  const clearSelection = useCallback(() => {
    setSelectedCells(new Set());
    setAnchorCell(null);
    setSelectionMode('single');
  }, []);

  // Select all cells
  const selectAll = useCallback(() => {
    const allCells = new Set<string>();
    for (let r = 0; r < rowCount; r++) {
      for (let c = 0; c < colCount; c++) {
        allCells.add(cellKey(r, c));
      }
    }
    setSelectedCells(allCells);
    setSelectionMode('range');
  }, [rowCount, colCount, cellKey]);

  // Select entire row
  const selectRow = useCallback((row: number) => {
    const rowCells = new Set<string>();
    for (let c = 0; c < colCount; c++) {
      rowCells.add(cellKey(row, c));
    }
    setSelectedCells(rowCells);
    setSelectionMode('range');
  }, [colCount, cellKey]);

  // Select entire column
  const selectColumn = useCallback((col: number) => {
    const colCells = new Set<string>();
    for (let r = 0; r < rowCount; r++) {
      colCells.add(cellKey(r, col));
    }
    setSelectedCells(colCells);
    setSelectionMode('range');
  }, [rowCount, cellKey]);

  // Check if a cell is selected
  const isSelected = useCallback((row: number, col: number): boolean => {
    return selectedCells.has(cellKey(row, col));
  }, [selectedCells, cellKey]);

  // Get selected data as 2D array
  const getSelectedData = useCallback(<T extends Record<string, unknown>>(
    rows: T[],
    columns: string[]
  ): Array<Array<unknown>> => {
    if (selectedCells.size === 0) return [];

    // Convert selected cells to array and sort by position
    const sortedCells = Array.from(selectedCells)
      .map(parseCellKey)
      .sort((a, b) => {
        if (a.row !== b.row) return a.row - b.row;
        return a.col - b.col;
      });

    // Find bounding box
    const minRow = Math.min(...sortedCells.map(c => c.row));
    const maxRow = Math.max(...sortedCells.map(c => c.row));
    const minCol = Math.min(...sortedCells.map(c => c.col));
    const maxCol = Math.max(...sortedCells.map(c => c.col));

    // Build 2D array with selected data
    const result: Array<Array<unknown>> = [];

    for (let r = minRow; r <= maxRow; r++) {
      const rowData: Array<unknown> = [];
      for (let c = minCol; c <= maxCol; c++) {
        if (selectedCells.has(cellKey(r, c))) {
          const columnName = columns[c];
          rowData.push(rows[r]?.[columnName] ?? null);
        } else {
          // Fill gaps with null for rectangular selection
          rowData.push(null);
        }
      }
      result.push(rowData);
    }

    return result;
  }, [selectedCells, parseCellKey, cellKey]);

  return {
    selectedCells,
    selectionMode,
    anchorCell,
    handleCellClick,
    handleCellMouseDown,
    handleCellMouseEnter,
    handleMouseUp,
    clearSelection,
    selectAll,
    selectRow,
    selectColumn,
    isSelected,
    getSelectedData,
  };
}
