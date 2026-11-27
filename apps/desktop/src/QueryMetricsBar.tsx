import { CheckCircle, Clock, XCircle, Table } from 'lucide-react';
import type { QueryExecutionMetrics } from '@db-studio/shared';

interface QueryMetricsBarProps {
  metrics: QueryExecutionMetrics;
}

/**
 * Query execution metrics bar component
 *
 * Displays:
 * - Execution status (success/error)
 * - Execution duration
 * - Row count
 * - Affected rows (for DML statements)
 * - Execution timestamp
 * - Error message (if failed)
 */
export default function QueryMetricsBar({ metrics }: QueryMetricsBarProps) {
  const durationFormatted = formatDuration(metrics.duration);
  const timeFormatted = formatTime(metrics.endTime);

  return (
    <div
      className="query-metrics-bar"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        padding: '6px 12px',
        background: metrics.status === 'success' ? '#f6ffed' : '#fff2e8',
        borderBottom: `1px solid ${metrics.status === 'success' ? '#b7eb8f' : '#ffbb96'}`,
        fontSize: 13,
      }}
    >
      {/* Status */}
      <div className="metric-status" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        {metrics.status === 'success' ? (
          <>
            <CheckCircle size={16} style={{ color: '#52c41a' }} />
            <span style={{ color: '#52c41a', fontWeight: 500 }}>成功</span>
          </>
        ) : metrics.status === 'error' ? (
          <>
            <XCircle size={16} style={{ color: '#ff4d4f' }} />
            <span style={{ color: '#ff4d4f', fontWeight: 500 }}>失败</span>
          </>
        ) : (
          <>
            <XCircle size={16} style={{ color: '#faad14' }} />
            <span style={{ color: '#faad14', fontWeight: 500 }}>已取消</span>
          </>
        )}
      </div>

      <div style={{ width: 1, height: 16, background: '#d9d9d9' }} />

      {/* Duration */}
      <div className="metric-duration" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <Clock size={16} style={{ color: '#8c8c8c' }} />
        <span style={{ fontFamily: 'monospace', fontWeight: 500 }}>{durationFormatted}</span>
      </div>

      {/* Row count */}
      {typeof metrics.rowCount === 'number' && (
        <div className="metric-row-count" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <Table size={16} style={{ color: '#8c8c8c' }} />
          <span>
            {metrics.rowCount.toLocaleString('zh-CN')} 行
          </span>
        </div>
      )}

      {/* Affected rows (for DML statements) */}
      {metrics.affectedRows !== undefined && metrics.affectedRows !== metrics.rowCount && (
        <div className="metric-affected-rows" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <CheckCircle size={16} style={{ color: '#8c8c8c' }} />
          <span>
            {metrics.affectedRows.toLocaleString('zh-CN')} 行受影响
          </span>
        </div>
      )}

      {/* Timestamp */}
      <div
        className="metric-timestamp"
        style={{
          marginLeft: 'auto',
          color: '#8c8c8c',
          fontSize: 12,
        }}
      >
        {timeFormatted}
      </div>

      {/* Error message */}
      {metrics.errorMessage && (
        <div
          className="metric-error"
          style={{
            flex: 1,
            marginLeft: 16,
            padding: '4px 8px',
            background: '#fff',
            border: '1px solid #ffccc7',
            borderRadius: 4,
            color: '#ff4d4f',
            fontSize: 12,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={metrics.errorMessage}
        >
          ⚠️ {metrics.errorMessage}
        </div>
      )}
    </div>
  );
}

/**
 * Format duration in human-readable format
 */
function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  if (ms < 60000) {
    return `${(ms / 1000).toFixed(2)}s`;
  }
  const minutes = Math.floor(ms / 60000);
  const seconds = ((ms % 60000) / 1000).toFixed(2);
  return `${minutes}m ${seconds}s`;
}

/**
 * Format timestamp
 */
function formatTime(date: Date): string {
  const d = new Date(date);
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  const seconds = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${hours}:${minutes}:${seconds}.${ms}`;
}
