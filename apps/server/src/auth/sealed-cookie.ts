import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

// #187：短效 cookie 的 AES-256-GCM 封章（state cookie `:oidc-state`、pending-link cookie `:oidc-pending-link`）。格式與 Plan 5 的
// `sealOidcState` 逐位元組相同：`base64url(iv).base64url(ct).base64url(tag)`，金鑰 sha256(`<APP_SECRET>:<namespace>`)。
// 只管加解密與 JSON；欄位驗證由各用途自己做（拿到的是 unknown）。

function deriveKey(appSecret: string, namespace: string): Buffer {
  return createHash("sha256").update(`${appSecret}:${namespace}`).digest();
}

export function sealCookieJson(appSecret: string, namespace: string, value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(appSecret, namespace), iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return `${iv.toString("base64url")}.${ct.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}`;
}

/** 格式不對、密文被竄改、金鑰／namespace 不符、JSON 壞 → null（不 throw）。 */
export function unsealCookieJson(appSecret: string, namespace: string, sealed: string): unknown {
  const parts = sealed.split(".");
  if (parts.length !== 3) return null;
  const [ivPart, ctPart, tagPart] = parts;
  if (!ivPart || !ctPart || !tagPart) return null;
  let plaintext: string;
  try {
    const decipher = createDecipheriv("aes-256-gcm", deriveKey(appSecret, namespace), Buffer.from(ivPart, "base64url"));
    decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
    plaintext = Buffer.concat([decipher.update(Buffer.from(ctPart, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
  try {
    return JSON.parse(plaintext) as unknown;
  } catch {
    return null;
  }
}
