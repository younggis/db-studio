import { describe, it, expect } from 'vitest';
import { parseWkbToGeojson, getWkbGeometryType, batchParseWkb } from './wkb-geojson.js';

describe('WKB to GeoJSON Parser', () => {
  describe('parseWkbToGeojson', () => {
    it('should parse 2D Point', () => {
      // POINT(1.5 2.5) in WKB (little-endian)
      const wkb = Buffer.from([
        0x01, // Little endian
        0x01, 0x00, 0x00, 0x00, // Type: Point (1)
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xf8, 0x3f, // X: 1.5
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x04, 0x40, // Y: 2.5
      ]);

      const result = parseWkbToGeojson(wkb);

      expect(result.geometry.type).toBe('Point');
      expect(result.geometry.coordinates).toEqual([1.5, 2.5]);
      expect(result.hasZ).toBe(false);
      expect(result.hasM).toBe(false);
      expect(result.coordinateDimension).toBe(2);
    });

    it('should parse 2D LineString', () => {
      // LINESTRING(0 0, 1 1, 2 0) in WKB (little-endian)
      const wkb = Buffer.from([
        0x01, // Little endian
        0x02, 0x00, 0x00, 0x00, // Type: LineString (2)
        0x03, 0x00, 0x00, 0x00, // Number of points: 3
        // Point 1: (0, 0)
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        // Point 2: (1, 1)
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xf0, 0x3f,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xf0, 0x3f,
        // Point 3: (2, 0)
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x40,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      ]);

      const result = parseWkbToGeojson(wkb);

      expect(result.geometry.type).toBe('LineString');
      expect(result.geometry.coordinates).toEqual([
        [0, 0],
        [1, 1],
        [2, 0],
      ]);
      expect(result.coordinateDimension).toBe(2);
    });

    it('should parse 2D Polygon', () => {
      // POLYGON((0 0, 4 0, 4 4, 0 4, 0 0)) - square
      const wkb = Buffer.from([
        0x01, // Little endian
        0x03, 0x00, 0x00, 0x00, // Type: Polygon (3)
        0x01, 0x00, 0x00, 0x00, // Number of rings: 1
        0x05, 0x00, 0x00, 0x00, // Number of points in ring: 5
        // Point 1: (0, 0)
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        // Point 2: (4, 0)
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x40,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        // Point 3: (4, 4)
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x40,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x40,
        // Point 4: (0, 4)
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x40,
        // Point 5: (0, 0) - closing point
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      ]);

      const result = parseWkbToGeojson(wkb);

      expect(result.geometry.type).toBe('Polygon');
      expect(result.geometry.coordinates).toHaveLength(1);
      expect(result.geometry.coordinates[0]).toHaveLength(5);
      expect(result.geometry.coordinates[0][0]).toEqual([0, 0]);
      expect(result.geometry.coordinates[0][4]).toEqual([0, 0]); // Closed ring
    });

    it('should parse 3D Point with Z coordinate', () => {
      // POINT Z(1 2 3) with ISO code (type 1001)
      const wkb = Buffer.from([
        0x01, // Little endian
        0xe9, 0x03, 0x00, 0x00, // Type: Point + 1000 = 1001
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xf0, 0x3f, // X: 1.0
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x40, // Y: 2.0
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x08, 0x40, // Z: 3.0
      ]);

      const result = parseWkbToGeojson(wkb);

      expect(result.geometry.type).toBe('Point');
      expect(result.geometry.coordinates).toEqual([1.0, 2.0, 3.0]);
      expect(result.hasZ).toBe(true);
      expect(result.hasM).toBe(false);
      expect(result.coordinateDimension).toBe(3);
    });

    it('should parse EWKB with SRID', () => {
      // SRID=4326;POINT(10 20) with SRID flag (0x20000000)
      const wkb = Buffer.from([
        0x01, // Little endian
        0x01, 0x00, 0x00, 0x20, // Type: Point with SRID flag
        0xe6, 0x10, 0x00, 0x00, // SRID: 4326
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x24, 0x40, // X: 10.0
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x34, 0x40, // Y: 20.0
      ]);

      const result = parseWkbToGeojson(wkb);

      expect(result.geometry.type).toBe('Point');
      expect(result.geometry.coordinates).toEqual([10.0, 20.0]);
      expect(result.srid).toBe(4326);
    });

    it('should parse hex string input', () => {
      // POINT(1 2) as hex string
      const hex = '0101000000000000000000F03F0000000000000040';
      const result = parseWkbToGeojson(hex);

      expect(result.geometry.type).toBe('Point');
      expect(result.geometry.coordinates).toEqual([1.0, 2.0]);
    });

    it('should throw error for empty WKB', () => {
      expect(() => parseWkbToGeojson(Buffer.from([]))).toThrow('WKB buffer is empty');
    });

    it('should throw error for truncated WKB', () => {
      const truncated = Buffer.from([0x01, 0x01]); // Incomplete
      expect(() => parseWkbToGeojson(truncated)).toThrow();
    });

    it('should throw error for invalid byte order', () => {
      const invalid = Buffer.from([0xFF, 0x01, 0x00, 0x00, 0x00]);
      expect(() => parseWkbToGeojson(invalid)).toThrow('Invalid WKB byte order');
    });
  });

  describe('getWkbGeometryType', () => {
    it('should extract geometry type without full parsing', () => {
      // Point
      const pointWkb = Buffer.from([0x01, 0x01, 0x00, 0x00, 0x00]);
      expect(getWkbGeometryType(pointWkb)).toBe('Point');

      // LineString
      const lineWkb = Buffer.from([0x01, 0x02, 0x00, 0x00, 0x00]);
      expect(getWkbGeometryType(lineWkb)).toBe('LineString');

      // Polygon
      const polygonWkb = Buffer.from([0x01, 0x03, 0x00, 0x00, 0x00]);
      expect(getWkbGeometryType(polygonWkb)).toBe('Polygon');
    });

    it('should return null for invalid WKB', () => {
      expect(getWkbGeometryType(Buffer.from([]))).toBeNull();
      expect(getWkbGeometryType(Buffer.from([0x01]))).toBeNull();
    });
  });

  describe('batchParseWkb', () => {
    it('should parse multiple WKB values', () => {
      const wkbs = [
        // POINT(1 2)
        Buffer.from([
          0x01, 0x01, 0x00, 0x00, 0x00,
          0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xf0, 0x3f,
          0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x40,
        ]),
        null, // Skip null
        // POINT(3 4)
        Buffer.from([
          0x01, 0x01, 0x00, 0x00, 0x00,
          0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x08, 0x40,
          0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x40,
        ]),
      ];

      const results = batchParseWkb(wkbs);

      expect(results).toHaveLength(3);
      expect(results[0]?.geometry.coordinates).toEqual([1, 2]);
      expect(results[1]).toBeNull();
      expect(results[2]?.geometry.coordinates).toEqual([3, 4]);
    });

    it('should respect maxCount limit', () => {
      const wkbs = Array(10).fill(Buffer.from([0x01, 0x01, 0x00, 0x00, 0x00]));
      const results = batchParseWkb(wkbs, 5);

      expect(results).toHaveLength(5);
    });

    it('should handle parse errors gracefully', () => {
      const wkbs = [
        Buffer.from([0x01, 0x01, 0x00, 0x00, 0x00]), // Valid header but truncated
        null,
      ];

      const results = batchParseWkb(wkbs);

      // Should not throw, but return null for failed parses
      expect(results[0]).toBeNull();
      expect(results[1]).toBeNull();
    });
  });
});
