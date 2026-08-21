import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

// The React Router plugin injects a runtime preamble that a component test has no framework to
// provide, so tests build with plain esbuild JSX instead.
const isTest = !!process.env.VITEST;

export default defineConfig({
  plugins: isTest ? [tailwindcss()] : [tailwindcss(), reactRouter()],
  test: {
    include: ["tests/**/*.test.{ts,tsx}"],
    // Component tests render for real: a render-time ReferenceError has nothing else catching it.
    environment: "jsdom",
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
