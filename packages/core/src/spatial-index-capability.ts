// Phase 4.4: documented capability matrix for spatial index creation.
// The import paths in this repo already implement the combinations marked
// true; recording them explicitly prevents silent regressions and gives the UI
// a single source of truth for which modes may offer the option.
import type { DatabaseEngine } from "@db-studio/shared";

export interface SpatialIndexCapability {
  create: boolean;
  append: boolean;
  overwrite: boolean;
  notes: string[];
}

const MATRIX: Record<string, SpatialIndexCapability> = {
  postgres: { create: true, append: true, overwrite: true, notes: ["GiST 索引；PostGIS 存在时由 OGR 驱动建立。"] },
  sqlite: { create: true, append: false, overwrite: false, notes: ["SpatiaLite RTree / GeoPackage RTree 扩展；普通 SQLite 需先初始化元数据。"] },
  mysql: { create: true, append: true, overwrite: true, notes: ["SPATIAL INDEX；需正 SRID 且全部几何非空；MariaDB 另需 SRID CHECK 约束。"] },
  mariadb: { create: true, append: true, overwrite: true, notes: ["同 MySQL，附 REF_SYSTEM_ID 与 CHECK (ST_SRID(geom)=n)。"] },
  sqlserver: { create: true, append: true, overwrite: true, notes: ["geometry/geography 索引；需把暂存要素 ID 提升为聚集主键。"] },
  oracle: { create: true, append: true, overwrite: true, notes: ["USER_SDO_GEOM_METADATA + MDSYS.SPATIAL_INDEX；append 需 SRID/范围匹配且源范围在登记范围内。"] },
  mongodb: { create: false, append: false, overwrite: false, notes: ["使用 2dsphere 索引，由 MongoDocumentService 管理，不走 GIS 导入选项。"] },
};

export function spatialIndexCapability(engine: DatabaseEngine): SpatialIndexCapability {
  return { ...(MATRIX[engine] ?? { create: false, append: false, overwrite: false, notes: ["未知引擎，未提供空间索引能力。"] }) };
}

export function assertSpatialIndexSupported(engine: DatabaseEngine, mode: "create" | "append" | "overwrite"): void {
  const capability = spatialIndexCapability(engine);
  if (!capability[mode]) {
    throw new Error(`${engine} 不支持 ${mode} 模式的空间索引：${capability.notes.join(" ")}`);
  }
}
