import { defineConfig } from "vite";
import preact from "@preact/preset-vite";

export default defineConfig({
  plugins: [preact()],
  root: "src/client",
  publicDir: "public",
  build: {
    outDir: "../../dist/client",
  },
  server: {
    proxy: {
      "/ws": {
        target: "ws://localhost:3000",
        ws: true,
      },
    },
  },
});
