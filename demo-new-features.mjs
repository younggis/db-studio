#!/usr/bin/env node
/**
 * 演示 DB Studio 新功能：
 * 1. QueryExecutionMetrics - 查询执行时间和统计
 * 2. WKB Geometry 解析 - 矢量字段解析为 GeoJSON
 * 3. 结果复制格式化 - 多种格式导出选中数据
 */

import { DatabaseSync } from 'node:sqlite';
import {
  parseWkbToGeojson,
  batchParseWkb,
  formatSelectionAsCsv,
  formatSelectionAsJson,
  formatSelectionAsInsert,
  calculateSelectionStats,
} from './packages/shared/dist/index.js';

console.log('='.repeat(80));
console.log('DB Studio 新功能演示');
console.log('='.repeat(80));
console.log('');

// ============================================================================
// 功能 1: 查询执行时间统计
// ============================================================================
console.log('【功能 1】查询执行时间统计 (QueryExecutionMetrics)');
console.log('-'.repeat(80));

const db = new DatabaseSync('.cache/demo-databases/demo.sqlite');

// 模拟带计时的查询
const startTime = new Date();
const rows = db.prepare('SELECT * FROM cities ORDER BY population DESC').all();
const endTime = new Date();
const duration = endTime.getTime() - startTime.getTime();

console.log(`查询: SELECT * FROM cities ORDER BY population DESC`);
console.log(`开始时间: ${startTime.toISOString()}`);
console.log(`结束时间: ${endTime.toISOString()}`);
console.log(`执行耗时: ${duration}ms`);
console.log(`返回行数: ${rows.length}`);
console.log(`查询状态: success`);
console.log('');
console.log('前 3 行结果:');
console.table(rows.slice(0, 3));
console.log('');

// ============================================================================
// 功能 2: WKB Geometry 解析
// ============================================================================
console.log('【功能 2】WKB Geometry 矢量字段解析');
console.log('-'.repeat(80));

// 测试数据：WKB 编码的 Point(116.4, 39.9) - 北京坐标
const wkbPoint = Buffer.from('0101000000333333333333f35c40333333333333e34340', 'hex');
const result1 = parseWkbToGeojson(wkbPoint);

console.log('WKB 十六进制:', wkbPoint.toString('hex'));
console.log('解析结果:');
console.log('  几何类型:', result1.geometryType);
console.log('  坐标维度:', result1.coordinateDimension);
console.log('  SRID:', result1.srid);
console.log('  GeoJSON:');
console.log(JSON.stringify(result1.geojson, null, 2));
console.log('');

// 测试 EWKB (PostGIS 扩展格式，带 SRID=4326)
const ewkbPoint = Buffer.from('0101000020e6100000333333333333f35c40333333333333e34340', 'hex');
const result2 = parseWkbToGeojson(ewkbPoint);

console.log('EWKB 十六进制:', ewkbPoint.toString('hex'));
console.log('解析结果:');
console.log('  几何类型:', result2.geometryType);
console.log('  坐标维度:', result2.coordinateDimension);
console.log('  SRID:', result2.srid, '(WGS84)');
console.log('  GeoJSON:');
console.log(JSON.stringify(result2.geojson, null, 2));
console.log('');

// 批量解析
const wkbs = [
  wkbPoint,
  ewkbPoint,
  Buffer.from('010200000003000000000000000000000000000000000000000000000000001040000000000000104000000000000014400000000000001440', 'hex'), // LineString
];

console.log('批量解析 3 个几何对象:');
const batchResults = batchParseWkb(wkbs, 10);
batchResults.forEach((r, i) => {
  if (r) {
    console.log(`  [${i}] ${r.geometryType} - ${r.coordinateDimension}D - SRID: ${r.srid || 'null'}`);
  } else {
    console.log(`  [${i}] null`);
  }
});
console.log('');

// ============================================================================
// 功能 3: 结果复制格式化
// ============================================================================
console.log('【功能 3】查询结果复制格式化');
console.log('-'.repeat(80));

const sampleData = [
  { id: 1, name: '北京', population: 21540000, area_km2: 16410 },
  { id: 2, name: '上海', population: 24280000, area_km2: 6340 },
  { id: 3, name: '广州', population: 15300000, area_km2: 7434 },
];

console.log('原始数据:');
console.table(sampleData);
console.log('');

// CSV 格式
console.log('CSV 格式（包含表头）:');
const csvOutput = formatSelectionAsCsv(
  sampleData.map(r => [r.id, r.name, r.population, r.area_km2]),
  true,
  ['id', 'name', 'population', 'area_km2']
);
console.log(csvOutput);
console.log('');

// JSON 格式
console.log('JSON 格式:');
const jsonOutput = formatSelectionAsJson(
  sampleData.map(r => [r.id, r.name, r.population, r.area_km2]),
  ['id', 'name', 'population', 'area_km2'],
  true
);
console.log(jsonOutput);
console.log('');

// INSERT 语句
console.log('SQL INSERT 格式:');
const insertOutput = formatSelectionAsInsert(
  sampleData.map(r => [r.id, r.name, r.population, r.area_km2]),
  ['id', 'name', 'population', 'area_km2'],
  'cities',
  'public'
);
console.log(insertOutput);
console.log('');

// 选择统计
const stats = calculateSelectionStats(sampleData.map(r => [r.id, r.name, r.population, r.area_km2]));
console.log('选择统计:');
console.log('  行数:', stats.rows);
console.log('  列数:', stats.columns);
console.log('  单元格数:', stats.cells);
console.log('  估计大小:', Math.round(stats.estimatedBytes / 1024), 'KB');
console.log('');

db.close();

console.log('='.repeat(80));
console.log('演示完成！');
console.log('');
console.log('在 DB Studio 桌面应用中测试这些功能:');
console.log('1. 执行任何 SQL 查询，查看底部的 QueryMetricsBar（执行时间、行数）');
console.log('2. 连接 PostGIS 数据库，查询含 geometry 列的表，查看矢量字段渲染');
console.log('3. 在查询结果中选择单元格，右键查看复制选项（纯文本/CSV/JSON/INSERT）');
console.log('='.repeat(80));