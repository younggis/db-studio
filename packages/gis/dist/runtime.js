import { existsSync } from "node:fs";
import path from "node:path";
import { delimiter } from "node:path";
const GDAL_DATA_MARKERS = ["gdalvrt.xsd", "gcs.csv", "pcs.csv"];
/** Adds sibling GDAL/PROJ data paths without changing the caller's environment. */
export function resolveGdalRuntimeEnvironment(source) {
    const environment = { ...source };
    const candidates = [environment.DBSTUDIO_GDAL_BIN, ...(environment.PATH ?? "").split(delimiter)]
        .filter((directory) => Boolean(directory))
        .map((directory) => path.resolve(directory));
    const binaryDirectory = candidates.find((directory) => ["ogr2ogr.exe", "ogr2ogr"].some((name) => existsSync(path.join(directory, name))));
    if (!binaryDirectory)
        return environment;
    const runtimeRoot = path.resolve(binaryDirectory, "..");
    if (!environment.GDAL_DATA) {
        const dataCandidates = [
            path.join(runtimeRoot, "data"),
            path.join(runtimeRoot, "share", "gdal"),
            path.join(runtimeRoot, "apps", "gdal", "share", "gdal"),
            path.join(runtimeRoot, "apps", "gdal", "share"),
        ];
        const gdalData = dataCandidates.find((directory) => GDAL_DATA_MARKERS.some((marker) => existsSync(path.join(directory, marker))));
        if (gdalData)
            environment.GDAL_DATA = gdalData;
    }
    const projCandidates = [
        path.join(runtimeRoot, "proj"),
        path.join(runtimeRoot, "share", "proj"),
        path.join(runtimeRoot, "apps", "proj", "share", "proj"),
        path.join(runtimeRoot, "apps", "gdal", "share", "proj"),
        path.join(runtimeRoot, "share"),
    ];
    const projData = environment.PROJ_DATA || environment.PROJ_LIB || projCandidates.find((directory) => existsSync(path.join(directory, "proj.db")));
    if (projData) {
        if (!environment.PROJ_DATA)
            environment.PROJ_DATA = projData;
        if (!environment.PROJ_LIB)
            environment.PROJ_LIB = projData;
    }
    return environment;
}
//# sourceMappingURL=runtime.js.map