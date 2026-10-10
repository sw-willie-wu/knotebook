# Knotebook

[English](README.md) | 繁體中文

> 本文件為繁體中文（台灣）翻譯版，內容以英文版 [README.md](README.md) 為準，翻譯可能落後於英文版。文中連結的說明文件（docs/ 與 CHANGELOG）目前只有英文版。

Knotebook 是一套開源、可自行架設的 Notion/HackMD 風格協作筆記系統，內建可自備端點的 AI。

三項不可妥協的原則：

- **沒有人數上限**——自行架設給一個人或一千個人用都可以，沒有授權門檻。
- **即時 CRDT 協作**——以 Yjs 為基礎的多人同步編輯，不是付費附加功能。
- **自備 AI 端點**——把 Knotebook 指向你自己的 OpenAI 相容或 Anthropic 端點（包含本機／機房內的 Ollama），不綁定任何供應商。

**狀態**：最新版本為 v0.8.0（2026-10-10）。目前具備的功能：

- **一起寫作**——區塊編輯器，支援即時多人編輯（Yjs/Hocuspocus）、附反向連結的 `[[wikilinks]]`、圖片上傳，以及 Mermaid 圖表（見 [圖表](docs/diagrams.md)）。
- **版本歷史**——每篇筆記都保留版本，可自動儲存（停止編輯數分鐘後、所有人離開時、AI 與 API 寫入前後）或手動儲存；任兩個版本可左右並排比較，也可套用某個版本還原舊狀態；有保留規則，並有三層開關（全站、自己的筆記、群組）可關閉自動儲存（見 [版本歷史](docs/versions.md)）。
- **簡報模式**——把任何一篇筆記當簡報播放：標題自動切成投影片、封面是筆記標題，已登入的觀眾會即時看到共編者的修改（見 [已知限制](docs/known-limitations.md)）。
- **帳號**——密碼登入，以及透過任意數量的 OpenID Connect 身分提供者（GitLab、Google 或其他提供者）登入，也可以設成只能透過這些登入服務登入；除非站台管理員關閉註冊，否則使用者可以自行註冊，也可以把多個登入服務連結到同一個帳號。站台管理員在專屬的**站台管理**頁面（`/admin/users`、`/admin/auth`、`/admin/ai`）管理使用者、登入服務（含其圖示）與 AI 供應商——見 [登入服務](docs/self-hosting.md#sign-in-providers) 與 [帳號](docs/self-hosting.md#accounts)。
- **分享**——個人筆記可以維持私人、分享給指定的人編輯或檢視，或以唯讀的公開連結發布（見 [分享](docs/sharing.md)）。
- **群組**——群組擁有自己的筆記，網址為 `/g/<group id>/<name>`；每位成員能做什麼取決於其在群組中的角色——內建的「管理員」與「一般成員」角色，或由六項權限組成的自訂角色。個人筆記可以移入或複製到群組；刪除群組時，可以把群組的筆記轉交給其中一位管理員，或連同群組一併刪除（見 [群組中的筆記](docs/sharing.md#notes-in-a-group)）。
- **容量上限**——每個個人空間與每個群組都屬於一個儲存方案，可以限制附件的總大小（或不設上限）；站台管理員在**站台管理 → 儲存方案**管理方案與指派，使用者在**設定 → 帳號**看到自己的用量（見 [容量上限](docs/self-hosting.md#storage-quotas)）。
- **AI 快速動作**——改寫、翻譯、摘要與續寫，由管理員設定的 OpenAI 相容或 Anthropic 端點以串流方式回傳（見 [AI 快速動作](docs/ai.md)）。
- **讓你自己的 AI 讀寫筆記**——個人 API token，或透過 OAuth 授權的應用程式，都可以讀寫筆記內容；改動筆記內容的寫入會即時顯示在已開啟的分頁中，並記錄在該筆記的 AI 修改紀錄裡，可以還原（見 [API token](docs/api-tokens.md) 與 [AI 編輯](docs/ai-editing.md)）。位於 `/api/mcp` 的 MCP 端點提供十項工具，讓 Claude Code、Claude Desktop 與其他 MCP 用戶端可以搜尋、讀取、編輯與建立筆記（包含群組筆記），以及傳入、傳出圖片（見 [MCP](docs/mcp.md)）。

以上全部都建立在一套你也可以直接操作的 REST API 之上（見 [API 規格摘要](docs/api.md)），並且有 Playwright 測試套件做端對端測試。升級到 0.8.0 會執行資料庫 migration（筆記版本），並為整個站台開啟自動筆記版本——請先備份，並閱讀 [0.8.0 升級說明](CHANGELOG.md#080---2026-10-10)。（從 0.6.x 跳升？0.7.0 的 [升級說明](CHANGELOG.md#070---2026-10-09) 也適用：所有既有使用者與群組會被放進預設 2 GiB 的儲存方案。從 0.5.x 跳升？0.6.0 的 [升級說明](CHANGELOG.md#060---2026-10-08) 也適用：SSO 設定會從 `.env` 移到**站台管理 → 登入**，並且預設開放自行註冊。）

## 快速上手（約 10 分鐘）

這會用 `docker compose` 啟動伺服器與 Postgres 資料庫；第一個（管理員）帳號會在啟動時由環境變數建立——沒有瀏覽器內的初始設定步驟。

1. 複製範例環境檔：

   ```sh
   cp .env.example .env
   ```

2. 產生 `APP_SECRET`（用來簽署 session cookie 與協作 token，以及加密已儲存的 AI 供應商憑證——見 [AI 快速動作](docs/ai.md)），然後填入 `.env`：

   ```sh
   openssl rand -hex 32
   ```

   把輸出貼到 `.env` 中，寫成 `APP_SECRET=...`。

3. 在 `.env` 中設定 `PUBLIC_URL`。本機使用時：

   ```
   PUBLIC_URL=http://localhost:3000
   ```

4. 在 `.env` 中設定 `ADMIN_EMAIL` 與 `ADMIN_PASSWORD`——這會在啟動時建立第一個（管理員）帳號。`ADMIN_PASSWORD` 必須至少 12 個字元。這是初始化全新實例的唯一方式：資料庫是空的、又沒有設定這兩項時，伺服器會拒絕啟動（見 `.env.example` 與 [已知限制](docs/known-limitations.md)——它只在第一次初始化時生效）。

5. 啟動整套服務（`app` 與 `db` 兩個服務；若要在正式環境進行，請先閱讀 [部署前提](docs/self-hosting.md#deployment-prerequisites)）：

   ```sh
   docker compose up -d
   ```

6. 在瀏覽器開啟 `http://localhost:3000`，以 `ADMIN_EMAIL`/`ADMIN_PASSWORD` 登入。你會直接登入成功——這個帳號不會被強制更改密碼。之後可以在**設定 → 帳號**變更密碼。

7. 建立一篇筆記，並在區塊編輯器中開啟。想試試即時共同編輯，請開啟**站台管理 → 使用者**（`/admin/users`；**站台管理**在使用者選單中——你是管理員）建立第二個帳號，再用另一個瀏覽器或無痕視窗登入該帳號，把筆記分享給這個帳號，然後觀察編輯內容即時同步。註冊開啟時（預設為開啟；可在**站台管理 → 登入**關閉），使用者也可以在 `/register` 自行建立帳號，或第一次透過登入服務登入時取得帳號——見 [帳號](docs/self-hosting.md#accounts)。

如果你想直接操作 API，而不是在瀏覽器裡點選——例如要用腳本跑完整個流程，或打造另一個用戶端——同樣的登入端點也能用 `curl` 呼叫；完整的端點清單見 [API 規格摘要](docs/api.md)。流程是：`.env` 中的 `ADMIN_EMAIL`/`ADMIN_PASSWORD` → `POST /api/auth/login` → 帶著登入狀態的 API 呼叫，session cookie 的帶法與瀏覽器相同。

## 部署到 localhost 以外之前

要在 `localhost` 以外的地方執行之前，請先閱讀完整的 [自行架設指南](docs/self-hosting.md)——簡單來說：

- **只能執行單一 `app` 容器。**`docker compose up --scale app=N` **不受支援**。即時協作的狀態（Yjs/Hocuspocus）存放在伺服器記憶體中，不同實例之間沒有同步機制，所以橫向擴充會讓同一篇筆記的編輯在各實例之間**悄悄分歧**，而不是合併。見 [單一實例警告](docs/self-hosting.md#single-instance-warning)。
- **`PUBLIC_URL` 為必填**，而且你必須選定一種拓撲：**(a)** 可信任區域網路內的純 http——帳密與 session cookie 以明文傳輸，只適用於你信任網路上每一台主機的環境；或 **(b)** 反向代理加 TLS，其他情況（包含公開網際網路）都用這種。完整的取捨、`/collab` 需要轉送 WebSocket 的要求，以及在代理後方執行時必須設定的 `TRUST_PROXY`，見 [部署前提](docs/self-hosting.md#deployment-prerequisites)。

## 文件

- [自行架設指南](docs/self-hosting.md)——部署前提、compose 服務／volume、反向代理與 TLS、區域網路純 http 模式、環境變數參考、登入服務（OIDC/SSO）及其在 GitLab 與 Google 上的設定、帳號與註冊、僅限 SSO 登入及其復原開關、內容安全政策（CSP）、升級／回滾，以及疑難排解。
- [API 規格摘要](docs/api.md)——完整的端點表，含驗證需求與錯誤碼。
- [API token](docs/api-tokens.md)——供腳本與 AI 助理使用的個人 API token，目前可以讀寫筆記內容：建立、使用（`Authorization: Bearer`）、哪些端點接受它們、速率限制、撤銷，以及為什麼變更密碼不會撤銷它們；另外還有 MCP 用戶端如何透過 OAuth 自行取得授權，而不是使用貼上的 token。
- [AI 編輯](docs/ai-editing.md)——token 或已授權的應用程式所使用的筆記內容讀寫 API：五種寫入操作、指紋與衝突處理、還原某次寫入、協作游標（presence）與 AI agent 的顯示名稱，以及速率限制與錯誤碼。
- [MCP](docs/mcp.md)——連接 MCP 用戶端（確切的 `claude mcp add` 與 `mcp-remote` 指令）、十項工具各自能回答什麼、讀寫流程、MCP 本身的限制與錯誤格式，以及其已知限制。
- [分享](docs/sharing.md)——個人筆記的三種存取層級（私人／成員／公開連結）、群組中的筆記以及各角色權限允許的操作、把筆記移入或複製到群組、公開唯讀連結授予什麼，以及撤銷與重新產生的行為。
- [版本歷史](docs/versions.md)——筆記的版本何時儲存、預覽／比較與套用版本、誰看得到、自動版本保留多久，以及關閉自動版本的三個開關。
- [AI 快速動作](docs/ai.md)——管理員設定指南（位於**站台管理 → AI**），涵蓋 AI 供應商／模型／動作、金鑰加密，以及快速動作在編輯器中的行為。
- [圖表（Mermaid）](docs/diagrams.md)——插入、編輯與貼上 Mermaid 圖表、把圖表複製出去會得到什麼，以及其背後的隨需載入與渲染安全鎖定機制。
- [已知限制](docs/known-limitations.md)——已知的粗糙之處與刻意取捨的完整清單。
- [從備份還原筆記內容](docs/backup-restore.md)——從快照或 `pg_dump` 還原 `note_states` 的操作手冊。
- [CHANGELOG](CHANGELOG.md)。

## 路線圖

v0.1 的五個里程碑——API 基礎、具備即時協作的網頁介面、wikilinks 與圖片上傳、AI 快速動作，以及 OIDC 登入——都已推出，接著是一次強化版本（0.2）、介面大改版、Mermaid 圖表、易讀的筆記網址與公開分享連結（0.3.x）、讓你接上自己 AI 的 API token、OAuth 與 MCP（0.4.x）、群組（0.5），多個登入服務與自行註冊（0.6），容量上限與簡報模式（0.7），以及筆記版本歷史（0.8）；歷程見 [CHANGELOG](CHANGELOG.md)。

規劃記錄在 [GitHub Milestones](https://github.com/sw-willie-wu/knotebook/milestones) 與 issue tracker 中，工作排定時就會隨之更新。

## 授權

MIT——見 [LICENSE](./LICENSE)。隨附的一個字型資源有其自己的授權——見 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。
