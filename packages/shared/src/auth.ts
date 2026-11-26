import type { ProviderIconDto, ProviderIconKind } from "./provider-icon.js";
import type { UserAvatarDto, AvatarRef } from "./avatar.js";

export const SESSION_COOKIE = "knotebook_session";

/** Scoped to /api/auth/oidc (server OIDC_STATE_COOKIE_PATH); lifetime is the server's OIDC_STATE_TTL_SECONDS. */
export const OIDC_STATE_COOKIE = "knotebook_oidc";

export interface UserDto {
  id: string;
  email: string;
  /** Renaming breaks old /n/<handle>/… URLs and frees the old handle for anyone to claim. */
  handle: string;
  displayName: string;
  isAdmin: boolean;
  /** Legacy: nothing sets it any more; only old admin-created accounts that never changed their password still carry it. Web's ChangePasswordGate redirects to /change-password on it. */
  mustChangePassword: boolean;
  hasPassword: boolean;
  /** Personal setting; the effective value also needs the site-wide switch. */
  autoVersions: boolean;
  /** Build the URL with avatarUrl only. */
  avatar: UserAvatarDto | null;
}

export type AdminInviteStatus = "pending" | "used" | "revoked" | "expired";

/** No token or hash: the token appears only once, in the create response. */
export interface AdminInviteDto {
  id: string;
  label: string | null;
  /** Computed in SQL with now(): used > revoked > expired (expires_at <= now()) > pending; ignores the password-login switch. */
  status: AdminInviteStatus;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  revokedAt: string | null;
  createdBy: { id: string; email: string } | null;
  usedBy: { id: string; email: string } | null;
}

/** Same number as apps/server/src/auth/constants.ts; this copy lets web forms validate first. */
export const MIN_PASSWORD_LENGTH = 12;
/** Email length in JS `.length`, matching SSO's 254 (server MAX_EMAIL_CLAIM_LENGTH); display name in code points. Web prechecks, the server enforces. */
export const MAX_REGISTER_EMAIL_LENGTH = 254;
export const MAX_REGISTER_DISPLAY_NAME_LENGTH = 100;
/** Code points; same as DB `one_time_links_label_chk`. */
export const MAX_INVITE_LABEL_LENGTH = 100;

/** Unauthenticated. `passwordLogin.enabled` is the effective value (DB OR env), without revealing whether env forces it. */
export interface AuthConfigDto {
  providers: AuthProviderPublicDto[];
  registration: {
    /** Password self-registration only; it also needs `passwordLogin.enabled`. false when the site_settings row is missing. */
    enabled: boolean;
    /** Enabled providers with auto-create on: a subset of `providers`, in display order; [] when the site_settings row is missing. */
    providerIds: string[];
  };
  passwordLogin: { enabled: boolean };
  autoVersionsEnabled: boolean;
  /** Bytes of Yjs state (server NOTE_MAX_BYTES). Web checks it before paste, drop and AI apply (the server doesn't check browser collab updates).
   * Always sent; optional only for test doubles and older servers (absent = no check). */
  noteMaxBytes?: number;
  /** Per image, document or text file, bytes; admin-adjustable. Absent (test doubles, older servers) means no client-side precheck. */
  maxUploadBytes?: number;
  /** Per audio or video file, bytes. Absent means no client-side precheck. */
  maxMediaUploadBytes?: number;
}

/** Exposes only id, display name and icon; issuer, client id and other provider settings never leave the server. */
export interface AuthProviderPublicDto {
  id: string;
  /** Admin-entered: web must render it only as React text (`escapeValue: false`). */
  displayName: string;
  /** Already resolved by resolveProviderIcon (null = no icon); web must not resolve it again. */
  icon: ProviderIconDto;
}

export interface PendingLinkDto {
  /** Send back unchanged; if another tab replaced the pending link, the server returns 409 `oidc_link_expired`. */
  pendingId: string;
  email: string;
  /** null if the provider was deleted; identities aren't tied to providers. */
  providerDisplayName: string | null;
  methods: { password: boolean; providers: AuthProviderPublicDto[] };
}

/** The server reads `next` from the pending cookie and filters it through `safeNextPath` (defaults to "/"); web uses it instead of the URL parameter. */
export interface PendingLinkConfirmDto {
  user: UserDto;
  next: string;
}

export interface OidcRedirectDto {
  url: string;
}

/** Every account write and email comparison must use this, OIDC claims included. */
export function normalizeEmail(input: string): string {
  return input.trim().toLowerCase();
}

/** Only people whose emails the caller can already see (group co-members, users the caller shared notes with); not a site directory. Excludes the caller and disabled accounts. */
export interface UserSuggestionDto {
  userId: string;
  email: string;
  displayName: string;
  avatar: AvatarRef | null;
}

export interface UserSuggestResponse {
  users: UserSuggestionDto[];
}

/** Trimmed length bounds (inclusive); web uses the same numbers to decide when to send a request. */
export const USER_SUGGEST_MIN_QUERY = 2;
export const USER_SUGGEST_MAX_QUERY = 100;
export const USER_SUGGEST_MAX_RESULTS = 8;

/** Must match DB CHECK `auth_providers_template_chk`. */
export type AuthProviderTemplate = "gitlab" | "google" | "oidc";

/** Never carries the client secret, only `hasSecret`. `displayName` is admin-entered: render it only as React text. */
export interface AdminAuthProviderDto {
  id: string;
  template: AuthProviderTemplate;
  displayName: string;
  issuerUrl: string;
  /** null until filled in; can't be enabled without it (DB auth_providers_enabled_client_id_chk). */
  clientId: string | null;
  hasSecret: boolean;
  enabled: boolean;
  /** Always false for new providers (the create API doesn't accept it); changing the issuer doesn't reset it. */
  autoCreateEnabled: boolean;
  sortOrder: number;
  /** The env-imported provider (keeps the old callback URL /api/auth/oidc/callback). */
  legacyCallback: boolean;
  callbackUrl: string;
  insecureIssuer: boolean;
  /** Discovery has succeeded once; false means impact counts may be inaccurate. */
  issuerResolved: boolean;
  createdAt: string;
  iconKind: ProviderIconKind;
  icon: ProviderIconDto;
}

export interface AdminAuthProviderImpactDto {
  linkedUsers: number;
  /** Linked users with no usable password (none, or password login off in DB) and no identity on another enabled provider. */
  lockedOutUsers: number;
  issuerResolved: boolean;
  /** When the DB password-login value is off, this disable is blocked by the anti-lockout guard (409 `admin_sso_link_required`). */
  actingAdminLockedOut: boolean;
}

export type AdminAuthProbeWarning = "insecure_issuer" | "client_secret_post_not_advertised" | "client_id_missing" | "secret_undecryptable";

export interface AdminAuthProbeResultDto {
  issuer: string;
  warnings: AdminAuthProbeWarning[];
}

export interface IdentityDto {
  id: string;
  issuer: string;
  providers: AuthProviderPublicDto[];
  createdAt: string;
  lastLoginAt: string | null;
  unlinkable: boolean;
}

/** Enabled providers where the user has no identity with the same issuer yet. */
export interface LinkableProviderDto {
  providerId: string;
  /** Admin-entered: render it only as React text. */
  displayName: string;
  template: AuthProviderTemplate;
  /** Already resolved by resolveProviderIcon (null = no icon); web must not resolve it again. */
  icon: ProviderIconDto;
}

/** Session-only. `passwordLoginEnabled` is the effective value (DB OR env). */
export interface IdentitiesDto {
  identities: IdentityDto[];
  linkable: LinkableProviderDto[];
  hasPassword: boolean;
  passwordLoginEnabled: boolean;
}

/** `passwordLoginEnabled` is the DB value; `passwordLoginForced` is env `PASSWORD_LOGIN_FORCE_ENABLE`. */
export interface AdminAuthSettingsDto {
  registrationEnabled: boolean;
  passwordLoginEnabled: boolean;
  passwordLoginForced: boolean;
  /** Snapshot for the dialog; the PATCH decides. */
  passwordLoginImpact: {
    usersWithoutSso: number;
    actingAdminHasSso: boolean;
    enabledProviders: number;
  };
}
