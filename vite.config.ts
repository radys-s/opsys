import { defineConfig } from 'vite';

/**
 * Jedna konfigurace pro obě vývojové smyčky:
 *   npm run dev        → samotný frontend v prohlížeči proti mock datům
 *   npm run tauri dev  → tentýž frontend uvnitř Tauri okna
 *
 * Port je pevný, protože se na něj odkazuje `src-tauri/tauri.conf.json`.
 * `fs.allow` je tu kvůli složce `profiles/`, která leží mimo `src/` a načítá
 * se přes `import.meta.glob(..., { query: '?raw' })`.
 */
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: '127.0.0.1',
    fs: {
      allow: ['.'],
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'esnext',
    sourcemap: true,
  },
});
