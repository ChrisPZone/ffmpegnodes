import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri expects a fixed dev port and must not watch the Rust side.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  // the lazily loaded filter docs (src/docs/filterDocs.json) are one ~1 MB chunk on purpose
  build: { chunkSizeWarningLimit: 1100 },
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
} as any);
