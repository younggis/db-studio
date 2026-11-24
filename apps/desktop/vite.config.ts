import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Phase 0 fallback: the preserved production chunks embed their own React.
// Reconstructed TSX must use that same instance, so npm React entry points are
// aliased to bridges over the vendor chunk. Remove these aliases once every
// vendor chunk has been replaced with real source.
const workspaceRoot = path.dirname(fileURLToPath(import.meta.url));
const compat = (name: string) => path.resolve(workspaceRoot, "src", name);

export default defineConfig({
  plugins: [react()],
  base: "./",
  server: { strictPort: true },
  resolve: {
    alias: [
      { find: /^react\/jsx-runtime$/, replacement: compat("jsx-runtime-compat.ts") },
      { find: /^react\/jsx-dev-runtime$/, replacement: compat("jsx-runtime-compat.ts") },
      { find: /^react-dom\/client$/, replacement: compat("react-dom-compat.ts") },
      { find: /^react-dom$/, replacement: compat("react-dom-compat.ts") },
      { find: /^react$/, replacement: compat("react-compat.ts") },
    ],
  },
  build: { outDir: "dist/renderer", emptyOutDir: true },
});
