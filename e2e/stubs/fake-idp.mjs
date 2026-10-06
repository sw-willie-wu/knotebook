// e2e/stubs/fake-idp.mjs
//
// 零依賴（僅 node: 內建模組）OIDC IdP stub，跑在 compose 的獨立容器（見
// ../../docker-compose.e2e.yml 的 fake-idp 服務）。
//
// #187 PR2（spec §14.3、r2-M10）：同一個 process 掛兩個 issuer——
//   - 根：`http://fake-idp:9400`（e2e 疊的 OIDC_* 匯入成 legacy provider「SSO」，05 用它）
//   - 路徑形：`http://fake-idp:9400/b`（19 在 /admin/auth 建的第二個服務用它）
// 各自的 discovery 文件、iss、authorize／token／userinfo／jwks 路徑、**各自的簽章金鑰**與一次性狀態；**共用**同一組
// client id／secret；control endpoint 每個 issuer 一個（`/control/next-login`、`/b/control/next-login`）。
// stub 回報的 issuer 與 provider 填的字串完全一致（帶 path 時尾斜線不一致會 throw，r1 B.4）。
//
// 與 apps/server/test/helpers/fake-idp.ts（in-process CustomFetch harness）不同物：那支是測試進程內直接攔截 fetch，
// 這支是真的開 socket、走真實 HTTP；這裡不驗 redirect_uri 綁定（那支才有）。
// 刻意不用 fastify：與 app 不共用 build context（Dockerfile.stub 無安裝層）。

import { createServer } from "node:http";
import { generateKeyPairSync, createHash, randomBytes, sign as cryptoSign } from "node:crypto";

const PORT = 9400;
const ORIGIN = "http://fake-idp:9400";
const EXPECTED_CLIENT_ID = "knotebook-e2e";
const EXPECTED_CLIENT_SECRET = "e2e-oidc-secret";

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

function base64url(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buf.toString("base64url");
}

/** 一個 issuer 的全部狀態與處理。`prefix` 是路徑前綴（根＝""）；`handle` 回 true＝已回應。 */
function createIssuer(prefix, kid) {
  const issuer = `${ORIGIN}${prefix}`;
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  /** 下一次 `/authorize` 要簽發的身分——control endpoint 預置，`/authorize` 消費即清。 */
  let nextLogin;
  /** code → { claims, nonce, codeChallenge }——`/authorize` 寫入，`/token` 消費即刪。 */
  const authorizedCodes = new Map();
  /** access_token → claims——`/token` 寫入，`/userinfo` 讀（不刪）。 */
  const accessTokenClaims = new Map();

  /** 手組 compact JWT（RS256）——build context 內無 jose 可用。 */
  function signIdToken(claims) {
    const header = { alg: "RS256", kid };
    const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
    const signature = cryptoSign("RSA-SHA256", Buffer.from(signingInput), privateKey);
    return `${signingInput}.${base64url(signature)}`;
  }

  async function handle(req, res, url, path) {
    if (req.method === "GET" && path === "/.well-known/openid-configuration") {
      sendJson(res, 200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        userinfo_endpoint: `${issuer}/userinfo`,
        jwks_uri: `${issuer}/jwks`,
        id_token_signing_alg_values_supported: ["RS256"],
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        code_challenge_methods_supported: ["S256"],
        // #187 PR2：宣告 client_secret_post（Knotebook 一律用它），否則「測試連線」會出 client_secret_post_not_advertised 提醒。
        token_endpoint_auth_methods_supported: ["client_secret_post"],
      });
      return true;
    }

    if (req.method === "PUT" && path === "/control/next-login") {
      const body = await readBody(req);
      let claims;
      try {
        claims = JSON.parse(body || "{}");
      } catch {
        sendJson(res, 400, { error: "invalid_json" });
        return true;
      }
      if (typeof claims.sub !== "string" || claims.sub === "") {
        sendJson(res, 400, { error: "sub 為必要欄位" });
        return true;
      }
      nextLogin = claims;
      sendJson(res, 200, { ok: true });
      return true;
    }

    if (req.method === "GET" && path === "/authorize") {
      const redirectUri = url.searchParams.get("redirect_uri");
      const codeChallenge = url.searchParams.get("code_challenge");
      const scope = url.searchParams.get("scope") ?? "";
      const state = url.searchParams.get("state") ?? "";
      const nonce = url.searchParams.get("nonce") ?? "";
      if (!redirectUri || !codeChallenge) {
        sendJson(res, 400, { error: "invalid_request", error_description: "缺 redirect_uri 或 code_challenge" });
        return true;
      }
      if (!scope.split(" ").includes("email")) {
        sendJson(res, 400, { error: "invalid_scope", error_description: "scope 必須含 email" });
        return true;
      }
      if (!nextLogin) {
        sendJson(res, 500, { error: "server_error", error_description: `未預置身分：測試須先 PUT ${prefix}/control/next-login` });
        return true;
      }
      const code = randomBytes(16).toString("hex");
      authorizedCodes.set(code, { claims: nextLogin, nonce, codeChallenge });
      nextLogin = undefined;
      const location = new URL(redirectUri);
      location.searchParams.set("code", code);
      location.searchParams.set("state", state);
      res.writeHead(302, { location: location.href });
      res.end();
      return true;
    }

    if (req.method === "POST" && path === "/token") {
      const params = new URLSearchParams(await readBody(req));
      const code = params.get("code");
      const clientId = params.get("client_id");
      const clientSecret = params.get("client_secret");
      const codeVerifier = params.get("code_verifier");
      const record = code ? authorizedCodes.get(code) : undefined;
      if (!code || !record) {
        sendJson(res, 400, { error: "invalid_grant", error_description: "code 不存在或已使用" });
        return true;
      }
      authorizedCodes.delete(code);
      if (clientId !== EXPECTED_CLIENT_ID || clientSecret !== EXPECTED_CLIENT_SECRET) {
        sendJson(res, 400, { error: "invalid_client" });
        return true;
      }
      const expectedChallenge = codeVerifier ? createHash("sha256").update(codeVerifier).digest("base64url") : undefined;
      if (!expectedChallenge || expectedChallenge !== record.codeChallenge) {
        sendJson(res, 400, { error: "invalid_grant", error_description: "PKCE code_verifier mismatch" });
        return true;
      }
      const nowSeconds = Math.floor(Date.now() / 1000);
      const idTokenClaims = { iss: issuer, aud: clientId, sub: record.claims.sub, iat: nowSeconds, exp: nowSeconds + 300 };
      if (record.claims.email !== undefined) idTokenClaims.email = record.claims.email;
      if (record.claims.email_verified !== undefined) idTokenClaims.email_verified = record.claims.email_verified;
      if (record.claims.name !== undefined) idTokenClaims.name = record.claims.name;
      idTokenClaims.nonce = record.nonce;
      const accessToken = randomBytes(16).toString("hex");
      accessTokenClaims.set(accessToken, record.claims);
      sendJson(res, 200, { access_token: accessToken, token_type: "bearer", id_token: signIdToken(idTokenClaims) });
      return true;
    }

    if (req.method === "GET" && path === "/jwks") {
      const jwk = publicKey.export({ format: "jwk" });
      sendJson(res, 200, { keys: [{ ...jwk, kid, use: "sig", alg: "RS256" }] });
      return true;
    }

    if (req.method === "GET" && path === "/userinfo") {
      const authHeader = req.headers.authorization;
      const accessToken = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : undefined;
      const claims = accessToken ? accessTokenClaims.get(accessToken) : undefined;
      if (!claims) {
        sendJson(res, 401, { error: "invalid_token" });
        return true;
      }
      const body = { sub: claims.sub };
      if (claims.email !== undefined) body.email = claims.email;
      if (claims.email_verified !== undefined) body.email_verified = claims.email_verified;
      if (claims.name !== undefined) body.name = claims.name;
      sendJson(res, 200, body);
      return true;
    }

    return false;
  }

  return { prefix, handle };
}

// 路徑形的放前面：根 issuer 的前綴是 ""，會吃下所有路徑。
const ISSUERS = [createIssuer("/b", "e2e-key-b"), createIssuer("", "e2e-key")];

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "fake-idp"}`);
    for (const iss of ISSUERS) {
      if (iss.prefix !== "" && !url.pathname.startsWith(`${iss.prefix}/`)) continue;
      if (await iss.handle(req, res, url, url.pathname.slice(iss.prefix.length))) return;
      if (iss.prefix !== "") break; // `/b/…` 沒命中：不落到根 issuer（否則 `/b/token` 打錯會被根的同名路由誤收）
    }
    if (!res.headersSent) sendJson(res, 404, { error: "not_found" });
  } catch (err) {
    console.error("[fake-idp] unhandled error", err);
    if (!res.headersSent) sendJson(res, 500, { error: "server_error" });
  }
});

// 必須綁 0.0.0.0：同時要被 compose 網路內的 app 容器（issuer host `fake-idp`）與
// 發布出去的 `127.0.0.1:9400`（瀏覽器經 host-resolver-rules 打進來）打到。
server.listen(PORT, "0.0.0.0", () => {
  console.log(`[fake-idp] listening on 0.0.0.0:${PORT} (issuers: ${ISSUERS.map(i => `${ORIGIN}${i.prefix}`).join(", ")})`);
});
