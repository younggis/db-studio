import type { GisSpatialExtent } from "@db-studio/gis";

export interface GisExportForm {
  targetLayerName?: string;
  sourceCrs?: string;
  targetCrs?: string;
  coordinateOperation?: string;
  spatialFilter?: GisSpatialExtent;
  targetEncoding?: string;
  fieldMappings?: unknown[];
  datasetCreationOptions?: string[];
  layerCreationOptions?: string[];
}

export interface GisExportRequest {
  connectionId: string;
  table: string;
  output: string;
  operationId: string;
  form: GisExportForm;
}

export async function invokeGisExport(
  api: Window["dbStudio"]["gis"],
  request: GisExportRequest,
) {
  const { connectionId, table, output, operationId, form } = request;
  const result = await api.export(connectionId, table, output, {
    targetLayerName: form.targetLayerName,
    targetCrs: form.targetCrs,
    coordinateOperation: form.coordinateOperation,
    targetEncoding: form.targetEncoding,
    fieldMappings: form.fieldMappings as never,
    datasetCreationOptions: form.datasetCreationOptions,
    layerCreationOptions: form.layerCreationOptions,
  }, operationId);
  return result;
}

export function parseGisExportSpatialFilter(text: string): GisSpatialExtent {
  const parts = text.split(",").map((part) => Number(part.trim()));
  if (parts.length !== 4 || parts.some((value) => !Number.isFinite(value))) {
    throw new Error("范围过滤必须是四个数字：minX,minY,maxX,maxY");
  }
  const [minX, minY, maxX, maxY] = parts as [number, number, number, number];
  if (minX >= maxX || minY >= maxY) throw new Error("范围过滤的最小值必须小于最大值");
  return { minX, minY, maxX, maxY };
}
