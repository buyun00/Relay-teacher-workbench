import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ command }) => ({
  plugins: [
    react(),
    {
      name: "development-csp",
      transformIndexHtml(html) {
        return command === "serve"
          ? html.replace(
              "script-src 'self';",
              "script-src 'self' 'unsafe-inline';",
            )
          : html;
      },
    },
  ],
  base: "./",
  server: { port: 5178, strictPort: true },
  build: { target: "es2022" },
}));
