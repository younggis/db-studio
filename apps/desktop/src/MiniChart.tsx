// Lightweight dependency-free SVG charts for the BI panel.
import type { ChartData, ChartType } from "./chart-data";

interface MiniChartProps {
  type: ChartType;
  data: ChartData;
  height?: number;
}

const WIDTH = 640;
const PAD = { left: 48, right: 16, top: 16, bottom: 34 };

function niceMax(value: number): number {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  return Math.ceil(value / magnitude) * magnitude;
}

function pathFor(values: number[], max: number, width: number, height: number): string {
  if (values.length === 0) return "";
  const step = values.length === 1 ? width / 2 : width / (values.length - 1);
  return values.map((value, index) => {
    const x = index * step;
    const y = height - (value / max) * height;
    return `${index === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
}

function piePath(startAngle: number, endAngle: number, radius: number, cx: number, cy: number): string {
  const x1 = cx + radius * Math.sin(startAngle);
  const y1 = cy - radius * Math.cos(startAngle);
  const x2 = cx + radius * Math.sin(endAngle);
  const y2 = cy - radius * Math.cos(endAngle);
  const large = endAngle - startAngle > Math.PI ? 1 : 0;
  return `M ${cx},${cy} L ${x1.toFixed(2)},${y1.toFixed(2)} A ${radius},${radius} 0 ${large} 1 ${x2.toFixed(2)},${y2.toFixed(2)} Z`;
}

export default function MiniChart({ type, data, height = 300 }: MiniChartProps) {
  const plotWidth = WIDTH - PAD.left - PAD.right;
  const plotHeight = height - PAD.top - PAD.bottom;
  const allValues = data.series.flatMap((series) => series.values);
  const max = niceMax(Math.max(0, ...allValues));
  const total = data.series[0]?.values.reduce((sum, value) => sum + value, 0) ?? 0;

  if (data.labels.length === 0 || data.series.length === 0) {
    return <div className="bi-chart-empty">暂无可绘制的数据，请先执行查询。</div>;
  }

  return (
    <div className="bi-chart">
      <svg viewBox={`0 0 ${WIDTH} ${height}`} width="100%" height={height} role="img" aria-label="查询结果图表">
        {type === "pie" ? (
          <g transform={`translate(${WIDTH / 2},${height / 2})`}>
            {(() => {
              let angle = 0;
              const radius = Math.min(plotHeight, plotWidth) / 2 - 8;
              const values = data.series[0]!.values;
              return values.map((value, index) => {
                const sweep = total > 0 ? (value / total) * Math.PI * 2 : 0;
                const path = piePath(angle, angle + sweep, radius, 0, 0);
                angle += sweep;
                return <path key={index} d={path} fill={data.series[0]!.color} opacity={0.55 + (index % 4) * 0.13}>
                  <title>{`${data.labels[index]}: ${value}`}</title>
                </path>;
              });
            })()}
          </g>
        ) : (
          <>
            {[0, 0.25, 0.5, 0.75, 1].map((fraction) => {
              const y = PAD.top + plotHeight * (1 - fraction);
              return (
                <g key={fraction}>
                  <line x1={PAD.left} x2={WIDTH - PAD.right} y1={y} y2={y} stroke="var(--ds-line)" strokeWidth={1} />
                  <text x={PAD.left - 8} y={y + 3} textAnchor="end" fontSize={10} fill="var(--ds-ink-3)">
                    {(max * fraction).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                  </text>
                </g>
              );
            })}
            <g transform={`translate(${PAD.left},${PAD.top})`}>
              {type === "bar" && data.labels.map((label, index) => {
                const groupWidth = plotWidth / data.labels.length;
                const barWidth = Math.max(2, (groupWidth * 0.7) / data.series.length);
                return data.series.map((series, seriesIndex) => {
                  const value = series.values[index] ?? 0;
                  const barHeight = (value / max) * plotHeight;
                  const x = index * groupWidth + groupWidth * 0.15 + seriesIndex * barWidth;
                  return <rect key={`${label}-${series.name}`} x={x} y={plotHeight - barHeight} width={barWidth} height={barHeight} fill={series.color} opacity={0.85}>
                    <title>{`${label} · ${series.name}: ${value}`}</title>
                  </rect>;
                });
              })}
              {(type === "line" || type === "area") && data.series.map((series) => {
                const line = pathFor(series.values, max, plotWidth, plotHeight);
                return (
                  <g key={series.name}>
                    {type === "area" && <path d={`${line} L ${plotWidth},${plotHeight} L 0,${plotHeight} Z`} fill={series.color} opacity={0.12} />}
                    <path d={line} fill="none" stroke={series.color} strokeWidth={2} />
                    {series.values.map((value, index) => {
                      const step = series.values.length === 1 ? plotWidth / 2 : plotWidth / (series.values.length - 1);
                      return <circle key={index} cx={index * step} cy={plotHeight - (value / max) * plotHeight} r={2.5} fill={series.color}>
                        <title>{`${data.labels[index]} · ${series.name}: ${value}`}</title>
                      </circle>;
                    })}
                  </g>
                );
              })}
              {type === "scatter" && data.series.map((series) => {
                const step = series.values.length === 1 ? plotWidth / 2 : plotWidth / (series.values.length - 1);
                return series.values.map((value, index) => (
                  <circle key={`${series.name}-${index}`} cx={index * step} cy={plotHeight - (value / max) * plotHeight} r={4} fill={series.color} opacity={0.75}>
                    <title>{`${data.labels[index]} · ${series.name}: ${value}`}</title>
                  </circle>
                ));
              })}
              {data.labels.map((label, index) => {
                const groupWidth = plotWidth / data.labels.length;
                return <text key={label + index} x={index * groupWidth + groupWidth / 2} y={plotHeight + 16} textAnchor="middle" fontSize={10} fill="var(--ds-ink-3)">
                  {label.length > 8 ? label.slice(0, 7) + "…" : label}
                </text>;
              })}
            </g>
          </>
        )}
      </svg>
      <div className="bi-legend">
        {type === "pie"
          ? data.labels.map((label, index) => (
              <span key={label + index}><i style={{ background: data.series[0]!.color, opacity: 0.55 + (index % 4) * 0.13 }} />{label} ({data.series[0]!.values[index]})</span>
            ))
          : data.series.map((series) => <span key={series.name}><i style={{ background: series.color }} />{series.name}</span>)}
      </div>
    </div>
  );
}
