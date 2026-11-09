import { request as pwRequest, type FullConfig } from "@playwright/test";
import { ADMIN } from "./tests/helpers.js";

/**
 * e2e 疊起來後、所有 spec 之前：以管理員 API 建一個名為「SSO」的登入服務，指向 fake-idp 的根 issuer
 * （`http://fake-idp:9400`，client `knotebook-e2e`／secret `e2e-oidc-secret`，見 `stubs/fake-idp.mjs`），啟用並打開自動建帳。
 * 05、19、20、26 以「Sign in with SSO」定位這顆按鈕。以前由 `OIDC_*` 環境變數在首次啟動匯入（已移除）。
 * 冪等：疊不 down 就重跑時，已有名為「SSO」的服務就不再建，但仍補一次 PATCH 啟用＋自動建帳（19-6 中途失敗可能留下關閉的狀態）。
 * 回呼網址是一般形式 `/api/auth/oidc/callback/<id>`；舊回呼網址（legacy_callback）只有 server 整合測試涵蓋，管理 API 建不出來。
 */
const SSO_NAME = "SSO";

export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL = config.projects[0]?.use.baseURL ?? "http://localhost:3100";
  const api = await pwRequest.newContext({ baseURL });
  const check = async (res: Awaited<ReturnType<typeof api.get>>, what: string) => {
    if (!res.ok()) throw new Error(`global-setup：${what} → HTTP ${res.status()} ${await res.text()}`);
    return res;
  };
  try {
    await check(await api.post("/api/auth/login", { data: { email: ADMIN.email, password: ADMIN.password } }), "管理員登入");
    const list = (await (await check(await api.get("/api/admin/auth/providers"), "列出登入服務")).json()) as { providers: Array<{ id: string; displayName: string }> };
    const existing = list.providers.find(p => p.displayName === SSO_NAME);
    const id = existing?.id ?? (await (
      await check(
        await api.post("/api/admin/auth/providers", {
          data: { template: "oidc", displayName: SSO_NAME, issuerUrl: "http://fake-idp:9400", clientId: "knotebook-e2e", clientSecret: "e2e-oidc-secret" },
        }),
        "建立 SSO 服務",
      )
    ).json() as { id: string }).id;
    // 建立時一律停用、不自動建帳（spec §9.2／U3）；secret 已隨建立送出，這裡直接啟用並打開自動建帳。
    await check(await api.patch(`/api/admin/auth/providers/${id}`, { data: { enabled: true, autoCreateEnabled: true } }), "啟用 SSO 服務");
  } finally {
    await api.dispose();
  }
}
