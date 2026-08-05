import type { FastifyReply } from "fastify";
import { SESSION_COOKIE } from "@knotebook/shared";
import type { AppConfig } from "../config.js";
import { SESSION_TTL_SECONDS } from "./session.js";

/**
 * 簽發 session cookie 的唯一入口。所有需要「登入成功後發 cookie」的路由（Task 8
 * setup、Task 9 login，以及之後任何簽發 session 的地方）都必須呼叫這個 helper，
 * 不要各自 `reply.setCookie(...)`——五個屬性（httpOnly/sameSite/secure/path/maxAge）
 * 與 maxAge 秒數（`SESSION_TTL_SECONDS`，跟 `session.ts` 簽發 JWT 的 exp 用同一個
 * 常數）只有這一處定義；以後要調整 cookie 屬性或 session 有效期只需要改一個地方，
 * 不會有兩處各自維護、悄悄漂移不同步的風險。
 */
export function setSessionCookie(reply: FastifyReply, config: AppConfig, jwt: string): void {
  reply.setCookie(SESSION_COOKIE, jwt, {
    httpOnly: true,
    sameSite: "lax",
    secure: config.cookieSecure,
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
}
