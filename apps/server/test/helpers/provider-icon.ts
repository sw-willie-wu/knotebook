import { eq } from "drizzle-orm";
import { expect } from "vitest";
import type { ProviderIconDto } from "@knotebook/shared";
import type { Db } from "../../src/db/index.js";
import { authProviders } from "../../src/db/schema.js";
import { seedAuthProvider } from "./oidc-provider.js";

/** 嵌在測試圖檔裡的可辨識字串：任何清單回應出現它＝圖檔本體出線（spec §5.3、§8.1 S7）。 */
export const ICON_MARKER = "KNB-ICON-MARKER";

/** PNG 簽章＋標記＋填充，總長 `size`（server 只看檔頭、不解碼）。`size` 至少 8＋標記長。 */
export function pngBytes(size = 64): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const body = Buffer.alloc(size - sig.length, 0x20);
  body.write(ICON_MARKER, 0, "latin1");
  return Buffer.concat([sig, body]);
}

export const TEMPLATES = ["gitlab", "google", "oidc"] as const;
export const ICON_KINDS = ["template", "gitlab", "google", "upload", "none"] as const;
export const GENERIC: ProviderIconDto = { type: "builtin", name: "generic" };

export interface IconCase {
  id: string;
  displayName: string;
  template: (typeof TEMPLATES)[number];
  kind: (typeof ICON_KINDS)[number];
  issuer: string;
  version: number;
}

/** spec §5.2 對照表的**手寫**形——刻意不呼叫 `resolveProviderIcon`（那是被測物，呼叫它＝套套邏輯）。 */
export function expectedIcon(c: Pick<IconCase, "id" | "template" | "kind" | "version">): ProviderIconDto {
  switch (c.kind) {
    case "template":
      return c.template === "oidc" ? GENERIC : { type: "builtin", name: c.template };
    case "gitlab":
      return { type: "builtin", name: "gitlab" };
    case "google":
      return { type: "builtin", name: "google" };
    case "upload":
      return { type: "upload", url: `/api/auth/providers/${c.id}/icon?v=${c.version}` };
    case "none":
      return null;
  }
}

/** 15 個啟用中服務（三範本 × 五種 kind），sortOrder 0–14 依序；upload 列寫 `pngBytes()`、`image/png`、`icon_version = 3`（直寫 DB——本 fixture 不是被測方）。 */
export async function seedIconMatrix(db: Db): Promise<IconCase[]> {
  const out: IconCase[] = [];
  let order = 0;
  for (const template of TEMPLATES) {
    for (const kind of ICON_KINDS) {
      const issuer = `https://icon-${template}-${kind}.example`;
      const displayName = `${template}/${kind}`;
      const p = await seedAuthProvider(db, { issuerUrl: issuer, template, displayName, sortOrder: order++ });
      const version = kind === "upload" ? 3 : 0;
      await db
        .update(authProviders)
        .set(kind === "upload" ? { iconKind: kind, iconData: pngBytes(), iconMime: "image/png", iconVersion: version } : { iconKind: kind })
        .where(eq(authProviders.id, p.id));
      out.push({ id: p.id, displayName, template, kind, issuer, version });
    }
  }
  return out;
}

/** 回應本體不得含圖檔位元組或內部欄名（spec §5.3：清單 SELECT 不選 icon_data／icon_mime）。 */
export function expectNoIconBytes(body: string): void {
  expect(body).not.toContain(ICON_MARKER);
  expect(body).not.toContain('"Buffer"');
  for (const key of ["iconData", "iconMime", "iconVersion", "icon_data", "icon_mime", "icon_version"]) expect(body, key).not.toContain(key);
}
