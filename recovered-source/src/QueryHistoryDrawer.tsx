import { useEffect, useMemo, useState } from "react";
import { Button, Drawer, Empty, Input, List, Modal, Popconfirm, Select, Space, Tabs, Tag, Typography, message } from "antd";
import { ArrowDownToLine, Clock3, Database, History as HistoryIcon, Star, Trash2 } from "lucide-react";
import { createEmptyQueryHistorySnapshot } from "@db-studio/shared/query-history";
import type { DatabaseEngine, QueryExecutionRecord, QueryFavorite, QueryHistorySnapshot } from "@db-studio/shared";

export interface QueryHistoryConnection {
  id: string;
  name: string;
  engine: DatabaseEngine;
}

interface QueryTextSource {
  sql: string;
  connectionId?: string;
  connectionName: string;
  engine: DatabaseEngine;
}

interface QueryHistoryDrawerProps {
  open: boolean;
  sql: string;
  connection?: QueryHistoryConnection;
  connections: QueryHistoryConnection[];
  onClose(): void;
  onRestore(source: QueryTextSource): void;
}

function makeId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function defaultTitle(sql: string): string {
  return sql.trim().split(/\r?\n/, 1)[0]?.replace(/\s+/g, " ").slice(0, 72) || "未命名查询";
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "short" }).format(date);
}

function matchesFilter(source: QueryTextSource, query: string, connectionFilter: string): boolean {
  if (connectionFilter !== "all" && source.connectionId !== connectionFilter) return false;
  if (!query) return true;
  const haystack = `${source.connectionName}\n${source.engine}\n${source.sql}`.toLocaleLowerCase();
  return haystack.includes(query.toLocaleLowerCase());
}

export default function QueryHistoryDrawer({ open, sql, connection, connections, onClose, onRestore }: QueryHistoryDrawerProps) {
  const [snapshot, setSnapshot] = useState<QueryHistorySnapshot>(createEmptyQueryHistorySnapshot);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [favoriteSource, setFavoriteSource] = useState<QueryTextSource | null>(null);
  const [favoriteTitle, setFavoriteTitle] = useState("");
  const [favoriteBusy, setFavoriteBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    let disposed = false;
    setLoading(true);
    void window.dbStudio.queryHistory.list().then((next) => {
      if (!disposed) setSnapshot(next);
    }).catch(() => {
      if (!disposed) message.error("无法读取本机查询历史。");
    }).finally(() => {
      if (!disposed) setLoading(false);
    });
    return () => { disposed = true; };
  }, [open]);

  const history = useMemo(() => snapshot.history.filter((entry) => matchesFilter(entry, search.trim(), filter)), [snapshot.history, search, filter]);
  const favorites = useMemo(() => snapshot.favorites.filter((entry) => matchesFilter(entry, search.trim(), filter)), [snapshot.favorites, search, filter]);
  const currentSource: QueryTextSource | null = connection && sql.trim()
    ? { sql, connectionId: connection.id, connectionName: connection.name, engine: connection.engine }
    : null;

  function beginFavorite(source: QueryTextSource) {
    setFavoriteSource(source);
    setFavoriteTitle(defaultTitle(source.sql));
  }

  async function saveFavorite() {
    if (!favoriteSource || !favoriteTitle.trim()) return;
    const now = new Date().toISOString();
    const value: QueryFavorite = {
      id: makeId(),
      title: favoriteTitle.trim().slice(0, 120),
      ...(favoriteSource.connectionId ? { connectionId: favoriteSource.connectionId } : {}),
      connectionName: favoriteSource.connectionName,
      engine: favoriteSource.engine,
      sql: favoriteSource.sql,
      createdAt: now,
      updatedAt: now,
    };
    setFavoriteBusy(true);
    try {
      setSnapshot(await window.dbStudio.queryHistory.saveFavorite(value));
      setFavoriteSource(null);
      message.success("查询已收藏。");
    } catch {
      message.error("查询收藏保存失败。");
    } finally {
      setFavoriteBusy(false);
    }
  }

  async function removeFavorite(id: string) {
    try {
      setSnapshot(await window.dbStudio.queryHistory.removeFavorite(id));
    } catch {
      message.error("无法移除查询收藏。");
    }
  }

  async function clearHistory() {
    try {
      setSnapshot(await window.dbStudio.queryHistory.clear(filter === "all" ? undefined : filter));
      message.success(filter === "all" ? "查询历史已清空。" : "该连接的查询历史已清空。");
    } catch {
      message.error("无法清理查询历史。");
    }
  }

  function restore(source: QueryTextSource) {
    onRestore(source);
    onClose();
  }

  const historyContent = <div className="query-history-tab-content">
      <span>{history.length} 条记录</span>
      <Popconfirm
        title={filter === "all" ? "清空全部查询历史？" : "清空该连接的查询历史？"}
        description="收藏的查询不会受影响。"
        okText="清空"
        cancelText="取消"
        onConfirm={() => void clearHistory()}
      >
        <Button size="small" type="text" icon={<Trash2 size={13} />} disabled={!snapshot.history.length}>清空</Button>
      </Popconfirm>
    </div>
    <List
      className="query-history-list"
      loading={loading}
      dataSource={history}
      locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有查询记录" /> }}
      renderItem={(entry: QueryExecutionRecord) => <List.Item
        key={entry.id}
        actions={[
          <Button key="restore" size="small" type="text" icon={<ArrowDownToLine size={13} />} onClick={() => restore(entry)}>载入</Button>,
          <Button key="favorite" size="small" type="text" icon={<Star size={13} />} onClick={() => beginFavorite(entry)}>收藏</Button>,
        ]}
      >
        <div className="query-history-item">
          <div className="query-history-item-head">
            <Space size={6} wrap>
              <Tag icon={<Database size={11} />}>{entry.connectionName}</Tag>
              <Tag color={entry.outcome === "success" ? "success" : "error"}>{entry.outcome === "success" ? "成功" : "失败"}</Tag>
              {entry.command && <Tag>{entry.command}</Tag>}
            </Space>
            <span>{formatTime(entry.executedAt)} · {entry.durationMs} ms{entry.rowCount === undefined ? "" : ` · ${entry.rowCount} 行`}</span>
          </div>
          <pre className="query-history-sql">{entry.sql}</pre>
        </div>
      </List.Item>}
    />
  </div>;

  const favoritesContent = <div className="query-history-tab-content">
    <div className="query-history-tab-heading"><span>{favorites.length} 个收藏</span><span>载入只会替换编辑器内容，不会执行 SQL。</span></div>
    <List
      className="query-history-list"
      loading={loading}
      dataSource={favorites}
      locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有收藏的查询" /> }}
      renderItem={(entry: QueryFavorite) => <List.Item
        key={entry.id}
        actions={[
          <Button key="restore" size="small" type="text" icon={<ArrowDownToLine size={13} />} onClick={() => restore(entry)}>载入</Button>,
          <Popconfirm key="remove" title="移除这个收藏？" okText="移除" cancelText="取消" onConfirm={() => void removeFavorite(entry.id)}>
            <Button size="small" type="text" danger icon={<Trash2 size={13} />}>移除</Button>
          </Popconfirm>,
        ]}
      >
        <div className="query-history-item">
          <div className="query-history-item-head">
            <Typography.Text strong className="query-history-favorite-title">{entry.title}</Typography.Text>
            <span>{entry.connectionName} · {formatTime(entry.updatedAt)}</span>
          </div>
          <pre className="query-history-sql">{entry.sql}</pre>
        </div>
      </List.Item>}
    />
  </div>;

  return <>
    <Drawer
      className="query-history-drawer"
      open={open}
      onClose={onClose}
      styles={{ wrapper: { width: 560 } }}
      destroyOnHidden
      title={<div className="query-history-title"><span><HistoryIcon size={16} /></span><div><b>查询历史与收藏</b><small>本机加密保存 · 最近 80 条 · 不保存查询结果</small></div></div>}
