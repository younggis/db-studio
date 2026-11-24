// Reconstructed from vendor chunk GisPreviewMap-NugCwivA.js.
// Lightweight SVG geometry preview with drag-to-select source-CRS extent.
import { useRef, useState } from "react";
import { Button } from "antd";

const WIDTH = 640;
const HEIGHT = 320;
const VERTEX_BUDGET = 8000;

interface Point { x: number; y: number }
interface Shape { kind: "point" | "line"; positions: Point[] }
interface Extent { minX: number; minY: number; maxX: number; maxY: number }
interface MapFeature { geometry?: unknown }

interface GisPreviewMapProps {
  features: MapFeature[];
  selectedExtent?: Extent | null;
  coordinateReference?: string;
  disabled?: boolean;
  onExtentChange: (extent: Extent | null) => void;
}

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readPoint(value: unknown): Point | undefined {
  if (!Array.isArray(value) || value.length < 2) return undefined;
  const x = value[0], y = value[1];
  return typeof x === "number" && Number.isFinite(x) && typeof y === "number" && Number.isFinite(y)
    ? { x, y }
    : undefined;
}

function readPoints(value: unknown, budget: { remaining: number; truncated: boolean }): Point[] {
  if (!Array.isArray(value)) return [];
  const points: Point[] = [];
  for (const raw of value) {
    const point = readPoint(raw);
    if (!point) return [];
    if (budget.remaining <= 0) { budget.truncated = true; break; }
    points.push(point);
    budget.remaining -= 1;
  }
  return points;
}

function collectGeometry(geometry: unknown, shapes: Shape[], budget: { remaining: number; truncated: boolean }, depth = 0): void {
  if (depth > 8 || budget.remaining <= 0) {
    if (budget.remaining <= 0) budget.truncated = true;
    return;
  }
  const object = asObject(geometry);
  const type = typeof object.type === "string" ? object.type : "";
  const coordinates = object.coordinates;
  if (type === "GeometryCollection") {
    if (Array.isArray(object.geometries)) {
      for (const child of object.geometries) {
        collectGeometry(child, shapes, budget, depth + 1);
        if (budget.remaining <= 0) break;
      }
    }
    return;
  }
  if (type === "Point") {
    const point = readPoint(coordinates);
    if (point) {
      if (budget.remaining <= 0) budget.truncated = true;
      else { shapes.push({ kind: "point", positions: [point] }); budget.remaining -= 1; }
    }
    return;
  }
  if (type === "MultiPoint") {
    for (const point of readPoints(coordinates, budget)) shapes.push({ kind: "point", positions: [point] });
    return;
  }
  const addLine = (raw: unknown) => {
    const positions = readPoints(raw, budget);
    if (positions.length > 0) shapes.push({ kind: "line", positions });
  };
  if (type === "LineString") addLine(coordinates);
  else if (type === "MultiLineString" || type === "Polygon") {
    if (Array.isArray(coordinates)) {
      for (const part of coordinates) {
        addLine(part);
        if (budget.remaining <= 0) break;
      }
    }
  } else if (type === "MultiPolygon" && Array.isArray(coordinates)) {
    for (const polygon of coordinates) {
      if (Array.isArray(polygon)) {
        for (const ring of polygon) {
          addLine(ring);
          if (budget.remaining <= 0) break;
        }
      }
      if (budget.remaining <= 0) break;
    }
  }
}

function buildShapes(features: MapFeature[]) {
  const budget = { remaining: VERTEX_BUDGET, truncated: false };
  const shapes: Shape[] = [];
  for (const feature of features) {
    collectGeometry(feature.geometry, shapes, budget);
    if (budget.remaining <= 0) break;
  }
  return { shapes, truncated: budget.truncated };
}

function boundsOf(shapes: Shape[]): Extent | undefined {
  const points = shapes.flatMap((shape) => shape.positions);
  if (points.length === 0) return undefined;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  const dx = maxX - minX, dy = maxY - minY;
  const padX = dx === 0 ? 0.5 : dx * 0.06;
  const padY = dy === 0 ? 0.5 : dy * 0.06;
  return { minX: minX - padX, minY: minY - padY, maxX: maxX + padX, maxY: maxY + padY };
}

function projector(extent: Extent) {
  const scale = Math.min((WIDTH - 36) / (extent.maxX - extent.minX), (HEIGHT - 36) / (extent.maxY - extent.minY));
  const offsetX = (WIDTH - (extent.maxX - extent.minX) * scale) / 2;
  const offsetY = (HEIGHT - (extent.maxY - extent.minY) * scale) / 2;
  return {
    toSvg(point: Point): Point {
      return {
        x: offsetX + (point.x - extent.minX) * scale,
        y: offsetY + (extent.maxY - point.y) * scale,
      };
    },
    toWorld(point: Point): Point {
      return {
        x: Math.max(extent.minX, Math.min(extent.maxX, extent.minX + (point.x - offsetX) / scale)),
        y: Math.max(extent.minY, Math.min(extent.maxY, extent.maxY - (point.y - offsetY) / scale)),
      };
    },
  };
}

function fmt(value: number): string {
  return Number(value.toPrecision(6)).toString();
}

export default function GisPreviewMap({ features, selectedExtent, coordinateReference, disabled = false, onExtentChange }: GisPreviewMapProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<{ pointerId: number; start: Point; current: Point } | null>(null);
  const [drag, setDrag] = useState<{ pointerId: number; start: Point; current: Point } | null>(null);
  const { shapes, truncated } = buildShapes(features);
  const extent = boundsOf(shapes);
  const projection = extent ? projector(extent) : undefined;

  function svgPoint(event: React.PointerEvent<SVGSVGElement>): Point | undefined {
    const svg = svgRef.current;
    const matrix = svg?.getScreenCTM();
    if (!svg || !matrix) return undefined;
    const point = svg.createSVGPoint();
    point.x = event.clientX;
    point.y = event.clientY;
    const local = point.matrixTransform(matrix.inverse());
    return { x: local.x, y: local.y };
  }

  function handleDown(event: React.PointerEvent<SVGSVGElement>) {
    if (disabled || event.button !== 0 || !extent) return;
    const point = svgPoint(event);
    if (!point) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const next = { pointerId: event.pointerId, start: point, current: point };
    dragRef.current = next;
    setDrag(next);
  }

  function handleMove(event: React.PointerEvent<SVGSVGElement>) {
    const active = dragRef.current;
    if (!active || active.pointerId !== event.pointerId) return;
    const point = svgPoint(event);
    if (!point) return;
    const next = { ...active, current: point };
    dragRef.current = next;
    setDrag(next);
  }

  function handleUp(event: React.PointerEvent<SVGSVGElement>) {
    const active = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    if (!active || active.pointerId !== event.pointerId || !projection) return;
    const point = svgPoint(event) ?? active.current;
    if (Math.abs(point.x - active.start.x) < 3 || Math.abs(point.y - active.start.y) < 3) return;
    const first = projection.toWorld(active.start);
    const second = projection.toWorld(point);
    const next: Extent = {
      minX: Math.min(first.x, second.x),
      minY: Math.min(first.y, second.y),
      maxX: Math.max(first.x, second.x),
      maxY: Math.max(first.y, second.y),
    };
    if (next.minX < next.maxX && next.minY < next.maxY) onExtentChange(next);
  }

  const selectedTopLeft = selectedExtent && projection ? projection.toSvg({ x: selectedExtent.minX, y: selectedExtent.maxY }) : undefined;
  const selectedBottomRight = selectedExtent && projection ? projection.toSvg({ x: selectedExtent.maxX, y: selectedExtent.minY }) : undefined;

  return (
    <div className="gis-map-preview">
      <div className="gis-map-preview-heading">
        <div><b>地图预览</b><span>{`显示前 ${features.length} 个预览要素 · ${coordinateReference ?? ""}`}</span></div>
        {selectedExtent && <Button type="link" size="small" disabled={disabled} onClick={() => onExtentChange(null)}>清除范围</Button>}
      </div>
      {projection
        ? <svg
            ref={svgRef}
            className={`gis-map-preview-svg${disabled ? " is-disabled" : ""}`}
            viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
            role="img"
            aria-label="GIS 几何地图预览；拖动鼠标框选导入范围"
            onPointerDown={handleDown}
            onPointerMove={handleMove}
            onPointerUp={handleUp}
            onPointerCancel={() => { dragRef.current = null; setDrag(null); }}
          >
            <rect x="0" y="0" width={WIDTH} height={HEIGHT} rx="8" fill="#f6f9f8" />
            <path
              d={`M 0 ${HEIGHT / 4} H ${WIDTH} M 0 ${HEIGHT / 2} H ${WIDTH} M 0 ${HEIGHT * 3 / 4} H ${WIDTH} M ${WIDTH / 4} 0 V ${HEIGHT} M ${WIDTH / 2} 0 V ${HEIGHT} M ${WIDTH * 3 / 4} 0 V ${HEIGHT}`}
              stroke="#e7eeeb"
              strokeWidth="1"
            />
            {shapes.map((shape, index) => {
              const points = shape.positions.map((point) => projection.toSvg(point));
              return shape.kind === "point"
                ? points.map((point, pointIndex) => (
                    <circle key={`${index}-${pointIndex}`} cx={point.x} cy={point.y} r="3.4" fill="#438477" stroke="#fff" strokeWidth="1.5" />
                  ))
                : <path
                    key={index}
                    d={points.map((point, pointIndex) => `${pointIndex === 0 ? "M" : "L"} ${point.x} ${point.y}`).join(" ")}
                    fill="none"
                    stroke="#438477"
                    strokeWidth="2"
                    strokeLinejoin="round"
                    strokeLinecap="round"
                  />;
            })}
            {selectedTopLeft && selectedBottomRight && (
              <rect
                className="gis-map-selected-extent"
                x={selectedTopLeft.x}
                y={selectedTopLeft.y}
                width={selectedBottomRight.x - selectedTopLeft.x}
                height={selectedBottomRight.y - selectedTopLeft.y}
              />
            )}
            {drag && (
              <rect
                className="gis-map-drag-extent"
                x={Math.min(drag.start.x, drag.current.x)}
                y={Math.min(drag.start.y, drag.current.y)}
                width={Math.abs(drag.current.x - drag.start.x)}
                height={Math.abs(drag.current.y - drag.start.y)}
              />
            )}
          </svg>
        : <div className="gis-map-preview-empty">预览样本中没有可绘制的二维几何。</div>}
      <div className="gis-map-preview-note">
        {selectedExtent
          ? `范围已启用 · X ${fmt(selectedExtent.minX)}~${fmt(selectedExtent.maxX)} · Y ${fmt(selectedExtent.minY)}~${fmt(selectedExtent.maxY)}`
          : "拖动鼠标框选范围；按源图层坐标的矩形范围过滤整层数据。"}
        {truncated && " · 几何顶点过多，预览已截断"}
      </div>
    </div>
  );
}
