function geometrySignature(geometry) {
    if (!geometry || typeof geometry !== "object")
        return undefined;
    const record = geometry;
    if (typeof record.type !== "string")
        return undefined;
    const coordinates = record.coordinates;
    let dimension = "XY";
    const scan = (value) => {
        if (!Array.isArray(value) || value.length < 3)
            return;
        if (typeof value[0] === "number" && typeof value[1] === "number" && typeof value[2] === "number") {
            if (value.length >= 4)
                dimension = "XYZM";
            else
                dimension = "XYZ";
            return;
        }
        for (const child of value)
            scan(child);
    };
    scan(coordinates);
    return { type: record.type.toUpperCase(), dimension };
}
export function summarizeLayerHealth(input) {
    const { info, layer, preview, validation } = input;
    const counts = new Map();
    const dimensions = new Set();
    for (const feature of preview.features ?? []) {
        const signature = geometrySignature(feature.geometry);
        if (!signature)
            continue;
        counts.set(signature.type, (counts.get(signature.type) ?? 0) + 1);
        dimensions.add(signature.dimension);
    }
    const geometryTypes = [...counts.entries()]
        .map(([type, count]) => ({ type, count }))
        .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
    const encoding = preview.encoding ?? info.encoding;
    const warnings = [...(info.warnings ?? []), ...(preview.warnings ?? []), ...(validation.warnings ?? [])];
    const invalidGeometryCount = validation.issueCount;
    const canMakeValid = invalidGeometryCount > 0;
    const report = {
        file: info.path,
        format: info.format,
        driver: info.driver,
        layer: layer.name,
        crs: layer.crs ?? null,
        featureCount: layer.featureCount ?? preview.featureCount ?? validation.featureCount,
        fieldCount: layer.fields.length,
        geometryTypes,
        dimensions: [...dimensions].sort(),
        invalidGeometryCount,
        issuesTruncated: validation.issuesTruncated,
        encoding: {
            source: encoding.source,
            declared: encoding.declaredEncoding ?? null,
            detected: encoding.detectedEncoding ?? null,
            confidence: encoding.confidence ?? null,
            requiresUserChoice: preview.requiresUserChoice,
        },
        warnings,
        canMakeValid,
        makeValidHint: canMakeValid
            ? "可在导入时启用“导入前修复无效几何（GDAL MakeValid）”；修复可能改变几何类型或使要素变空。"
            : undefined,
    };
    if (encoding.source === "heuristic" || preview.requiresUserChoice) {
        report.warnings = [...report.warnings, "编码为候选推断，请在导入前确认中文属性预览。"];
    }
    return report;
}
//# sourceMappingURL=layer-health.js.map