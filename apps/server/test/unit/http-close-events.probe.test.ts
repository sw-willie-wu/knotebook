/**
 * bulk transfer plan PR-2 T1 Step 1：S14 探針——**不是產品守衛**。PUT（有 body）上 `request.raw` 的 `close` 何時觸發，決定 T8 的
 * 斷線偵測只准掛 `reply.raw` 的 `close`（plan §0.1-11）。整檔 `describe.skipIf(!process.env.KN_PROBE)`：CI 的 `test:unit` 照收檔
 * 但不跑（避免「10 次不一致就紅」偶發）。序列寫進 `KN_PROBE_LOG`（UTF-8；沒給就只印 stdout）。
 *
 * 真 `Fastify()`（不用 `buildApp`）、頂層 `text/markdown` parser、`PUT /p` 與 `GET /g`；事件監聽掛在 onRequest（最早的點，
 * body 讀完前就掛上），handler 內 await 一個外部閘再回 200。四個情境 × keep-alive／非 keep-alive × 10 次。
 */
import { appendFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import Fastify, { type FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";

const LOG = process.env.KN_PROBE_LOG;
const out = (line: string) => {
  if (LOG) appendFileSync(LOG, line + "\n", "utf8");
  console.log(line);
};
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

describe.skipIf(!process.env.KN_PROBE)("S14 探針：HTTP close 事件的時序", () => {
  it("P1–P4 × keep-alive／非 keep-alive × 10 次：事件序列一致", async () => {
    const app = Fastify();
    app.addContentTypeParser("text/markdown", { parseAs: "buffer" }, (_r, body, done) => done(null, body));
    const events = new Map<string, string[]>();
    let gateOpen: () => void = () => {};
    let handlerStarted: () => void = () => {};
    const track = (req: FastifyRequest) => {
      const id = String(req.headers["x-probe"]);
      const ev: string[] = [];
      events.set(id, ev);
      req.raw.once("close", () => ev.push("req.close"));
      req.raw.once("aborted", () => ev.push("req.aborted"));
      req.raw.socket.once("close", () => ev.push("socket.close"));
      return ev;
    };
    app.addHook("onRequest", async (req, reply) => {
      const ev = track(req);
      reply.raw.once("close", () => ev.push("reply.close"));
    });
    const handler = async (req: FastifyRequest) => {
      const ev = events.get(String(req.headers["x-probe"]))!;
      ev.push("handler");
      const g = new Promise<void>(r => (gateOpen = r));
      handlerStarted();
      await g;
      ev.push("send");
      return "ok";
    };
    app.put("/p", handler);
    app.get("/g", handler);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as AddressInfo).port;

    type Mode = "keepalive" | "close";
    const run = async (scenario: string, mode: Mode, i: number): Promise<string> => {
      const id = `${scenario}-${mode}-${i}`;
      const agent = new http.Agent({ keepAlive: mode === "keepalive", maxSockets: 1 });
      const started = new Promise<void>(r => (handlerStarted = r));
      const isGet = scenario.startsWith("P4");
      const body = "x".repeat(2048);
      const req = http.request({
        host: "127.0.0.1",
        port,
        method: isGet ? "GET" : "PUT",
        path: isGet ? "/g" : "/p",
        agent,
        headers: isGet
          ? { "x-probe": id }
          : { "x-probe": id, "content-type": "text/markdown", "content-length": String(scenario === "P3" ? body.length * 2 : body.length) },
      });
      req.on("error", () => {});
      const done = new Promise<void>(r => {
        req.on("response", res => {
          res.resume();
          res.on("end", () => r());
          res.on("close", () => r());
        });
        req.on("close", () => r());
      });
      if (!isGet) req.write(body);
      if (scenario !== "P3") req.end();
      if (scenario === "P1" || scenario === "P4-wait") {
        await started;
        await sleep(30);
        gateOpen();
        await done;
      } else if (scenario === "P2" || scenario === "P4-destroy") {
        await started;
        await sleep(30);
        req.destroy();
        await sleep(30);
        gateOpen();
      } else {
        // P3：body 只送一半就斷——handler 進不來
        await sleep(30);
        req.destroy();
      }
      await sleep(60);
      agent.destroy();
      await sleep(20);
      return (events.get(id) ?? ["(no onRequest)"]).join(" → ");
    };

    const results: Record<string, string[]> = {};
    for (const scenario of ["P1", "P2", "P3", "P4-wait", "P4-destroy"]) {
      for (const mode of ["keepalive", "close"] as const) {
        const seqs: string[] = [];
        for (let i = 0; i < 10; i++) seqs.push(await run(scenario, mode, i));
        results[`${scenario}/${mode}`] = seqs;
      }
    }
    await app.close();
    out(`== node ${process.version} ${process.platform}`);
    for (const [k, seqs] of Object.entries(results)) out(`${k}: ${[...new Set(seqs)].join(" ｜ ")}${new Set(seqs).size > 1 ? `  (不一致：${seqs.length} 次)` : ""}`);
    for (const [k, seqs] of Object.entries(results)) expect(new Set(seqs).size, `${k}: ${seqs.join(" ｜ ")}`).toBe(1);
  }, 120_000);
});
