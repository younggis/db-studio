// Phase 3 composition: a self-contained launcher for the two review-only GIS
// panels. It derives the active connection from the App's selected card (no
// separate dropdown), so there is exactly one connection selector visible.
import { useCallback, useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { Button, Space, Tooltip } from "antd";
import { Activity, ArchiveRestore, DatabaseZap, GitCompareArrows, Moon, ScanSearch, Sun } from "lucide-react";
import SpatialIndexPanel from "./SpatialIndexPanel";
import LayerHealthPanel from "./LayerHealthPanel";
import BackupPanel from "./BackupPanel";
import SchemaSyncPanel from "./SchemaSyncPanel";
import DataSyncPanel from "./DataSyncPanel";
import type { DatabaseEngine } from "@db-studio/shared";

interface ConnectionChoice { id: string; name: string; engine: DatabaseEngine }
type Panel = "spatial-index" | "layer-health" | "backup" | "schema-sync" | "data-sync" | null;

function readSelectedName(): string | undefined {
  const card = document.querySelector(".connection-card.selected .connection-name b");
  return card?.textContent?.trim() || undefined;
}

export function mountPhase3Launcher(): void {
  const host = document.createElement("div");
  host.id = "phase3-launcher-root";
  document.body.appendChild(host);
  ReactDOM.createRoot(host).render(<Phase3Launcher />);
}

export default function Phase3Launcher() {
  const [connections, setConnections] = useState<ConnectionChoice[]>([]);
  const [activeId, setActiveId] = useState<string>();
  const [panel, setPanel] = useState<Panel>(null);
  const [vectorPath, setVectorPath] = useState<string>();
  const [dark, setDark] = useState(false);

  useEffect(() => {
    window.dbStudio.connections.list().then((items) => {
      const choices = items.map((item) => ({ id: item.id, name: item.name, engine: item.engine as DatabaseEngine }));
      setConnections(choices);
      setActiveId((current) => current ?? choices[0]?.id);
    }).catch(() => undefined);
  }, []);

  // Track the App's selected connection card by observing class changes.
  useEffect(() => {
    const sync = () => {
      const name = readSelectedName();
      if (!name) return;
      const match = connections.find((item) => name.includes(item.name));
      if (match) setActiveId((current) => current === match.id ? current : match.id);
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ["class"], childList: true });
    return () => observer.disconnect();
  }, [connections]);

  const selected = connections.find((item) => item.id === activeId);

  const [schemas, setSchemas] = useState<string[]>([]);
  useEffect(() => {
    if (!activeId) { setSchemas([]); return; }
    window.dbStudio.database.schemas(activeId).then(setSchemas).catch(() => setSchemas([]));
  }, [activeId]);

  function toggleTheme() {
    const next = !dark;
    setDark(next);
    document.documentElement.setAttribute("data-theme", next ? "dark" : "light");
  }

  async function openLayerHealth() {
    const path = await window.dbStudio.files.openVector();
    if (!path) return;
    setVectorPath(path);
    setPanel("layer-health");
  }

  const openSpatialIndex = useCallback(() => { if (activeId) setPanel("spatial-index"); }, [activeId]);

  return (
    <>
      <div className="phase3-launcher" aria-label="GIS 辅助工具">
        <Space size={4}>
          <Tooltip title={dark ? "切换浅色主题" : "切换深色护眼主题"}>
            <Button type="text" size="small" aria-label="切换主题" icon={dark ? <Sun size={14} /> : <Moon size={14} />} onClick={toggleTheme} />
          </Tooltip>
          <Tooltip title="查看当前连接的表空间索引建议（只展示不执行）">
            <Button type="text" size="small" aria-label="索引诊断" icon={<ScanSearch size={14} />} disabled={!activeId} onClick={openSpatialIndex} />
          </Tooltip>
          <Tooltip title="选择矢量文件并做导入前体检">
            <Button type="text" size="small" aria-label="图层体检" icon={<Activity size={14} />} onClick={() => void openLayerHealth()} />
          </Tooltip>
          <Tooltip title="逻辑备份与 SQL 恢复">
            <Button type="text" size="small" aria-label="备份恢复" icon={<ArchiveRestore size={14} />} disabled={!activeId || selected?.engine === "mongodb"} onClick={() => setPanel("backup")} />
          </Tooltip>
          <Tooltip title="对比两个 Schema 的结构差异并同步">
            <Button type="text" size="small" aria-label="结构同步" icon={<GitCompareArrows size={14} />} disabled={!activeId || selected?.engine === "mongodb"} onClick={() => setPanel("schema-sync")} />
          </Tooltip>
          <Tooltip title="跨库同步表数据（替换或追加）">
            <Button type="text" size="small" aria-label="数据同步" icon={<DatabaseZap size={14} />} disabled={!activeId || selected?.engine === "mongodb"} onClick={() => setPanel("data-sync")} />
          </Tooltip>
        </Space>
      </div>

      <SpatialIndexPanel
        open={panel === "spatial-index"}
        onClose={() => setPanel(null)}
        connectionId={activeId}
        engine={selected?.engine}
        schemas={schemas}
      />
      <LayerHealthPanel
        open={panel === "layer-health"}
        onClose={() => setPanel(null)}
        filePath={vectorPath}
      />
      <BackupPanel
        open={panel === "backup"}
        onClose={() => setPanel(null)}
        connectionId={activeId}
        connectionName={selected?.name}
      />
      <SchemaSyncPanel
        open={panel === "schema-sync"}
        onClose={() => setPanel(null)}
        activeId={activeId}
      />
      <DataSyncPanel
        open={panel === "data-sync"}
        onClose={() => setPanel(null)}
        activeId={activeId}
      />
    </>
  );
}
