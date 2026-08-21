import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/admin": "http://127.0.0.1:54101",
      "/oidc": "http://127.0.0.1:54101",
      "/identity": {
        target: "http://127.0.0.1:54180",
        rewrite: (path) => path.replace(/^\/identity/, ""),
      },
    },
  },
});
