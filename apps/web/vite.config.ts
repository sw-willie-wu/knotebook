import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vitest/config";

// #247 §9.7：關於頁的版本號。讀 apps/web/package.json 的 version（release 流程本來就會改它），
// 以 define 注入成編譯期常數；vitest 走同一份設定，測試環境同樣有定義。型別宣告在 src/vite-env.d.ts。
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

// 單一設定檔同時餵 `vite`/`vite build`（app）與 `vitest`（test runner）——
// `vitest/config` 的 defineConfig 型別是 Vite 的超集，多了 `test` 欄位。
export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  build: {
    rollupOptions: {
      output: {
        // 動態 import 的 chunk，Rollup 預設以**來源檔名**命名——套件入口常叫
        // index.mjs（shiki 就是），會產出第二個 index-<hash>.js，撞上 entry 的命名
        // 空間，`scripts/check-bundle-size.mjs` 的「恰一個 entry」fail-closed 直接把
        // build 判死（issue #96 實際發生過）。凡是非 entry 而名為 "index" 的 chunk，
        // 一律改用它所屬套件的名字（從 pnpm 路徑抽出、去掉 @ 與 + 符號）。
        chunkFileNames(chunkInfo) {
          if (chunkInfo.name === "index") {
            const pkg = chunkInfo.facadeModuleId
              ?.match(/\.pnpm\/(.+?)@\d/)?.[1]
              ?.replace(/[@+]/g, "");
            return `assets/${pkg ?? "chunk"}-[hash].js`;
          }
          return "assets/[name]-[hash].js";
        },
      },
    },
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    proxy: {
      "/api": "http://localhost:3000",
      "/collab": { target: "ws://localhost:3000", ws: true },
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    css: true,
    // 單案上限要遠大於 test/setup.ts 的 asyncUtilTimeout（10s；放寬理由與實測數字見該檔），
    // 否則一案內兩次慢等待就會先撞 vitest 逾時、看不到是哪個查詢等不到
    testTimeout: 30_000,
  },
});
