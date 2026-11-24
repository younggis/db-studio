// Phase 3: layer health panel. Shows CRS, feature count, geometry type
// distribution, dimensions, invalid geometry count and encoding confidence
// before import, with a review-only MakeValid / encoding confirmation hint.
import { useEffect, useState } from "react";
import { Alert, Button, Drawer, Select, Space, Spin, Table, Tag, Typography, message } from "antd";
import { Activity, CheckCircle2, RefreshCw } from "lucide-react";
import { summarizeLayerHealth, type LayerHealthReport } from "@db-studio/core";
import type { GisAttributePreview, GisDatasetInfo, GisGeometryValidationReport } from "@db-studio/gis";

const { Text } = Typography;

interface LayerHealthPanelProps {
  open: boolean;
  onClose: () => void;
  filePath?: string;
  sourceEncoding?: string;
}

export default function LayerHealthPanel({ open, onClose, filePath, sourceEncoding }: LayerHealthPanelProps) {
  const [layerName, setLayerName] = useState<string>();
  const [info, setInfo] = useState<GisDatasetInfo>();
  const [report, setReport] = useState<LayerHealthReport>();
  const [busy, setBusy] = useState(false);

  async function inspect() {
    if (!filePath) return;
    setBusy(true);
    try {
      const dataset = await window.dbStudio.gis.inspect(filePath, sourceEncoding?.trim() ? { sourceEncoding: sourceEncoding.trim() } : undefined);
      setInfo(dataset);
      setLayerName((current) => current && dataset.layers.some((layer) => layer.name === current) ? current : dataset.layers[0]?.name);
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : "读取文件元数据失败。");
    } finally { setBusy(false); }
  }

  useEffect(() => { if (open && filePath) void inspect(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [open, filePath]);

  async function buildReport() {
    if (!filePath || !info || !layerName) return;
    setBusy(true);
    try {
      const options = sourceEncoding?.trim() ? { sourceEncoding: sourceEncoding.trim() } : undefined;
      const layer = info.layers.find((item) => item.name === layerName)!;
      const [preview, validation] = await Promise.all([
        window.dbStudio.gis.preview(filePath, { ...options, sourceLayer: layerName, limit: 50 }) as Promise<GisAttributePreview>,
        window.dbStudio.gis.validate(filePath, { ...options, sourceLayer: layerName }) as Promise<GisGeometryValidationReport>,
      ]);
      setReport(summarizeLayerHealth({ info, layer, preview, validation }));
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : "图层体检失败。");
    } finally { setBusy(false); }
  }

  useEffect(() => { setReport(undefined); }, [layerName]);

  return (
    <Drawer
      title={<span><Activity size={16} /> 图层体检</span>}
      open={open}
      onClose={onClose}
      width={680}
      destroyOnHidden
    >
      <Alert
        showIcon
        type="info"
        message="导入前体检"
        description="汇总 CRS、要素数、几何分布、无效几何与编码置信度。体检只读元数据与样本，不会查询或上传业务行。"
      />
      <Space direction="vertical" style={{ width: "100%" }} size={12}>
        <Space.Compact style={{ width: "100%" }}>
          <Select
            value={layerName}
            onChange={setLayerName}
            placeholder="选择图层"
            loading={busy}
            style={{ width: "100%" }}
            options={(info?.layers ?? []).map((layer) => ({ value: layer.name, label: `${layer.name} · ${layer.featureCount ?? "未知"} 要素` }))}
          />
          <Button icon={<RefreshCw size={13} />} loading={busy} disabled={!filePath} onClick={() => void inspect()}>读取</Button>
          <Button type="primary" loading={busy} disabled={!layerName} onClick={() => void buildReport()}>体检</Button>
        </Space.Compact>

        {!filePath && <Alert type="warning" message="请先在 GIS 页选择一个矢量文件。" />}

        {busy && <div className="gis-loading"><Spin size="small" /> 正在体检…</div>}

        {report && <>
          <Table
            size="small"
            pagination={false}
            rowKey="key"
            dataSource={[
              { key: "crs", item: "坐标参考系", value: report.crs ?? "未知" },
              { key: "features", item: "要素数", value: report.featureCount ?? "未知" },
              { key: "fields", item: "字段数", value: report.fieldCount },
              { key: "invalid", item: "无效几何", value: report.invalidGeometryCount },
              { key: "dims", item: "维度", value: report.dimensions.join(" / ") || "未知" },
              { key: "encoding", item: "编码", value: `${report.encoding.source} · ${report.encoding.declared ?? report.encoding.detected ?? "未知"}` },
              { key: "confidence", item: "编码置信度", value: report.encoding.confidence == null ? "—" : `${Math.round(report.encoding.confidence * 100)}%` },
            ]}
            columns={[{ title: "项目", dataIndex: "item", width: 140 }, { title: "结果", dataIndex: "value" }]}
          />
          <Space size={8} wrap>
            <Text strong>几何类型</Text>
            {report.geometryTypes.length
              ? report.geometryTypes.map((item) => <Tag color="cyan" key={item.type}>{`${item.type} · ${item.count}`}</Tag>)
              : <Tag>无样本几何</Tag>}
          </Space>
          {report.canMakeValid
            ? <Alert showIcon type="warning" message={`发现 ${report.invalidGeometryCount} 条几何问题`} description={report.makeValidHint} />
            : <Alert showIcon type="success" icon={<CheckCircle2 size={14} />} message="样本中未发现无效几何" />}
          {report.issuesTruncated && <Text type="secondary">几何问题列表已截断，仅展示有上限的样本。</Text>}
          {report.encoding.requiresUserChoice && (
            <Alert showIcon type="warning" message="需要确认源编码" description="当前编码为候选推断，请在 GIS 导入表单填写实际编码并预览中文属性。" />
          )}
          {report.warnings.length > 0 && (
            <Alert showIcon type="warning" message="体检提示" description={<ul>{report.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>} />
          )}
        </>}
      </Space>
    </Drawer>
  );
}
