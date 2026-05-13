import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // Relative base so Tauri's WebView resolves assets correctly in installed builds.
  // Without this Vite emits absolute paths (/assets/...) which fail in the
  // production WebView context; "./assets/..." works from any protocol origin.
  base: './',
  server: {
    port: 5174,
    strictPort: true,
  },
  clearScreen: false,
  envPrefix: ['VITE_', 'TAURI_'],
})
