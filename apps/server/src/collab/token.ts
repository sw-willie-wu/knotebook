import { createHash } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { COLLAB_TOKEN_TTL_SECONDS, type CollabTokenClaims, type Role } from "@knotebook/shared";

// jose 的 duration 字串只認 "<數字><單位>"（s/m/h/d/w/y）——比照 `auth/session.ts` 的
// SESSION_TTL 模式，直接由 shared 那個以秒為單位的常數算出，不在這裡另寫一份字面量。
const COLLAB_TOKEN_TTL = `${COLLAB_TOKEN_TTL_SECONDS}s`;

const ROLES: readonly Role[] = ["owner", "editor", "viewer", "none"];

function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

// 與 `auth/session.ts` 的 `sessionKey` 平行衍生（同一個 sha256(appSecret + ":<用途>")
// 模式），但用 `:collab` 而非 `:session`——兩把鍵刻意不同，session token 與 collab
// token 互不能驗證對方（見 unit test「:session 鍵簽的用 :collab 驗必 null」）。
function collabKey(secret: string): Uint8Array {
  return createHash("sha256").update(`${secret}:collab`).digest();
}

/**
 * 簽發 collab token：claims 含 noteId/role/tv，供 Hocuspocus `onAuthenticate`
 * （Task 5）與之後的 `onTokenSync` 重驗權限用。**`role:'none'` 也可以簽**——
 * `POST /api/notes/:id/collab-token` 對無權限的使用者一律回 200 + 這種 token
 * （spec §5/§8-2 的關鍵契約，見 `routes/notes.ts`），不是簽發失敗。
 */
export async function signCollabToken(appSecret: string, claims: CollabTokenClaims): Promise<string> {
  const key = collabKey(appSecret);
  return new SignJWT({ noteId: claims.noteId, role: claims.role, tv: claims.tv })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.userId)
    .setIssuedAt()
    .setExpirationTime(COLLAB_TOKEN_TTL)
    .sign(key);
}

/** 驗證失敗（篡改／過期／格式錯誤／錯誤鍵簽發）一律回 null，不 throw——比照 `verifySession`。 */
export async function verifyCollabToken(appSecret: string, token: string): Promise<CollabTokenClaims | null> {
  try {
    const key = collabKey(appSecret);
    const { payload } = await jwtVerify(token, key, { algorithms: ["HS256"] });
    if (typeof payload.sub !== "string") return null;
    if (typeof payload.noteId !== "string") return null;
    if (typeof payload.tv !== "number") return null;
    if (!isRole(payload.role)) return null;
    return { userId: payload.sub, noteId: payload.noteId, role: payload.role, tv: payload.tv };
  } catch {
    return null;
  }
}
