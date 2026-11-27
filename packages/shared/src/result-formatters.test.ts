import { describe, it, expect } from 'vitest';
import {
  formatSelectionAsPlainText,
  formatSelectionAsCsv,
  formatSelectionAsJson,
  formatSelectionAsInsert,
  formatSelectionWithHeaders,
  calculateSelectionStats,
  isSelectionTooLarge,
} from './result-formatters.js';

describe('Result Formatters', () => {
  const sampleData = [
    [1, 'Alice', null],
    [2, 'Bob', 'test'],
  ];
  const cols = ['id', 'name', 'note'];

  describe('formatSelectionAsPlainText', () => {
    it('formats with tab delimiter', () => {
      const result = formatSelectionAsPlainText(sampleData);
      expect(result).toBe('1\tAlice\t\n2\tBob\ttest');
    });

    it('supports custom delimiter', () => {
      const result = formatSelectionAsPlainText([[1, 2]], '|');
      expect(result).toBe('1|2');
    });

    it('returns empty string for empty data', () => {
      expect(formatSelectionAsPlainText([])).toBe('');
    });

    it('formats null as empty string', () => {
      const result = formatSelectionAsPlainText([[null, undefined]]);
      expect(result).toBe('\t');
    });
  });

  describe('formatSelectionAsCsv', () => {
    it('formats basic CSV', () => {
      const result = formatSelectionAsCsv([[1, 'Alice'], [2, 'Bob']]);
      expect(result).toBe('1,Alice\n2,Bob');
    });

    it('escapes commas in values', () => {
      const result = formatSelectionAsCsv([['hello, world']]);
      expect(result).toBe('"hello, world"');
    });

    it('escapes double quotes', () => {
      const result = formatSelectionAsCsv([['"quoted"']]);
      expect(result).toBe('"""quoted"""');
    });

    it('includes header when requested', () => {
      const result = formatSelectionAsCsv([[1, 'Alice']], true, ['id', 'name']);
      expect(result).toBe('id,name\n1,Alice');
    });

    it('handles newlines in values', () => {
      const result = formatSelectionAsCsv([['line1\nline2']]);
      expect(result).toBe('"line1\nline2"');
    });
  });

  describe('formatSelectionAsJson', () => {
    it('formats as JSON array of objects', () => {
      const result = formatSelectionAsJson([[1, 'Alice']], ['id', 'name'], false);
      const parsed = JSON.parse(result);
      expect(parsed).toEqual([{ id: 1, name: 'Alice' }]);
    });

    it('formats null values', () => {
      const result = formatSelectionAsJson([[1, null]], ['id', 'note'], false);
      const parsed = JSON.parse(result);
      expect(parsed[0].note).toBeNull();
    });

    it('returns empty array for empty data', () => {
      expect(formatSelectionAsJson([], [])).toBe('[]');
    });

    it('pretty prints by default', () => {
      const result = formatSelectionAsJson([[1]], ['id']);
      expect(result).toContain('\n');
    });
  });

  describe('formatSelectionAsInsert', () => {
    it('generates valid INSERT statement', () => {
      const result = formatSelectionAsInsert([[1, 'Alice']], ['id', 'name'], 'users');
      expect(result).toContain('INSERT INTO "users"');
      expect(result).toContain('"id", "name"');
      expect(result).toContain("1, 'Alice'");
    });

    it('handles schema-qualified table name', () => {
      const result = formatSelectionAsInsert([[1]], ['id'], 'users', 'public');
      expect(result).toContain('"public"."users"');
    });

    it('formats NULL values', () => {
      const result = formatSelectionAsInsert([[null]], ['val'], 'tbl');
      expect(result).toContain('NULL');
    });

    it('escapes single quotes in strings', () => {
      const result = formatSelectionAsInsert([["O'Brien"]], ['name'], 'users');
      expect(result).toContain("'O''Brien'");
    });

    it('formats numbers without quotes', () => {
      const result = formatSelectionAsInsert([[42, 3.14]], ['a', 'b'], 'tbl');
      expect(result).toContain('42, 3.14');
    });

    it('formats booleans', () => {
      const result = formatSelectionAsInsert([[true, false]], ['a', 'b'], 'tbl');
      expect(result).toContain('TRUE, FALSE');
    });
  });

  describe('formatSelectionWithHeaders', () => {
    it('prepends header row', () => {
      const result = formatSelectionWithHeaders([[1, 'Alice']], ['id', 'name']);
      const lines = result.split('\n');
      expect(lines[0]).toBe('id\tname');
      expect(lines[1]).toBe('1\tAlice');
    });
  });

  describe('calculateSelectionStats', () => {
    it('returns zeros for empty data', () => {
      const stats = calculateSelectionStats([]);
      expect(stats.cellCount).toBe(0);
      expect(stats.rowCount).toBe(0);
      expect(stats.colCount).toBe(0);
    });

    it('calculates correct cell count', () => {
      const stats = calculateSelectionStats([[1, 2], [3, 4], [5, 6]]);
      expect(stats.cellCount).toBe(6);
      expect(stats.rowCount).toBe(3);
      expect(stats.colCount).toBe(2);
    });
  });

  describe('isSelectionTooLarge', () => {
    it('returns false for small selection', () => {
      const stats = calculateSelectionStats([[1, 2], [3, 4]]);
      expect(isSelectionTooLarge(stats)).toBe(false);
    });

    it('returns true when exceeding max cells', () => {
      const stats = { cellCount: 10001, rowCount: 100, colCount: 101, estimatedSize: 100 };
      expect(isSelectionTooLarge(stats, 10000)).toBe(true);
    });
  });
});
