/**
 * Rebuilds ISO dimensional WKB from Oracle's 2D MAKE_2D WKB plus the original
 * SDO_UTIL.GETVERTICES ordinates. It refuses reordered or structurally different
 * vertex sequences instead of exporting incomplete coordinates.
 */
export declare function oracleSdo2dWkbToDimensionalWkb(wkb: Uint8Array, gtype: number, vertexJson: string | null | undefined): Buffer;
//# sourceMappingURL=oracle-gis-wkb.d.ts.map