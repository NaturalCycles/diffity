import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [tailwindcss(), reactRouter()],
  test: {
    include: ["tests/**/*.test.{ts,tsx}"],
  },
  server: {
    proxy: {
      "/api": {
        target: "http://localhost:5391",
        changeOrigin: true,
      },
    },
  },
  build: {
    chunkSizeWarningLimit: 1000,
    emptyOutDir: true,
  },
});
