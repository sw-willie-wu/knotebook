/**
 * e2e 疊對外的埠。預設 3100（app）／9400（fake-idp），跟 CI 一致；本機同時跑多組時由
 * `scripts/test-e2e.sh` 挑空埠並以環境變數傳進來（`E2E_PORT`、`E2E_IDP_PORT`），
 * `docker-compose.e2e.yml` 讀同一組變數。
 */
export const APP_PORT = Number(process.env.E2E_PORT || 3100);
export const IDP_PORT = Number(process.env.E2E_IDP_PORT || 9400);
/** e2e 疊的 origin（Playwright 的 baseURL、cookie 寫入請求的 Origin、剪貼簿權限的 origin）。 */
export const E2E_ORIGIN = `http://localhost:${APP_PORT}`;
/** fake-idp 發布到本機的 origin（`request` fixture 不吃瀏覽器的 host-resolver-rules，control endpoint 走這）。 */
export const IDP_CONTROL_ORIGIN = `http://localhost:${IDP_PORT}`;
