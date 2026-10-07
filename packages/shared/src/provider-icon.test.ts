import { describe, expect, it } from "vitest";
import {
  MAX_PROVIDER_ICON_BYTES,
  MAX_PROVIDER_ICON_SOURCE_BYTES,
  PROVIDER_ICON_SIZE,
  providerIconUrl,
  resolveProviderIcon,
} from "./provider-icon.js";

const ID = "11111111-1111-4111-8111-111111111111";
const r = (template: string, iconKind: string, iconVersion = 0) => resolveProviderIcon({ id: ID, template, iconKind, iconVersion });

describe("resolveProviderIcon（spec §5.2 對照表）", () => {
  it("template：gitlab 範本 → GitLab logo、google 範本 → Google logo、oidc 與任何其他範本值 → 通用圖示", () => {
    expect(r("gitlab", "template")).toEqual({ type: "builtin", name: "gitlab" });
    expect(r("google", "template")).toEqual({ type: "builtin", name: "google" });
    expect(r("oidc", "template")).toEqual({ type: "builtin", name: "generic" });
    expect(r("github", "template")).toEqual({ type: "builtin", name: "generic" });
  });

  it("gitlab／google 不論範本", () => {
    for (const template of ["gitlab", "google", "oidc"]) {
      expect(r(template, "gitlab"), template).toEqual({ type: "builtin", name: "gitlab" });
      expect(r(template, "google"), template).toEqual({ type: "builtin", name: "google" });
    }
  });

  it("upload → providerIconUrl(id, iconVersion)（不論範本；版本取當下值）", () => {
    expect(r("gitlab", "upload", 7)).toEqual({ type: "upload", url: `/api/auth/providers/${ID}/icon?v=7` });
    expect(r("oidc", "upload", 0)).toEqual({ type: "upload", url: `/api/auth/providers/${ID}/icon?v=0` });
  });

  it("none → null（不論範本）", () => {
    for (const template of ["gitlab", "google", "oidc"]) expect(r(template, "none"), template).toBeNull();
  });

  it("未知 iconKind 當 template（DB CHECK 保證值域；這是防禦形，spec §5.2【作者補】）", () => {
    expect(r("google", "svg")).toEqual({ type: "builtin", name: "google" });
    expect(r("oidc", "")).toEqual({ type: "builtin", name: "generic" });
  });
});

describe("providerIconUrl", () => {
  it("形為 /api/auth/providers/<id>/icon?v=<version>", () => {
    expect(providerIconUrl(ID, 3)).toBe(`/api/auth/providers/${ID}/icon?v=3`);
  });
});

describe("常數（spec §4.1）", () => {
  it("256 KB 與 DB CHECK `auth_providers_icon_size_chk` 的字面 262144 相同；選檔上限 5 MB；縮圖最長邊 128", () => {
    // schema.ts 的 CHECK 刻意寫字面（插值會變成 SQL 參數），兩邊靠本案對齊。
    expect(MAX_PROVIDER_ICON_BYTES).toBe(262144);
    expect(MAX_PROVIDER_ICON_SOURCE_BYTES).toBe(5 * 1024 * 1024);
    expect(PROVIDER_ICON_SIZE).toBe(128);
  });
});
