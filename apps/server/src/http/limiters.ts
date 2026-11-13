/**
 * 31 顆節流桶的型別與建構（#397）。`AppDeps.limiters` 原本的行內型別搬到這裡取名 `Limiters`；
 * 9 顆站台管理可調的桶（註冊表的 `rate*` 項）由 `buildAdjustableLimiters(siteLimits)` 建，`limit` 每次現讀
 * `siteLimits.get(key)`、`windowMs` 照常數（視窗不可調）；其餘 22 顆由 `buildFixedLimiters()` 建，照常數。
 * `mergeLimiters` 把測試覆寫蓋到 base 上（略過 explicit `undefined`）。
 */
import type { SiteLimitKey } from "@knotebook/shared";
import type { SiteLimits } from "../site-limits/store.js";
import {
  AI_LIMIT, AUTHORIZE_LIMIT, AVATAR_REFRESH_LIMIT, BEARER_MISS_LIMIT, COLLAB_TOKEN_LIMIT, CONTENT_READ_LIMIT, DCR_LIMIT, EDIT_LIMIT, FAVORITE_LIMIT, FixedWindowLimiter, FOLDER_LIMIT,
  OIDC_LIMIT, ONE_TIME_LINK_ATTEMPT_LIMIT, ONE_TIME_LINK_MISS_LIMIT, PAT_CREATE_LIMIT, PUBLIC_LINK_LIMIT, PUBLIC_MISS_LIMIT, PUBLIC_NOTE_LIMIT,
  PUBLIC_UPLOAD_LIMIT, PUBLIC_WIDTH_LIMIT, REGISTER_LIMIT, SEARCH_LIMIT, SLUG_PATCH_LIMIT, TOKEN_ENDPOINT_LIMIT, TOKEN_READ_LIMIT, TOKEN_RENAME_LIMIT,
  TOKEN_WRITE_LIMIT, TRANSFER_EXPORT_LIMIT, TRANSFER_WRITE_LIMIT, UPLOAD_LIMIT, USER_SUGGEST_LIMIT,
} from "./rate-limit.js";

export type Limiters = {
  collabToken: FixedWindowLimiter;
  slugPatch: FixedWindowLimiter;
  upload: FixedWindowLimiter;
  ai: FixedWindowLimiter;
  /** OIDC login 與 callback 各自一份額度（issue #16），見 `OIDC_LIMIT` 註解。 */
  oidcLogin: FixedWindowLimiter;
  oidcCallback: FixedWindowLimiter;
  /** #72：public-link 管理端 PUT/DELETE（key=userId；GET 不吃桶，見 PUBLIC_LINK_LIMIT）。 */
  publicLink: FixedWindowLimiter;
  /** #297：`PUT …/public-width`（key=userId；解析 body 與授權之後才扣，與 publicLink 分開，見 PUBLIC_WIDTH_LIMIT）。 */
  publicWidth: FixedWindowLimiter;
  /** #72 公開端點雙桶（miss=ip／hit=ip:token，語意見 PUBLIC_MISS_LIMIT 註解）。 */
  publicMiss: FixedWindowLimiter;
  publicNote: FixedWindowLimiter;
  publicUpload: FixedWindowLimiter;
  /** #107：Bearer token 路徑（key=`token:${userId}`），session 路徑不吃桶。 */
  tokenRead: FixedWindowLimiter;
  tokenWrite: FixedWindowLimiter;
  /** #107：無效 Bearer（key=ip）——consume 的觸發集合見 `BEARER_MISS_LIMIT` 註解。 */
  bearerMiss: FixedWindowLimiter;
  /** #107：`POST /api/auth/tokens`（key=userId）。 */
  patCreate: FixedWindowLimiter;
  /** #106：`PATCH /api/auth/tokens/:id` 改 agent 名稱（key=userId，見 `TOKEN_RENAME_LIMIT`）。 */
  tokenRename: FixedWindowLimiter;
  /** #132：DCR／authorize／token 三個無認證端點（key=ip）。 */
  dcr: FixedWindowLimiter;
  authorize: FixedWindowLimiter;
  tokenEndpoint: FixedWindowLimiter;
  /** #106：`GET /api/notes/:id/content`（key=userId；角色檢查後才消耗，見 `CONTENT_READ_LIMIT`）。 */
  contentRead: FixedWindowLimiter;
  /** #93：全文搜尋（key=userId，見 `SEARCH_LIMIT`）。 */
  search: FixedWindowLimiter;
  /** 批次傳輸：整包匯出（key=userId，見 TRANSFER_EXPORT_LIMIT）。 */
  transferExport: FixedWindowLimiter;
  /** 批次傳輸：檔案寫回（key=userId，見 TRANSFER_WRITE_LIMIT；在佇列內扣）。 */
  transferWrite: FixedWindowLimiter;
  /** `GET /api/users/suggest`（key=userId，見 `USER_SUGGEST_LIMIT`）。 */
  userSuggest: FixedWindowLimiter;
  /** `POST /api/auth/avatars/oidc/:identityId/refresh`（key=userId，見 `AVATAR_REFRESH_LIMIT`）。 */
  avatarRefresh: FixedWindowLimiter;
  /** #106 寫入端：`POST /api/notes/:id/edits`、`POST /api/notes` 帶 `content`（key=userId，見 `EDIT_LIMIT`）。 */
  edit: FixedWindowLimiter;
  /** 資料夾寫入（`folders/service.ts` 四支，REST 與 MCP 共用；key=userId，見 `FOLDER_LIMIT`——不與 `edit` 共桶）。 */
  folder: FixedWindowLimiter;
  /** #334：最愛的加入與移出（`PUT`／`DELETE /api/favorites/:id`；key=userId，見 `FAVORITE_LIMIT`——不與 `edit` 共桶）。 */
  favorite: FixedWindowLimiter;
  /** #187：帳密註冊（key=ip）。 */
  register: FixedWindowLimiter;
  /** #286／#285：重設連結與邀請的 inspect／完成（四個無登入端點、跨 kind 共用）的無效 token（key=ip；失敗才扣，見 `ONE_TIME_LINK_MISS_LIMIT`）。 */
  oneTimeLinkMiss: FixedWindowLimiter;
  /** #286／#285：每支一次性連結（重設、邀請）的完成／接受嘗試（key=`link:${id}`；帳密開才扣、inspect 不扣，見 `ONE_TIME_LINK_ATTEMPT_LIMIT`）。 */
  oneTimeLinkAttempt: FixedWindowLimiter;
};

/** 9 顆可調桶 → 註冊表的 key（桶名 → `rate*`）。 */
const ADJUSTABLE_SPEC = {
  tokenRead: { key: "rateTokenRead", windowMs: TOKEN_READ_LIMIT.windowMs },
  tokenWrite: { key: "rateTokenWrite", windowMs: TOKEN_WRITE_LIMIT.windowMs },
  contentRead: { key: "rateContentRead", windowMs: CONTENT_READ_LIMIT.windowMs },
  edit: { key: "rateEdit", windowMs: EDIT_LIMIT.windowMs },
  search: { key: "rateSearch", windowMs: SEARCH_LIMIT.windowMs },
  upload: { key: "rateUpload", windowMs: UPLOAD_LIMIT.windowMs },
  ai: { key: "rateAi", windowMs: AI_LIMIT.windowMs },
  transferExport: { key: "rateTransferExport", windowMs: TRANSFER_EXPORT_LIMIT.windowMs },
  transferWrite: { key: "rateTransferWrite", windowMs: TRANSFER_WRITE_LIMIT.windowMs },
} as const satisfies Record<string, { key: SiteLimitKey; windowMs: number }>;

export const ADJUSTABLE_LIMITER_KEYS = Object.freeze(Object.keys(ADJUSTABLE_SPEC) as Array<keyof typeof ADJUSTABLE_SPEC>);
export type AdjustableLimiterKey = (typeof ADJUSTABLE_LIMITER_KEYS)[number];
export type AdjustableLimiters = Pick<Limiters, AdjustableLimiterKey>;
export type FixedLimiters = Omit<Limiters, AdjustableLimiterKey>;

/** 9 顆可調桶：`limit` 每次現讀 `siteLimits.get(key)`，`windowMs` 固定。 */
export function buildAdjustableLimiters(siteLimits: SiteLimits): AdjustableLimiters {
  const make = (name: AdjustableLimiterKey): FixedWindowLimiter => {
    const { key, windowMs } = ADJUSTABLE_SPEC[name];
    return new FixedWindowLimiter({ limit: () => siteLimits.get(key), windowMs });
  };
  return {
    tokenRead: make("tokenRead"),
    tokenWrite: make("tokenWrite"),
    contentRead: make("contentRead"),
    edit: make("edit"),
    search: make("search"),
    upload: make("upload"),
    ai: make("ai"),
    transferExport: make("transferExport"),
    transferWrite: make("transferWrite"),
  };
}

/** 其餘 22 顆：每次呼叫都是全新實例（嚴禁 module 單例，同 `freshLimiters` 的理由）。 */
export function buildFixedLimiters(): FixedLimiters {
  return {
    collabToken: new FixedWindowLimiter(COLLAB_TOKEN_LIMIT),
    slugPatch: new FixedWindowLimiter(SLUG_PATCH_LIMIT),
    oidcLogin: new FixedWindowLimiter(OIDC_LIMIT),
    oidcCallback: new FixedWindowLimiter(OIDC_LIMIT),
    publicLink: new FixedWindowLimiter(PUBLIC_LINK_LIMIT),
    publicWidth: new FixedWindowLimiter(PUBLIC_WIDTH_LIMIT),
    publicMiss: new FixedWindowLimiter(PUBLIC_MISS_LIMIT),
    publicNote: new FixedWindowLimiter(PUBLIC_NOTE_LIMIT),
    publicUpload: new FixedWindowLimiter(PUBLIC_UPLOAD_LIMIT),
    bearerMiss: new FixedWindowLimiter(BEARER_MISS_LIMIT),
    patCreate: new FixedWindowLimiter(PAT_CREATE_LIMIT),
    tokenRename: new FixedWindowLimiter(TOKEN_RENAME_LIMIT),
    dcr: new FixedWindowLimiter(DCR_LIMIT),
    authorize: new FixedWindowLimiter(AUTHORIZE_LIMIT),
    tokenEndpoint: new FixedWindowLimiter(TOKEN_ENDPOINT_LIMIT),
    userSuggest: new FixedWindowLimiter(USER_SUGGEST_LIMIT),
    avatarRefresh: new FixedWindowLimiter(AVATAR_REFRESH_LIMIT),
    folder: new FixedWindowLimiter(FOLDER_LIMIT),
    favorite: new FixedWindowLimiter(FAVORITE_LIMIT),
    register: new FixedWindowLimiter(REGISTER_LIMIT),
    oneTimeLinkMiss: new FixedWindowLimiter(ONE_TIME_LINK_MISS_LIMIT),
    oneTimeLinkAttempt: new FixedWindowLimiter(ONE_TIME_LINK_ATTEMPT_LIMIT),
  };
}

/**
 * 把 `overrides` 裡值不是 `undefined` 的 key 蓋到 `base` 上；explicit `undefined` 略過（逐鍵展開 `{ x: overrides.x }` 會蓋成
 * `undefined`，`tsconfig` 沒開 `exactOptionalPropertyTypes` 擋不住，在合併處一次擋掉）。沒給 `overrides` 回 `base` 本身。
 */
export function mergeLimiters(base: Limiters, overrides?: Partial<Limiters>): Limiters {
  if (!overrides) return base;
  const merged: Limiters = { ...base };
  for (const k of Object.keys(overrides) as Array<keyof Limiters>) {
    const v = overrides[k];
    if (v !== undefined) merged[k] = v;
  }
  return merged satisfies Limiters;
}
