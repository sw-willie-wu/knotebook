/**
 * #398：正式 build 產物（`tsc -p tsconfig.json`，同 Dockerfile 的 `pnpm -r build`）裡有 worker 進入點，而且不靠 tsx 就能開 worker 解析。
 * 把 server 編到 `node_modules/.cache/` 底下（模組解析往上找得到 apps/server/node_modules），再用沒有任何 loader 的 `node` 子程序
 * 載入編出來的 `createEditingRuntime`、解析一筆、印出結果。正式 image 只有 `dist/`（`pnpm deploy --prod`，沒有 tsx）。
 * 子程序跑的是一個 `.mjs` 檔，不用 `node -e`：worker 預設繼承主程序的 `execArgv`，`-e` 會讓 worker 也去跑那段字串。
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cacheDir = path.join(serverDir, "node_modules", ".cache");
const outDir = (() => {
  execFileSync(process.execPath, ["-e", `require("node:fs").mkdirSync(${JSON.stringify(cacheDir)}, { recursive: true })`]);
  return mkdtempSync(path.join(cacheDir, "parse-dist-"));
})();
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe("正式 build 走 worker", () => {
  it("編出 dist/notes/editing/parse-worker.js；不帶 loader 的 node 用 createEditingRuntime 解析成功、pool 開過 worker", () => {
    const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
    execFileSync(process.execPath, [tsc, "-p", path.join(serverDir, "tsconfig.json"), "--outDir", outDir], { stdio: "pipe" });
    expect(existsSync(path.join(outDir, "notes/editing/parse-worker.js"))).toBe(true);
    const url = (p: string) => JSON.stringify(pathToFileURL(path.join(outDir, p)).href);
    const script = `
      const { loadConfig } = await import(${url("config.js")});
      const { createEditingRuntime } = await import(${url("notes/editing/runtime.js")});
      const config = loadConfig({ DATABASE_URL: "postgres://u:p@localhost:5432/db", APP_SECRET: "a".repeat(64), PUBLIC_URL: "http://localhost:3000", PARSE_WORKERS: "1" });
      const rt = createEditingRuntime(config);
      const r = await rt.parser.parse({ owner: "u", markdown: "# t\\n\\nhello **b**", candidates: [], siteOrigin: "http://localhost:3000" });
      console.log(JSON.stringify({ pool: rt.parser.constructor.name, spawned: rt.parser.stats().spawned, types: r.blocks.map(b => b.type) }));
      await rt.close();
    `;
    const file = path.join(outDir, "run-check.mjs");
    writeFileSync(file, script, "utf8");
    const out = execFileSync(process.execPath, [file], { cwd: serverDir, encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "" } });
    expect(JSON.parse(out.trim().split("\n").pop()!)).toEqual({ pool: "ParsePool", spawned: 1, types: ["heading", "paragraph"] });
  }, 180_000);
});
