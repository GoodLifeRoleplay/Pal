import { defineConfig } from "vite";

// minimal, stable config for Tauri v1 dev at http://localhost:1420
export default defineConfig({
  server: { port: 1420, strictPort: true },
  build: {
    // keep build simple; we only need SPA entry
    rollupOptions: { input: "index.html" }
  }
});
