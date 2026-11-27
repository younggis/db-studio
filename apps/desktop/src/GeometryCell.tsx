import { useState, useEffect } from 'react';
import { Popover, Spin } from 'antd';
import { MapPin, Route, Square } from 'lucide-react';
import type { QueryResultColumn, GeoJSONGeometry } from '@db-studio/shared';

// GeoJSON Feature type (simplified)
interface GeoJSONFeature {
  type: 'Feature';
  geometry: GeoJSONGeometry;
  properties?: Record<string, any>;
}

interface GeometryCellProps {
  value: Buffer | string | null;
  column: QueryResultColumn;
  rowIndex: number;
  onOpenFullMap?: (geometry: GeoJSONFeature, column: QueryResultColumn) => void;
}

/**
 * Geometry cell component for displaying spatial data in query results
 *
 * Features:
 * - Shows geometry type icon and name
 * - Hover preview with mini map (future enhancement)
 * - Click to open full map view
 */
export default function GeometryCell({ value, column, rowIndex, onOpenFullMap }: GeometryCellProps) {
  const [geometry, setGeometry] = useState<GeoJSONFeature | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [parsing, setParsing] = useState(false);

  useEffect(() => {
    if (!value) {
      setGeometry(null);
      return;
    }

    // Parse WKB to GeoJSON on mount
    setParsing(true);

    // Dynamic import to avoid loading WKB parser until needed
    import('@db-studio/shared').then(({ parseWkbToGeojson }) => {
      try {
        const result = parseWkbToGeojson(value);
        setGeometry({
          type: 'Feature',
          geometry: result.geometry,
          properties: {
            srid: result.srid,
            hasZ: result.hasZ,
            hasM: result.hasM,
            coordinateDimension: result.coordinateDimension,
          },
        });
        setError(null);
      } catch (err) {
        console.warn(`Failed to parse WKB at row ${rowIndex}:`, err);
        setError(err instanceof Error ? err.message : 'Parse error');
        setGeometry(null);
      } finally {
        setParsing(false);
      }
    });
  }, [value, rowIndex]);

  if (!value) {
    return <span className="geometry-null" style={{ color: '#999', fontStyle: 'italic' }}>NULL</span>;
  }

  if (parsing) {
    return (
      <span className="geometry-loading" style={{ color: '#999' }}>
        <Spin size="small" /> 解析中...
      </span>
    );
  }

  if (error) {
    return (
      <Popover content={<div style={{ maxWidth: 300 }}>{error}</div>} title="解析错误">
        <span className="geometry-error" style={{ color: '#ff4d4f', cursor: 'help' }}>
          ⚠️ {column.geometryType || 'Geometry'}
        </span>
      </Popover>
    );
  }

  const icon = getGeometryIcon(column.geometryType);
  const displayText = column.geometryType || 'Geometry';
  const dimensionBadge = column.coordinateDimension && column.coordinateDimension > 2
    ? ` (${column.coordinateDimension}D)`
    : '';

  // Mini preview content (placeholder for future MapLibre integration)
  const previewContent = geometry ? (
    <div style={{ padding: '8px' }}>
      <div><strong>类型:</strong> {geometry.geometry.type}</div>
      {geometry.properties?.srid && <div><strong>SRID:</strong> {geometry.properties.srid}</div>}
      {geometry.properties?.coordinateDimension && (
        <div><strong>维度:</strong> {geometry.properties.coordinateDimension}D
          {geometry.properties.hasZ && ' (Z)'}
          {geometry.properties.hasM && ' (M)'}
        </div>
      )}
      <div style={{ marginTop: 8, fontSize: 12, color: '#666' }}>
        点击查看完整地图
      </div>
      {/* TODO: Add mini map preview using MapLibre GL */}
    </div>
  ) : null;

  return (
    <Popover
      content={previewContent}
      title={`${displayText} 预览`}
      trigger="hover"
      placement="right"
    >
      <button
        type="button"
        className="geometry-cell-button"
        onClick={() => geometry && onOpenFullMap?.(geometry, column)}
        style={{
          border: '1px solid #d9d9d9',
          borderRadius: 4,
          padding: '2px 8px',
          background: '#fafafa',
          cursor: 'pointer',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          fontSize: 13,
          transition: 'all 0.2s',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.borderColor = '#40a9ff';
          e.currentTarget.style.background = '#e6f7ff';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.borderColor = '#d9d9d9';
          e.currentTarget.style.background = '#fafafa';
        }}
      >
        {icon}
        <span>{displayText}{dimensionBadge}</span>
      </button>
    </Popover>
  );
}

/**
 * Get icon component for geometry type
 */
function getGeometryIcon(type?: string): React.ReactNode {
  switch (type) {
    case 'Point':
    case 'MultiPoint':
      return <MapPin size={14} />;
    case 'LineString':
    case 'MultiLineString':
      return <Route size={14} />;
    case 'Polygon':
    case 'MultiPolygon':
      return <Square size={14} />;
    case 'GeometryCollection':
      return <span style={{ fontSize: 14 }}>🗂️</span>;
    default:
      return <span style={{ fontSize: 14 }}>🌐</span>;
  }
}
