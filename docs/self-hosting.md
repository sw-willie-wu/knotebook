# Self-hosting Knotebook

## Deployment prerequisites

- **`PUBLIC_URL` is required.** The server refuses to start without it (or if it isn't a valid `http(s)://` URL). It is used to decide whether session cookies are marked `Secure` and to build the OIDC `redirect_uri` (`<PUBLIC_URL>/api/auth/oidc/callback`) — see [OIDC / SSO login setup](#oidc--sso-login-setup) below.
- **Two supported topologies.** Pick one:
  - **(a) Trusted-LAN plain http.** For a home/office network with no untrusted devices, you can run Knotebook without TLS, reachable by hostname/IP from other machines on the LAN:
    - In `docker-compose.yml`, comment out the default `"127.0.0.1:3000:3000"` port line and uncomment `"3000:3000"` instead (this binds `0.0.0.0`, i.e. every interface).
    - Set `PUBLIC_URL=http://<lan-ip-or-hostname>:3000` (e.g. `http://192.168.1.50:3000`) in `.env`.
    - Understand the trade-off before enabling this: login credentials and the session cookie travel in **cleartext**; the session cookie has **no `Secure` flag**; **anyone on the same network segment can sniff or MITM the traffic**. The server will start and stay up, but it logs a prominent warning line at startup as a reminder — the server logs JSON (pino), so this arrives as one JSON log line with a `SECURITY WARNING: ...` `msg`, not a formatted banner. Only do this on a network where you trust every host, and accept that trade-off knowingly — it is not a substitute for topology (b) on any network you don't fully control.
  - **(b) Public — reverse proxy + TLS.** For anything reachable beyond a trusted LAN (the internet, a shared/untrusted network, etc.), terminate TLS in front of Knotebook and set `PUBLIC_URL` to the public `https://` address — see the next two bullets.
- **Reverse proxy and TLS are bring-your-own (topology (b)).** Knotebook does not terminate TLS itself; put a reverse proxy (nginx, Caddy, Traefik, etc.) in front of it and point `PUBLIC_URL` at the public HTTPS address.
- **Your reverse proxy must forward WebSocket upgrade requests on `/collab`** — real-time collaboration connects same-origin to `wss://<your-domain>/collab`, and a proxy that only forwards plain HTTP will silently break live editing while every other page keeps working. On nginx, the `/collab` location needs `proxy_http_version 1.1;` plus `proxy_set_header Upgrade $http_upgrade;` and `proxy_set_header Connection "upgrade";`; Caddy and Traefik forward WebSocket upgrades automatically with a plain reverse-proxy directive, no extra config needed.
- **`trustProxy` caveat (read this before exposing the instance publicly):** the server currently runs Fastify with `trustProxy: true`, which means it trusts `X-Forwarded-For` (and related forwarding headers) from *any* client, not just your reverse proxy. Until this is made configurable, anyone who can reach the server directly (or route around your proxy) can forge their apparent source IP. The practical impact today is on the IP-based dimension of login rate limiting/lockout (`apps/server/src/auth/rate-limit.ts`): a forged `X-Forwarded-For` can be used to sidestep the per-IP backoff (the per-account backoff is unaffected) — and, in the other direction, an attacker can also pin failed-login counts onto an arbitrary victim IP by forging it into their requests, locking out that address rather than their own. If you expose Knotebook publicly, make sure your network topology prevents clients from reaching the app directly (i.e. the reverse proxy is the only path in), and treat the per-IP throttle as advisory rather than a hard guarantee until this is addressed.

## Single-instance warning

Only run a single `app` container. `docker compose up --scale app=N` is **not supported** and must not be used.

In-memory state (login rate limiting, the collab-token/slug-change rate limiters, the password-hashing concurrency limiter, and the per-IP rate limiter on the OIDC login/callback endpoints) is already per-process, so scaling out would already produce inconsistent behavior across instances. On top of that, real-time collaboration state (Yjs/Hocuspocus) **now actually lives in server memory**: each note's live document and the set of connected clients are held in-process, with no cross-instance sync. Running multiple `app` instances behind a load balancer would let different clients editing the same note land on different instances, and their edits would **silently diverge** rather than merge or error. There is no clustering/coordination layer, so treat `app` as a single point of deployment, not a horizontally scaled service.

## Compose services and volumes

`docker-compose.yml` (repo root) defines two services:

- **`app`** — built from `docker/Dockerfile`, reads its configuration from `.env` (`env_file: .env`), and by default publishes only on `127.0.0.1:3000` (see topology (a) above to expose it on the LAN instead). It depends on `db` being healthy before starting, and has its own `/healthz`-based healthcheck. Uploaded images are persisted to the `uploads` named volume, mounted at `/app/uploads` — if you customize the compose file and drop that mount, uploaded images vanish on the next container rebuild.
- **`db`** — `pgvector/pgvector:pg17`, with data persisted to the `db_data` named volume. `POSTGRES_PASSWORD` can be overridden via `.env`, but Postgres only applies it while initializing a brand-new (empty) data directory — see the env var reference below.

`docker compose down -v` discards *all* named volumes, not just `db` — it takes the `uploads` volume with it too, so every note and every uploaded image is gone.

## Environment variables

Reference: `.env.example` (repo root) is the canonical source — copy it to `.env` and fill in the values below.

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | Postgres connection string. With `docker compose`, use the `db` service name as host: `postgres://knotebook:knotebook@db:5432/knotebook`. Outside docker, use `localhost` instead. |
| `APP_SECRET` | yes | 64+ hex characters (`openssl rand -hex 32`). Signs session cookies and collab tokens, and derives the key used to encrypt stored AI provider credentials (see [AI quick actions](./ai.md)) — rotating it invalidates all of those. |
| `PUBLIC_URL` | yes | The externally-reachable base URL. Must be a valid `http(s)://` URL — the server refuses to start otherwise. See [Deployment prerequisites](#deployment-prerequisites) for the two supported topologies. |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | yes, on first boot (set both) | Creates the first (admin) account at startup — this is the **only** way to initialize a fresh instance; the server refuses to start on an empty/uninitialized database without both set. `ADMIN_PASSWORD` must be 12+ characters. **Only takes effect on first initialization** (empty database, not yet initialized) — once an instance is initialized, these are silently ignored on every subsequent start, with no error or warning (see [Known limitations](./known-limitations.md)). The account created this way must change its password on first login. After first login, consider removing these two lines from `.env` — a plaintext password sitting there is one less secret to leak once the account already exists. |
| `OIDC_ISSUER_URL` | no (set all three or none) | Base URL of the OIDC identity provider's issuer — Knotebook runs OpenID Connect Discovery against `<issuer>/.well-known/openid-configuration`. Enables OIDC/SSO login when set together with the two variables below. Plain `http://` is allowed only for a trusted-internal IdP, and logs a startup warning when used. See [OIDC / SSO login setup](#oidc--sso-login-setup) below. |
| `OIDC_CLIENT_ID` | no (set all three or none) | Client ID registered with the identity provider for this Knotebook instance. |
| `OIDC_CLIENT_SECRET` | no (set all three or none) | Client secret for the same client registration. Knotebook authenticates with `client_secret_post` (the secret is sent in the token request body) — the client registration must allow that method. |
| `POSTGRES_PASSWORD` (docker-compose.yml, not `.env.example`) | no | Overrides the `db` service's Postgres password (default `knotebook`). Only applied by Postgres while initializing a brand-new (empty) data directory — see [Known limitations](./known-limitations.md) for how to change it after the `db` volume already exists. |

## OIDC / SSO login setup

OIDC login is optional — set `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, and `OIDC_CLIENT_SECRET` together in `.env` to enable it (leave all three unset to keep password-only auth; setting only some of them fails the server to start with a clear error). When enabled, a "Continue with SSO" option appears on the login page alongside password login — existing password accounts keep working either way.

When registering the OIDC client for this Knotebook instance on the identity provider side:

- **Grant the `email` and `profile` scopes.** Knotebook requests `openid email profile` on every login — an IdP that doesn't return an `email` claim under this scope can't complete sign-in (`oidc_email_missing`).
- **Allow `client_secret_post` client authentication.** Knotebook sends the client secret in the token request body, not as an `Authorization: Basic` header or a signed client assertion — the client registration must accept that method.
- **Issue an `email_verified` claim.** Knotebook only auto-provisions a new account or links to an existing password account when the IdP reports `email_verified: true`; an IdP that never sends this claim (or always sends `false`) blocks every login (`oidc_email_unverified`).
- **Register the redirect URI as `<PUBLIC_URL>/api/auth/oidc/callback`** (e.g. `https://notes.example.com/api/auth/oidc/callback`) — exactly this path, matching whatever `PUBLIC_URL` is set to.
- **The IdP must sign ID tokens with an asymmetric algorithm** (RS256/ES256/PS256, etc.). This is checked in two stages: if the IdP's discovery metadata doesn't list an asymmetric algorithm at all, OIDC is treated as unavailable before login even starts (redirects with `oidc_unavailable`); if the metadata claims asymmetric support but the ID token actually received back is signed some other way (e.g. HS256), signature verification fails during the code exchange instead (`oidc_exchange_failed`). Either way, an HS256-only IdP isn't supported.

A couple of operational notes:

- Knotebook discovers the IdP's configuration (`<issuer>/.well-known/openid-configuration`, signing keys, supported algorithms) once and caches it for the life of the process. If you change the IdP's endpoints, keys, or algorithm support, **restart the `app` container** to pick up the change.
- Plain `http://` issuer URLs are accepted, for a trusted-internal IdP only, and log a loud startup warning — the same spirit as the plain-http `PUBLIC_URL` topology above: tokens and claims travel in cleartext between Knotebook and the IdP.

See [Known limitations](./known-limitations.md) for the full list of OIDC-specific rough edges (no RP-initiated logout, switching identity providers, the per-IP rate limit on the OIDC endpoints, concurrent multi-tab sign-in, etc.).

## Troubleshooting

- **Server crash-loops on first boot with a database error mentioning `users_email_unique`.** This means `instance_setup` is still empty (the instance believes it hasn't been initialized yet) but a `users` row already exists whose stored `email` is exactly the lowercase form of `ADMIN_EMAIL` — `users.email` has a plain unique constraint on the raw column, not a `lower()` index, so this only collides when the existing row happens to already be lowercase (a mixed-case existing row wouldn't collide here, but would instead become one of the pre-v0.1 duplicate-row cases in [Known limitations](./known-limitations.md) if a fresh lowercase row got created too). This typically happens after restoring a partial backup, or after the `instance_setup` row was removed manually. `initializeInstance` retries the same failing insert on every restart, so the container keeps crashing identically. Fix it one of two ways: change `ADMIN_EMAIL` in `.env` to an address not already present in `users`, or, if that existing row is meant to be the admin account, mark the instance initialized directly instead of relying on the env bootstrap (`INSERT INTO instance_setup (singleton) VALUES (true) ON CONFLICT DO NOTHING;` and `UPDATE users SET is_admin = true WHERE email = '<lowercased-admin-email>';`), then restart — `ADMIN_EMAIL`/`ADMIN_PASSWORD` are ignored once `instance_setup` has a row.

## See also

- [Known limitations](./known-limitations.md) — the full list, including several deployment/env-var gotchas referenced above.
- [Restoring note content from a backup](./backup-restore.md).
- [API contract summary](./api.md).
