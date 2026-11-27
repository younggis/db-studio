// Spatial result viewer: renders geometry columns from a QueryResult on a
// lightweight offline canvas. Mirrors SSMS's "Spatial Results" tab, including
// the 5,000-row rendering cap.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Drawer, Select, Tag } from "antd";
import { Maximize2, ZoomIn, ZoomOut } from "lucide-react";
import type { GeoJSONGeometry, QueryResult } from "@db-studio/shared";
import { WbToolButton } from "./workbench/Workbench";
import { parseWkbBrowser } from "./wkb-browser";

const MAX_ROWS = 5000;

type Feature = {
  geometry: GeoJSONGeometry;
  properties: Record<string, unknown>;
  srid?: number | null;
  rowIndex: number;
};

type Bounds = { minX: number; minY: number; maxX: number; maxY: number };

function parseGeometry(value: unknown): { geometry: GeoJSONGeometry; srid?: number | null } | undefined {
  const parsed = parseWkbBrowser(value);
  return parsed ? { geometry: parsed.geometry, srid: parsed.srid } : undefined;
}

/** Columns that actually contain renderable geometry (metadata or sampled values). */
export function findGeometryColumns(result?: QueryResult): string[] {
  if (!result) return [];
  const declared = (result.columnMetadata ?? [])
    .filter((column) => column.geometryType)
    .map((column) => column.name);
  const sampled = result.columns.filter((name) =>
    result.rows.slice(0, 20).some((row) => !!parseGeometry(row[name])));
  return Array.from(new Set([...declared, ...sampled]));
}

function visitPositions(value: unknown, visit: (x: number, y: number) => void): void {
  if (!Array.isArray(value)) return;
  if (typeof value[0] === "number" && typeof value[1] === "number") {
    visit(value[0] as number, value[1] as number);
    return;
  }
  for (const child of value) visitPositions(child, visit);
}

function boundsOf(features: Feature[]): Bounds | undefined {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const feature of features) {
    visitPositions(feature.geometry.coordinates, (x, y) => {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      minX = Math.min(minX, x); minY = Math.min(minY, y);
      maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    });
  }
  if (!Number.isFinite(minX)) return undefined;
  const padX = (maxX - minX) * 0.06 || 0.5;
  const padY = (maxY - minY) * 0.06 || 0.5;
  return { minX: minX - padX, minY: minY - padY, maxX: maxX + padX, maxY: maxY + padY };
}

function token(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

type ScreenPoint = { x: number; y: number };
type Project = (x: number, y: number) => ScreenPoint;

function distanceToSegment(px: number, py: number, a: ScreenPoint, b: ScreenPoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (dx === 0 && dy === 0) return Math.hypot(px - a.x, py - a.y);
  const t = Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
}

function screenLine(value: unknown, project: Project): ScreenPoint[] {
  const points: ScreenPoint[] = [];
  visitPositions(value, (x, y) => points.push(project(x, y)));
  return points;
}

function nearLine(line: ScreenPoint[], x: number, y: number, threshold: number): boolean {
  if (line.length === 1) {
    return Math.abs(line[0].x - x) <= threshold && Math.abs(line[0].y - y) <= threshold;
  }
  for (let index = 1; index < line.length; index += 1) {
    if (distanceToSegment(x, y, line[index - 1], line[index]) <= threshold) return true;
  }
  return false;
}

function pointInRing(point: ScreenPoint, ring: ScreenPoint[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const a = ring[i];
    const b = ring[j];
    if ((a.y > point.y) !== (b.y > point.y)
      && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

function polygonHit(rings: ScreenPoint[][], x: number, y: number, threshold: number): boolean {
  if (rings.some((ring) => nearLine(ring, x, y, threshold))) return true;
  const point = { x, y };
  if (!rings.length || !pointInRing(point, rings[0])) return false;
  // Inner rings are holes: a point inside a hole does not hit the polygon.
  return !rings.slice(1).some((hole) => pointInRing(point, hole));
}

/** Hit-test the whole geometry, including polygon interiors and line segments. */
function geometryHits(geometry: GeoJSONGeometry, x: number, y: number, project: Project, threshold: number): boolean {
  if (geometry.type === "GeometryCollection") {
    const extra = geometry as unknown as { geometries?: GeoJSONGeometry[] };
    const children = extra.geometries ?? (geometry.coordinates as unknown as GeoJSONGeometry[]) ?? [];
    return children.some((child) => child && child.type && geometryHits(child, x, y, project, threshold));
  }
  const type = geometry.type.toLowerCase();
  if (type === "point" || type === "multipoint") {
    const positions = type === "point" ? [geometry.coordinates] : (geometry.coordinates as unknown[]);
    return positions.some((position) => {
      const point = screenLine(position, project);
      return point.length > 0 && nearLine(point, x, y, threshold);
    });
  }
  if (type === "linestring") return nearLine(screenLine(geometry.coordinates, project), x, y, threshold);
  if (type === "multilinestring") {
    return (geometry.coordinates as unknown[]).some((line) => nearLine(screenLine(line, project), x, y, threshold));
  }
  if (type === "polygon") {
    return polygonHit((geometry.coordinates as unknown[]).map((ring) => screenLine(ring, project)), x, y, threshold);
  }
  if (type === "multipolygon") {
    return (geometry.coordinates as unknown[]).some((polygon) =>
      polygonHit((polygon as unknown[]).map((ring) => screenLine(ring, project)), x, y, threshold));
  }
  return false;
}

function drawGeometry(
  ctx: CanvasRenderingContext2D,
  geometry: GeoJSONGeometry,
  project: (x: number, y: number) => { x: number; y: number },
  stroke: string,
  fill: string,
): void {
  if (geometry.type === "GeometryCollection") {
    const extra = geometry as unknown as { geometries?: GeoJSONGeometry[] };
    const children = extra.geometries ?? (geometry.coordinates as unknown as GeoJSONGeometry[]) ?? [];
    for (const child of children) {
      if (child && child.type) drawGeometry(ctx, child, project, stroke, fill);
    }
    return;
  }
  const type = geometry.type.toLowerCase();
  ctx.strokeStyle = stroke;
  ctx.fillStyle = fill;
  ctx.lineWidth = 1.6;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  const ring = (positions: unknown) => {
    ctx.beginPath();
    let started = false;
    visitPositions(positions, (x, y) => {
      const point = project(x, y);
      if (!started) { ctx.moveTo(point.x, point.y); started = true; }
      else ctx.lineTo(point.x, point.y);
    });
  };

  if (type === "point" || type === "multipoint") {
    visitPositions(geometry.coordinates, (x, y) => {
      const point = project(x, y);
      ctx.beginPath();
      ctx.arc(point.x, point.y, 3.2, 0, Math.PI * 2);
      ctx.fillStyle = stroke;
      ctx.fill();
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 1.6;
    });
    return;
  }
  if (type === "linestring" || type === "multilinestring") {
    const lines = type === "linestring" ? [geometry.coordinates] : (geometry.coordinates as unknown[]);
    for (const line of lines) { ring(line); ctx.stroke(); }
    return;
  }
  if (type === "polygon" || type === "multipolygon") {
    const polygons = type === "polygon" ? [geometry.coordinates] : (geometry.coordinates as unknown[]);
    for (const polygon of polygons) {
      const rings = polygon as unknown[];
      ctx.beginPath();
      for (const positions of rings) {
        let started = false;
        visitPositions(positions, (x, y) => {
          const point = project(x, y);
          if (!started) { ctx.moveTo(point.x, point.y); started = true; }
          else ctx.lineTo(point.x, point.y);
        });
        ctx.closePath();
      }
      ctx.fill();
      ctx.stroke();
    }
  }
}

export default function SpatialResultPanel({
  open, result, onClose,
}: {
  open: boolean;
  result?: QueryResult;
  onClose: () => void;
}) {
  const geometryColumns = useMemo(() => findGeometryColumns(result), [result]);
  const [column, setColumn] = useState("");
  useEffect(() => {
    if (!geometryColumns.includes(column)) setColumn(geometryColumns[0] ?? "");
  }, [geometryColumns, column]);

  const sourceRows = result?.rows.length ?? 0;
  const features = useMemo<Feature[]>(() => {
    if (!result || !column) return [];
    const rows = result.rows.slice(0, MAX_ROWS);
    const values: Feature[] = [];
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const parsed = parseGeometry(row[column]);
      if (!parsed) continue;
      const properties: Record<string, unknown> = {};
      for (const name of result.columns) {
        if (name !== column) properties[name] = row[name];
      }
      values.push({ geometry: parsed.geometry, srid: parsed.srid, properties, rowIndex: index + 1 });
    }
    return values;
  }, [result, column]);

  const bounds = useMemo(() => boundsOf(features), [features]);
  const [selected, setSelected] = useState<Feature | null>(null);
  useEffect(() => setSelected(null), [result, column]);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapObserver = useRef<ResizeObserver | null>(null);
  // The drawer portal mounts after our effects, so measure via a callback ref.
  const setWrapRef = useCallback((node: HTMLDivElement | null) => {
    wrapObserver.current?.disconnect();
    wrapObserver.current = null;
    if (!node) return;
    const measure = () => setSize({ width: node.clientWidth, height: node.clientHeight });
    measure();
    wrapObserver.current = new ResizeObserver(measure);
    wrapObserver.current.observe(node);
  }, []);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [view, setView] = useState({ zoom: 1, panX: 0, panY: 0 });
  const dragRef = useRef<{ pointerId: number; x: number; y: number; panX: number; panY: number } | null>(null);

  const project = useMemo(() => {
    if (!bounds || size.width === 0 || size.height === 0) return undefined;
    const dx = bounds.maxX - bounds.minX || 1;
    const dy = bounds.maxY - bounds.minY || 1;
    const scale = Math.min((size.width - 48) / dx, (size.height - 48) / dy);
    const centerX = (bounds.minX + bounds.maxX) / 2;
    const centerY = (bounds.minY + bounds.maxY) / 2;
    return (x: number, y: number) => ({
      x: (x - centerX) * scale * view.zoom + size.width / 2 + view.panX,
      y: (centerY - y) * scale * view.zoom + size.height / 2 + view.panY,
    });
  }, [bounds, size, view]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !open || size.width === 0 || size.height === 0) return;
    canvas.width = size.width;
    canvas.height = size.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, size.width, size.height);
    ctx.fillStyle = token("--wb-bg-subtle", "#f7f8fa");
    ctx.fillRect(0, 0, size.width, size.height);
    ctx.strokeStyle = token("--wb-border", "#e2e4e8");
    ctx.lineWidth = 1;
    for (let x = 0; x <= size.width; x += 64) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, size.height); ctx.stroke();
    }
    for (let y = 0; y <= size.height; y += 64) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(size.width, y); ctx.stroke();
    }
    if (!project) return;
    const stroke = token("--wb-brand", "#1677ff");
    const fill = "rgba(22,119,255,0.16)";
    for (const feature of features) drawGeometry(ctx, feature.geometry, project, stroke, fill);
  }, [features, open, project, size]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !open) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const factor = event.deltaY < 0 ? 1.15 : 1 / 1.15;
      setView((current) => ({ ...current, zoom: Math.min(40, Math.max(0.05, current.zoom * factor)) }));
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [open]);

  function localPoint(event: React.PointerEvent<HTMLCanvasElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function hitTest(x: number, y: number): Feature | null {
    if (!project) return null;
    // Topmost first; polygon interiors and line segments are hit as well as vertices.
    for (let index = features.length - 1; index >= 0; index -= 1) {
      const feature = features[index];
      if (geometryHits(feature.geometry, x, y, project, 6)) return feature;
    }
    return null;
  }

  function propertyText(value: unknown): string {
    if (value === null || value === undefined) return "NULL";
    if (value instanceof Uint8Array || (typeof Buffer !== "undefined" && Buffer.isBuffer(value))) {
      return `<二进制 ${value.length} 字节>`;
    }
    if (typeof value === "bigint") return value.toString();
    if (typeof value === "object") {
      try { return JSON.stringify(value); } catch { return "[对象]"; }
    }
    return String(value);
  }

  return (
    <Drawer
      title="空间结果预览"
      width={1120}
      open={open}
      onClose={onClose}
      rootClassName="wb-app-drawer spatial-drawer"
      styles={{ body: { padding: 0 } }}
    >
      <div className="spatial-panel">
        <div className="spatial-toolbar">
          <span className="spatial-label">空间字段</span>
          <Select
            aria-label="空间字段"
            value={column || undefined}
            onChange={setColumn}
            style={{ width: 240 }}
            placeholder="无可渲染字段"
            options={geometryColumns.map((name) => ({ value: name, label: name }))}
          />
          <Tag>{features.length} / {sourceRows} 行</Tag>
          {sourceRows > MAX_ROWS && <Tag color="warning">最多渲染前 {MAX_ROWS.toLocaleString()} 行</Tag>}
          <span className="spatial-spacer" />
          <WbToolButton icon={<ZoomIn size={14} />} tooltip="放大" onClick={() => setView((v) => ({ ...v, zoom: Math.min(40, v.zoom * 1.25) }))} />
          <WbToolButton icon={<ZoomOut size={14} />} tooltip="缩小" onClick={() => setView((v) => ({ ...v, zoom: Math.max(0.05, v.zoom / 1.25) }))} />
          <WbToolButton icon={<Maximize2 size={14} />} tooltip="适应窗口" onClick={() => setView({ zoom: 1, panX: 0, panY: 0 })} />
        </div>
        <div className="spatial-body">
          <div className="spatial-canvas-wrap" ref={setWrapRef}>
            <canvas
              ref={canvasRef}
              className="spatial-canvas"
              aria-label="空间结果地图"
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                event.currentTarget.setPointerCapture(event.pointerId);
                const point = localPoint(event);
                dragRef.current = { pointerId: event.pointerId, ...point, panX: view.panX, panY: view.panY };
              }}
              onPointerMove={(event) => {
                const active = dragRef.current;
                if (!active || active.pointerId !== event.pointerId) return;
                const point = localPoint(event);
                setView((current) => ({
                  ...current,
                  panX: active.panX + (point.x - active.x),
                  panY: active.panY + (point.y - active.y),
                }));
              }}
              onPointerUp={(event) => {
                const active = dragRef.current;
                dragRef.current = null;
                if (!active) return;
                const point = localPoint(event);
                if (Math.abs(point.x - active.x) < 3 && Math.abs(point.y - active.y) < 3) {
                  setSelected(hitTest(point.x, point.y));
                }
              }}
              onPointerCancel={() => { dragRef.current = null; }}
            />
            {features.length === 0 && (
              <div className="spatial-empty">当前结果没有可渲染的空间几何（支持 WKB / EWKB 字段）。</div>
            )}
          </div>
          <aside className="spatial-inspector">
            <div className="spatial-inspector-head">要素属性</div>
            {selected ? (
              <>
                <div className="spatial-inspector-row"><span>行号</span><b>{selected.rowIndex}</b></div>
                <div className="spatial-inspector-row"><span>几何</span><b>{selected.geometry.type}</b></div>
                {selected.srid !== undefined && selected.srid !== null && (
                  <div className="spatial-inspector-row"><span>SRID</span><b>{selected.srid}</b></div>
                )}
                {Object.entries(selected.properties).map(([name, value]) => (
                  <div className="spatial-inspector-row" key={name}>
                    <span>{name}</span><b title={propertyText(value)}>{propertyText(value)}</b>
                  </div>
                ))}
              </>
            ) : (
              <div className="spatial-inspector-hint">点击地图上的几何要素查看属性。</div>
            )}
          </aside>
        </div>
        <div className="spatial-footer">
          滚轮缩放 · 拖动平移 · 最多渲染 {MAX_ROWS.toLocaleString()} 行
          {column && ` · 字段 ${column}`}
        </div>
      </div>
    </Drawer>
  );
}
