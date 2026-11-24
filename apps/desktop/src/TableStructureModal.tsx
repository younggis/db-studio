// Reconstructed from vendor chunk TableStructureModal-BTMtSTCl.js.
import { Alert, Modal, Spin, Tag, Typography } from "antd";
import { Database } from "lucide-react";
import type { ColumnInfo, TableInfo } from "@db-studio/shared";
import LazyDataTable from "./LazyDataTable";

const { Text } = Typography;

interface TableStructureModalProps {
  table: TableInfo;
  columns: ColumnInfo[];
  loading: boolean;
  error?: string;
  onClose: () => void;
}

export default function TableStructureModal({ table, columns, loading, error, onClose }: TableStructureModalProps) {
  return (
    <Modal
      title={
        <div className="modal-title">
          <div className="modal-icon"><Database size={17} /></div>
          <div>
            <b>表结构</b>
            <span>{`${table.schema}.${table.name} · ${table.type === "view" ? "视图" : "数据表"}`}</span>
          </div>
        </div>
      }
      open
      onCancel={onClose}
      footer={null}
      width={820}
      destroyOnHidden
    >
      {error
        ? <Alert showIcon type="error" message="读取表结构失败" description={error} />
        : <LazyDataTable
            size="small"
            rowKey="name"
            pagination={false}
            loading={loading}
            dataSource={columns}
            columns={[
              { title: "序号", dataIndex: "ordinalPosition", width: 60 },
              { title: "字段名", dataIndex: "name", width: 180, ellipsis: true, render: (value: string) => <Text code>{value}</Text> },
              { title: "数据类型", dataIndex: "dataType", width: 150, ellipsis: true },
              { title: "可空", dataIndex: "nullable", width: 70, render: (value: boolean) => value ? <Tag>是</Tag> : <Tag color="blue">否</Tag> },
              { title: "主键", dataIndex: "primaryKey", width: 80, render: (value: boolean) => value ? <Tag color="gold">主键</Tag> : <Text type="secondary">—</Text> },
              { title: "默认值", dataIndex: "defaultValue", ellipsis: true, render: (value: string | null) => value === null ? <Text type="secondary">—</Text> : <Text code>{value}</Text> },
            ]}
          />}
    </Modal>
  );
}
