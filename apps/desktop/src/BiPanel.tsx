// BI workspace: design a chart from SQL results and save widgets to a dashboard.
import { useEffect, useState } from "react";
import { Button, Drawer, Input, Select, Space, Tabs, Typography, message } from "antd";
import { BarChart3, Play, RefreshCw, Save, Trash2 } from "lucide-react";
import type { DatabaseEngine } from "@db-studio/shared";
import MiniChart from "./MiniChart";
import { prepareChartData, type Aggregation, type ChartType, type ChartData } from "./chart-data";

const { Text } = Typography;

type Widget = {
  id: string; title: string; type: string; connectionId: string; sql: string;
  xField: string; yFields: string[]; aggregation: string; createdAt: string;
};

const CHART_TYPES: Array<{ value: ChartType; label: string }> = [
  { value: "bar", label: "柱状" }, { value: "line", label: "折线" },
  { value: "area", label: "面积" }, { value: "pie", label: "饼图" }, { value: "scatter", label: "散点" },
];

export default function BiPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [connections, setConnections] = useState<Array<{ id: string; name: string; engine: DatabaseEngine }>>([]);
  const [connectionId, setConnectionId] = useState("");
  const [sql, setSql] = useState("SELECT 1 AS category, 2 AS value");
  const [columns, setColumns] = useState<string[]>([]);
  const [rows, setRows] = useState<Array<Record<string, unknown>>>([]);
  const [xField, setXField] = useState("");
  const [yFields, setYFields] = useState<string[]>([]);
  const [chartType, setChartType] = useState<ChartType>("bar");
  const [aggregation, setAggregation] = useState<Aggregation>("none");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [widgets, setWidgets] = useState<Widget[]>([]);
  const [dashboardData, setDashboardData] = useState<Record<string, ChartData>>({});

  useEffect(() => {
    if (!open) return;
    window.dbStudio.connections.list().then((items) => {
      const sqlConns = items.filter((item) => item.engine !== "mongodb")
        .map((item) => ({ id: item.id, name: item.name, engine: item.engine as DatabaseEngine }));
      setConnections(sqlConns);
      setConnectionId((current) => current || sqlConns[0]?.id || "");
    }).catch(() => undefined);
    void refreshDashboard();
  }, [open]);

  async function runQuery() {
    const activeConnection = connectionId || connections[0]?.id;
    if (!activeConnection || !sql.trim()) { message.warning("请选择连接并填写 SQL。"); return; }
    if (!connectionId) setConnectionId(activeConnection);
    setBusy(true);
    try {
      const result = await window.dbStudio.database.query(activeConnection, sql);
      const nextX = result.columns.includes(xField) ? xField : result.columns[0] ?? "";
      setRows(result.rows);
      setColumns(result.columns);
      setXField(nextX);
      setYFields((current) => {
        const valid = current.filter((field) => result.columns.includes(field));
        if (valid.length) return valid;
        return result.columns.filter((field) => field !== nextX).slice(0, 3);
      });
      if (!result.rows.length) message.info("查询成功，但没有返回行。");
    } catch (error) { message.error(error instanceof Error ? error.message : "查询失败。"); }
    finally { setBusy(false); }
  }

  const chartData = prepareChartData(rows, xField, yFields, aggregation);

  async function saveWidget() {
    if (!title.trim() || !yFields.length) { message.warning("请填写标题并至少选择一个数值字段。"); return; }
    setBusy(true);
    try {
      setWidgets(await window.dbStudio.bi.save({
        title: title.trim(), type: chartType, connectionId, sql,
        xField, yFields, aggregation,
      }));
      message.success("图表已保存到仪表盘");
      setTitle("");
    } catch (error) { message.error(error instanceof Error ? error.message : "保存失败。"); }
    finally { setBusy(false); }
  }

  async function refreshDashboard() {
    try {
      const list = await window.dbStudio.bi.list();
      setWidgets(list);
      const next: Record<string, ChartData> = {};
      for (const widget of list) {
        try {
          const result = await window.dbStudio.database.query(widget.connectionId, widget.sql);
          next[widget.id] = prepareChartData(result.rows, widget.xField, widget.yFields, widget.aggregation as Aggregation);
        } catch { next[widget.id] = { labels: [], series: [] }; }
      }
      setDashboardData(next);
    } catch { /* panel may not be open yet */ }
  }

  async function removeWidget(id: string) {
    setWidgets(await window.dbStudio.bi.remove(id));
    setDashboardData((current) => { const next = { ...current }; delete next[id]; return next; });
  }

  return (
    <Drawer title="BI 图表 / 仪表盘" width={960} open={open} onClose={onClose}>
      <Tabs items={[
        {
          key: "design",
          label: "图表设计",
          children: <>
            <div className="dbtools-row">
              <span className="dbtools-label">连接</span>
              <Select value={connectionId || undefined} onChange={setConnectionId}
                options={connections.map((item) => ({ value: item.id, label: `${item.name} · ${item.engine}` }))} style={{ width: 280 }} />
              <Button icon={<Play size={14} />} loading={busy} onClick={() => void runQuery()}>执行查询</Button>
            </div>
            <Input.TextArea rows={3} value={sql} onChange={(event) => setSql(event.target.value)} spellCheck={false}
              placeholder="SELECT category, SUM(value) AS total FROM t GROUP BY category" style={{ fontFamily: "monospace", fontSize: 12 }} />
            <div className="dbtools-row">
              <span className="dbtools-label">X 轴</span>
              <Select value={xField || undefined} onChange={setXField} options={columns.map((item) => ({ value: item, label: item }))} style={{ width: 180 }} />
              <span className="dbtools-label">Y 轴</span>
              <Select mode="multiple" value={yFields} onChange={setYFields} options={columns.map((item) => ({ value: item, label: item }))} style={{ width: 260 }} placeholder="数值字段" />
            </div>
            <div className="dbtools-row">
              <span className="dbtools-label">图表</span>
              <Select value={chartType} onChange={setChartType} options={CHART_TYPES} style={{ width: 120 }} />
              <span className="dbtools-label">聚合</span>
              <Select value={aggregation} onChange={setAggregation}
                options={[{ value: "none", label: "原始值" }, { value: "sum", label: "求和" }, { value: "count", label: "计数" }, { value: "avg", label: "平均" }]}
                style={{ width: 120 }} />
            </div>
            <MiniChart type={chartType} data={chartData} height={300} />
            <div className="dbtools-actions">
              <Input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="图表标题" style={{ width: 220 }} />
              <Button type="primary" className="mongo-primary" icon={<Save size={14} />} loading={busy} onClick={() => void saveWidget()}>保存到仪表盘</Button>
            </div>
          </>,
        },
        {
          key: "dashboard",
          label: "仪表盘",
          children: <>
            <Space style={{ marginBottom: 12 }}>
              <Button icon={<RefreshCw size={14} />} loading={busy} onClick={() => void refreshDashboard()}>刷新全部</Button>
              <Text type="secondary">{widgets.length} 个图表</Text>
            </Space>
            <div className="bi-dashboard-grid">
              {widgets.map((widget) => (
                <div className="bi-widget" key={widget.id}>
                  <div className="bi-widget-head">
                    <b>{widget.title}</b>
                    <Space size={2}>
                      <Text type="secondary">{widget.type}</Text>
                      <Button type="text" size="small" danger icon={<Trash2 size={13} />} onClick={() => void removeWidget(widget.id)} />
                    </Space>
                  </div>
                  <MiniChart type={widget.type as ChartType} data={dashboardData[widget.id] ?? { labels: [], series: [] }} height={220} />
                </div>
              ))}
              {widgets.length === 0 && <div className="bi-chart-empty"><BarChart3 size={22} /><span>还没有保存的图表，请先在「图表设计」中创建一个。</span></div>}
            </div>
          </>,
        },
      ]} />
    </Drawer>
  );
}
