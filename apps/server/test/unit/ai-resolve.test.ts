import { describe, it, expect } from "vitest";
import type { AiProviderRow } from "../../src/ai/runtime.js";
import { resolveActionModel, type AiModelRow, type AiSnapshot } from "../../src/ai/resolve.js";

function provider(overrides: Partial<AiProviderRow> = {}): AiProviderRow {
  return {
    id: "provider-1",
    name: "Test Provider",
    type: "openai_compatible",
    baseUrl: "https://api.example.com",
    apiKeyEncrypted: null,
    enabled: true,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function model(overrides: Partial<AiModelRow> = {}): AiModelRow {
  return {
    id: "model-1",
    providerId: "provider-1",
    modelId: "gpt-test",
    displayName: "Test Model",
    purpose: "chat",
    isDefault: false,
    enabled: true,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function snapshot(models: AiModelRow[], providers: AiProviderRow[]): AiSnapshot {
  return { models, providers };
}

describe("resolveActionModel（純記憶體判定，spec §13.2）", () => {
  it("綁定 model 可用 → 直取，不看其他候選", () => {
    const bound = model({ id: "m-bound", providerId: "provider-1" });
    // isDefault 的另一筆刻意排更前——若 helper 誤把「綁定可用」也拿去跟回退候選比較
    // 排序，這筆測試會抓到（bound 必須被直接回傳，不進排序）。
    const other = model({ id: "m-other", providerId: "provider-1", isDefault: true });
    const snap = snapshot([bound, other], [provider()]);
    const result = resolveActionModel({ modelId: "m-bound" }, snap);
    expect(result?.model.id).toBe("m-bound");
    expect(result?.provider.id).toBe("provider-1");
  });

  it("綁定 model 存在但 disabled → 回退至其他可用 chat model", () => {
    const bound = model({ id: "m-bound", enabled: false });
    const fallback = model({ id: "m-fallback" });
    const snap = snapshot([bound, fallback], [provider()]);
    const result = resolveActionModel({ modelId: "m-bound" }, snap);
    expect(result?.model.id).toBe("m-fallback");
  });

  it("綁定 model 不存在（例如已被刪除、modelId 是野指標）→ 回退", () => {
    const fallback = model({ id: "m-fallback" });
    const snap = snapshot([fallback], [provider()]);
    const result = resolveActionModel({ modelId: "no-such-model" }, snap);
    expect(result?.model.id).toBe("m-fallback");
  });

  it("回退：多個候選中偏好 isDefault（縱使 createdAt 較晚）", () => {
    const early = model({ id: "m-early", createdAt: new Date("2026-01-01T00:00:00Z") });
    const preferredDefault = model({ id: "m-default", isDefault: true, createdAt: new Date("2026-06-01T00:00:00Z") });
    const snap = snapshot([early, preferredDefault], [provider()]);
    const result = resolveActionModel({ modelId: null }, snap);
    expect(result?.model.id).toBe("m-default");
  });

  it("回退：無 default → createdAt 最早者勝出", () => {
    const later = model({ id: "m-later", createdAt: new Date("2026-06-01T00:00:00Z") });
    const earlier = model({ id: "m-earlier", createdAt: new Date("2026-01-01T00:00:00Z") });
    const snap = snapshot([later, earlier], [provider()]);
    const result = resolveActionModel({ modelId: null }, snap);
    expect(result?.model.id).toBe("m-earlier");
  });

  it("全 disabled（model 本身或其 provider）→ null", () => {
    const disabledModel = model({ id: "m-1", enabled: false });
    const okModelBadProvider = model({ id: "m-2", providerId: "provider-2" });
    const snap = snapshot([disabledModel, okModelBadProvider], [provider(), provider({ id: "provider-2", enabled: false })]);
    const result = resolveActionModel({ modelId: null }, snap);
    expect(result).toBeNull();
  });

  it("provider disabled → 連帶該 model 不可用（綁定分支亦同，落回退）", () => {
    const boundOnDisabledProvider = model({ id: "m-bound", providerId: "provider-2" });
    const fallback = model({ id: "m-fallback", providerId: "provider-1" });
    const snap = snapshot([boundOnDisabledProvider, fallback], [provider(), provider({ id: "provider-2", enabled: false })]);
    const result = resolveActionModel({ modelId: "m-bound" }, snap);
    expect(result?.model.id).toBe("m-fallback");
  });

  it("回退候選只看 purpose='chat'——非 chat model 不入選", () => {
    const embedding = model({ id: "m-embed", purpose: "embedding", isDefault: true });
    const chat = model({ id: "m-chat", purpose: "chat" });
    const snap = snapshot([embedding, chat], [provider()]);
    const result = resolveActionModel({ modelId: null }, snap);
    expect(result?.model.id).toBe("m-chat");
  });

  it("回傳的 provider 與 model.providerId 一致（防不同源漂移）", () => {
    const m = model({ id: "m-1", providerId: "provider-9" });
    const snap = snapshot([m], [provider({ id: "provider-9" })]);
    const result = resolveActionModel({ modelId: null }, snap);
    expect(result?.provider.id).toBe(result?.model.providerId);
  });
});
