// e2e/stubs/fake-idp.mjs
//
// 零依賴（僅 node: 內建模組）OIDC IdP stub，跑在 compose 的獨立容器（見
// ../../docker-compose.e2e.yml 的 fake-idp 服務）。契約見 task-11-brief.md §「e2e/stubs/fake-idp.mjs」。
//
// 與 apps/server/test/helpers/fake-idp.ts（in-process CustomFetch harness）不同物：
// 那支是測試進程內直接攔截 fetch，這支是真的開 socket、走真實 HTTP。協定細節
// （id_token 必含 iat、PKCE S256、redirect_uri 原樣、nonce 原樣回送、userinfo 回
// string sub）比照該檔案，但驗證範圍以本檔案逐字契約為準（例如這裡不驗
// redirect_uri 綁定，那支才有）。
//
// 刻意偏離 §14.5 建議的「小 fastify」：與 app 不共用 build context
// （Dockerfile.stub 無安裝層），fastify 物理上不可得——不得回退。

import { createServer } from "node:http";
import { generateKeyPairSync, createHash, randomBytes, sign as cryptoSign } from "node:crypto";

const PORT = 9400;
const ISSUER = "http://fake-idp:9400";
const EXPECTED_CLIENT_ID = "knotebook-e2e";
const EXPECTED_CLIENT_SECRET = "e2e-oidc-secret";
const KID = "e2e-key";

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

/** 下一次 `/authorize` 要簽發的身分——`PUT /control/next-login` 預置，`/authorize` 消費即清。 */
let nextLogin;
/** code → { claims, nonce, codeChallenge }——`/authorize` 寫入，`/token` 消費即刪。 */
const authorizedCodes = new Map();
/** access_token → claims——`/token` 寫入，`/userinfo` 讀（不刪，測試同一次流程可能查多次）。 */
const accessTokenClaims = new Map();

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

/** 手組 compact JWT（RS256）——build context 內無 jose 可用（見上方檔案註解）。 */
function signIdToken(claims) {
  const header = { alg: "RS256", kid: KID };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signature = cryptoSign("RSA-SHA256", Buffer.from(signingInput), privateKey);
  return `${signingInput}.${base64url(signature)}`;
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "fake-idp"}`);
    const { pathname } = url;

    if (req.method === "GET" && pathname === "/.well-known/openid-configuration") {
      return sendJson(res, 200, {
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        userinfo_endpoint: `${ISSUER}/userinfo`,
        jwks_uri: `${ISSUER}/jwks`,
        id_token_signing_alg_values_supported: ["RS256"],
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        code_challenge_methods_supported: ["S256"],
      });
    }

    if (req.method === "PUT" && pathname === "/control/next-login") {
      const body = await readBody(req);
      let claims;
      try {
        claims = JSON.parse(body || "{}");
      } catch {
        return sendJson(res, 400, { error: "invalid_json" });
      }
      if (typeof claims.sub !== "string" || claims.sub === "") {
        return sendJson(res, 400, { error: "sub 為必要欄位" });
      }
      nextLogin = claims;
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === "GET" && pathname === "/authorize") {
      const redirectUri = url.searchParams.get("redirect_uri");
      const codeChallenge = url.searchParams.get("code_challenge");
      const scope = url.searchParams.get("scope") ?? "";
      const state = url.searchParams.get("state") ?? "";
      const nonce = url.searchParams.get("nonce") ?? "";

      if (!redirectUri || !codeChallenge) {
        return sendJson(res, 400, { error: "invalid_request", error_description: "缺 redirect_uri 或 code_challenge" });
      }
      if (!scope.split(" ").includes("email")) {
        return sendJson(res, 400, { error: "invalid_scope", error_description: "scope 必須含 email" });
      }
      if (!nextLogin) {
        return sendJson(res, 500, { error: "server_error", error_description: "未預置身分：測試須先 PUT /control/next-login" });
      }

      const code = randomBytes(16).toString("hex");
      authorizedCodes.set(code, { claims: nextLogin, nonce, codeChallenge });
      nextLogin = undefined;

      const location = new URL(redirectUri);
      location.searchParams.set("code", code);
      location.searchParams.set("state", state);
      res.writeHead(302, { location: location.href });
      return res.end();
    }

    if (req.method === "POST" && pathname === "/token") {
      const body = await readBody(req);
      const params = new URLSearchParams(body);
      const code = params.get("code");
      const clientId = params.get("client_id");
      const clientSecret = params.get("client_secret");
      const codeVerifier = params.get("code_verifier");

      const record = code ? authorizedCodes.get(code) : undefined;
      if (!code || !record) {
        return sendJson(res, 400, { error: "invalid_grant", error_description: "code 不存在或已使用" });
      }
      // 一次性消費：驗證通過與否都不再讓同一 code 生效。
      authorizedCodes.delete(code);

      if (clientId !== EXPECTED_CLIENT_ID || clientSecret !== EXPECTED_CLIENT_SECRET) {
        return sendJson(res, 400, { error: "invalid_client" });
      }

      const expectedChallenge = codeVerifier ? createHash("sha256").update(codeVerifier).digest("base64url") : undefined;
      if (!expectedChallenge || expectedChallenge !== record.codeChallenge) {
        return sendJson(res, 400, { error: "invalid_grant", error_description: "PKCE code_verifier mismatch" });
      }

      const nowSeconds = Math.floor(Date.now() / 1000);
      const idTokenClaims = {
        iss: ISSUER,
        aud: clientId,
        sub: record.claims.sub,
        iat: nowSeconds,
        exp: nowSeconds + 300,
      };
      if (record.claims.email !== undefined) idTokenClaims.email = record.claims.email;
      if (record.claims.email_verified !== undefined) idTokenClaims.email_verified = record.claims.email_verified;
      if (record.claims.name !== undefined) idTokenClaims.name = record.claims.name;
      idTokenClaims.nonce = record.nonce;

      const idToken = signIdToken(idTokenClaims);
      const accessToken = randomBytes(16).toString("hex");
      accessTokenClaims.set(accessToken, record.claims);

      return sendJson(res, 200, { access_token: accessToken, token_type: "bearer", id_token: idToken });
    }

    if (req.method === "GET" && pathname === "/jwks") {
      const jwk = publicKey.export({ format: "jwk" });
      return sendJson(res, 200, { keys: [{ ...jwk, kid: KID, use: "sig", alg: "RS256" }] });
    }

    if (req.method === "GET" && pathname === "/userinfo") {
      const authHeader = req.headers.authorization;
      const accessToken = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : undefined;
      const claims = accessToken ? accessTokenClaims.get(accessToken) : undefined;
      if (!claims) {
        return sendJson(res, 401, { error: "invalid_token" });
      }
      const body = { sub: claims.sub };
      if (claims.email !== undefined) body.email = claims.email;
      if (claims.email_verified !== undefined) body.email_verified = claims.email_verified;
      if (claims.name !== undefined) body.name = claims.name;
      return sendJson(res, 200, body);
    }

    return sendJson(res, 404, { error: "not_found" });
  } catch (err) {
    console.error("[fake-idp] unhandled error", err);
    if (!res.headersSent) sendJson(res, 500, { error: "server_error" });
  }
});

// 必須綁 0.0.0.0：同時要被 compose 網路內的 app 容器（issuer host `fake-idp`）與
// 發布出去的 `127.0.0.1:9400`（瀏覽器經 host-resolver-rules 打進來）打到，
// 綁 "localhost" 只聽得到容器內 loopback，兩邊都打不進來。
server.listen(PORT, "0.0.0.0", () => {
  console.log(`[fake-idp] listening on 0.0.0.0:${PORT}`);
});
