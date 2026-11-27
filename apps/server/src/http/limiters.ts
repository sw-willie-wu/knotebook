import type { SiteLimitKey } from "@knotebook/shared";
import type { SiteLimits } from "../site-limits/store.js";
import {
  AI_LIMIT, AUTHORIZE_LIMIT, AVATAR_REFRESH_LIMIT, BEARER_MISS_LIMIT, COLLAB_TOKEN_LIMIT, COMMENT_LIMIT, COMMENT_READ_LIMIT, CONTENT_READ_LIMIT, DCR_LIMIT, EDIT_LIMIT, FAVORITE_LIMIT, FixedWindowLimiter, FOLDER_LIMIT,
  OIDC_LIMIT, ONE_TIME_LINK_ATTEMPT_LIMIT, ONE_TIME_LINK_MISS_LIMIT, PAT_CREATE_LIMIT, PUBLIC_LINK_LIMIT, PUBLIC_MISS_LIMIT, PUBLIC_NOTE_LIMIT,
  PUBLIC_UPLOAD_LIMIT, PUBLIC_WIDTH_LIMIT, REGISTER_LIMIT, SEARCH_LIMIT, SLUG_PATCH_LIMIT, TAG_LIMIT, TOKEN_ENDPOINT_LIMIT, TOKEN_READ_LIMIT, TOKEN_RENAME_LIMIT,
  TOKEN_WRITE_LIMIT, TRANSFER_EXPORT_LIMIT, TRANSFER_WRITE_LIMIT, UPLOAD_LIMIT, USER_SUGGEST_LIMIT,
} from "./rate-limit.js";

export type Limiters = {
  collabToken: FixedWindowLimiter;
  slugPatch: FixedWindowLimiter;
  upload: FixedWindowLimiter;
  ai: FixedWindowLimiter;
  oidcLogin: FixedWindowLimiter;
  oidcCallback: FixedWindowLimiter;
  publicLink: FixedWindowLimiter;
  publicWidth: FixedWindowLimiter;
  publicMiss: FixedWindowLimiter;
  publicNote: FixedWindowLimiter;
  publicUpload: FixedWindowLimiter;
  tokenRead: FixedWindowLimiter;
  tokenWrite: FixedWindowLimiter;
  bearerMiss: FixedWindowLimiter;
  patCreate: FixedWindowLimiter;
  tokenRename: FixedWindowLimiter;
  dcr: FixedWindowLimiter;
  authorize: FixedWindowLimiter;
  tokenEndpoint: FixedWindowLimiter;
  contentRead: FixedWindowLimiter;
  search: FixedWindowLimiter;
  transferExport: FixedWindowLimiter;
  transferWrite: FixedWindowLimiter;
  userSuggest: FixedWindowLimiter;
  avatarRefresh: FixedWindowLimiter;
  edit: FixedWindowLimiter;
  folder: FixedWindowLimiter;
  favorite: FixedWindowLimiter;
  tag: FixedWindowLimiter;
  comment: FixedWindowLimiter;
  commentRead: FixedWindowLimiter;
  register: FixedWindowLimiter;
  oneTimeLinkMiss: FixedWindowLimiter;
  oneTimeLinkAttempt: FixedWindowLimiter;
};

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

// The fixed limiters: fresh instances on every call, never a module singleton (same reason as test/helpers.ts freshLimiters).
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
    tag: new FixedWindowLimiter(TAG_LIMIT),
    comment: new FixedWindowLimiter(COMMENT_LIMIT),
    commentRead: new FixedWindowLimiter(COMMENT_READ_LIMIT),
    register: new FixedWindowLimiter(REGISTER_LIMIT),
    oneTimeLinkMiss: new FixedWindowLimiter(ONE_TIME_LINK_MISS_LIMIT),
    oneTimeLinkAttempt: new FixedWindowLimiter(ONE_TIME_LINK_ATTEMPT_LIMIT),
  };
}

// Skips explicit `undefined`: spreading `{ x: overrides.x }` per key would overwrite with undefined, and tsconfig has no exactOptionalPropertyTypes to catch it.
export function mergeLimiters(base: Limiters, overrides?: Partial<Limiters>): Limiters {
  if (!overrides) return base;
  const merged: Limiters = { ...base };
  for (const k of Object.keys(overrides) as Array<keyof Limiters>) {
    const v = overrides[k];
    if (v !== undefined) merged[k] = v;
  }
  return merged satisfies Limiters;
}
