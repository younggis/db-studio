// Phase 3 composition: a self-contained launcher that exposes the two
// review-only GIS panels without modifying the compiled App chunk. It owns its
// own connection/file selection so it does not depend on App internal state.
import { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { Button, Select, Space, Tooltip } from "antd";
import { Activity, Database, ScanSearch } from "lucide-react";
import SpatialIndexPanel from "./SpatialIndexPanel";
import LayerHealthPanel from "./LayerHealthPanel";
import type { DatabaseEngine } from "@db-studio/shared";

interface ConnectionChoice {
  id: string;
  name: string;
  engine: DatabaseEngine;
}

type Panel = "spatial-index" | "layer-health" | null;

export function mountPhase3Launcher(): void {
  const host = document.createElement("div");
  host.id = "phase3-launcher-root";
  document.body.appendChild(host);
  ReactDOM.createRoot(host).render(<Phase3Launcher />);
}

export default function Phase3Launcher() {
  const [connections, setConnections] = useState<ConnectionChoice[]>([]);
  const [connectionId, setConnectionId] = useState<string>();
  const [panel, setPanel] = useState<Panel>(null);
  const [vectorPath, setVectorPath] = useState<string>();

  useEffect(() => {
    window.dbStudio.connections.list().then((items) => {
      const choices = items.map((item) => ({
        id: item.id,
        name: item.name,
        engine: item.engine as DatabaseEngine,
      }));
      setConnections(choices);
      setConnectionId((current) => current && choices.some((item) => item.id === current) ? current : choices[0]?.id);
    }).catch(() => undefined);
  }, []);

  const selected = connections.find((item) => item.id === connectionId);

  async function openLayerHealth() {
    const path = await window.dbStudio.files.openVector();
    if (!path) return;
    setVectorPath(path);
    setPanel("layer-health");
  }

  async function openSpatialIndex() {
    if (!connectionId) return;
    setPanel("spatial-index");
  }

  async function schemasForSelected(): Promise<string[]> {
    if (!connectionId) return [];
    try { return await window.dbStudio.database.schemas(connectionId); }
    catch { return []; }
  }

  const [schemas, setSchemas] = useState<string[]>([]);
  useEffect(() => { if (connectionId) void schemasForSelected().then(setSchemas); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [connectionId]);

  return (
    <>
      <div className="phase3-launcher" aria-label="GIS 辅助工具">
        <Space size={6}>
          <Select
            value={connectionId}
            onChange={setConnectionId}
            placeholder="连接"
            size="small"
            style={{ width: 190 }}
            options={connections.map((item) => ({ value: item.id, label: `${item.name} · ${item.engine}` }))}
          />
          <Tooltip title="查看表空间索引建议（只展示不执行）">
            <Button size="small" icon={<ScanSearch size={14} />} disabled={!connectionId} onClick={() => void openSpatialIndex()}>索引诊断</Button>
          </Tooltip>
          <Tooltip title="选择矢量文件并做导入前体检">
            <Button size="small" icon={<Activity size={14} />} onClick={() => void openLayerHealth()}>图层体检</Button>
          </Tooltip>
        </Space>
      </div>

      <SpatialIndexPanel
        open={panel === "spatial-index"}
        onClose={() => setPanel(null)}
        connectionId={connectionId}
        engine={selected?.engine}
        schemas={schemas}
      />
      <LayerHealthPanel
        open={panel === "layer-health"}
        onClose={() => setPanel(null)}
        filePath={vectorPath}
      />
    </>
  );
}
