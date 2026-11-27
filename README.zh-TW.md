# Knotebook

[![Latest release](https://img.shields.io/github/v/release/sw-willie-wu/knotebook?sort=semver)](https://github.com/sw-willie-wu/knotebook/releases/latest)
[![CI](https://github.com/sw-willie-wu/knotebook/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/sw-willie-wu/knotebook/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[English](README.md) | 繁體中文

> 本文件為繁體中文（台灣）版，內容以英文版 [README.md](README.md) 為準，可能落後於英文版。文中連結的說明文件（docs/ 與 CHANGELOG）目前只有英文版。

**人與 AI agent 一起維護的團隊知識平台。** 自己架設、用自己的模型，agent 改了什麼都有紀錄，看得到、也能撤回。

團隊成員即時一起寫筆記、整理筆記。你已經在用的 AI 助理（Claude Code、Claude Desktop 或其他 MCP 用戶端）透過內建的 MCP 端點搜尋、讀取、編輯同一批筆記。agent 的修改會即時出現在每個開著這篇筆記的分頁裡；它對筆記內容的每次改動都記在該筆記的 AI 修改紀錄，通常可以還原。

![AI agent 透過 MCP 編輯一篇筆記，開著這篇筆記的同事即時看到內容改變，接著打開筆記的 AI 修改紀錄，把 agent 的修改還原](docs/images/agent-edit.gif)

用 `docker compose` 跑一個 app 容器加一個 PostgreSQL 資料庫，映像已經預先建好（linux/amd64 與 linux/arm64）。網頁介面有英文與繁體中文，也有淺色與深色主題。

**狀態**：最新版本為 v0.18.0（2026-11-22）。每個版本與附檔都在 [Releases](https://github.com/sw-willie-wu/knotebook/releases)；改了什麼、以及已在 `main` 但還沒發版的內容，見 [CHANGELOG](CHANGELOG.md)。

## 為什麼用 Knotebook

下面每套工具都有 Knotebook 不打算做的長處。Knotebook 適合這樣的團隊：筆記放在自己的伺服器上，人和 agent 都即時在上面編輯，agent 改過什麼都留有紀錄。

✅ 有　❌ 沒有　△ 部分（見表下說明）　— 不適用

| | Obsidian | Notion | HackMD | HedgeDoc | 本機 agent 記憶 | Knotebook |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| 筆記放在自己的電腦或伺服器 | ✅ | ❌ | △¹ | ✅ | ✅ | ✅ |
| 即時共同編輯 | ❌ | ✅ | ✅ | ✅ | ❌ | ✅ |
| 不管多少人都免費 | △² | ❌ | ❌ | ✅ | ✅ | ✅ |
| agent 能讀寫筆記 | ✅ | ✅ | ✅ | △³ | ✅ | ✅ |
| agent 每次修改都列出來，可以單筆還原 | △⁴ | △⁴ | △⁴ | △⁴ | △⁵ | ✅ |
| AI 可以接自己架的模型（含本機） | △⁶ | ❌ | ❌ | ❌ | — | ✅ |
| 離線可用，筆記就是本機檔案 | ✅ | ❌ | ❌ | ❌ | ✅ | ❌ |
| 資料庫（把表格當資料用） | △⁷ | ✅ | ❌ | ❌ | ❌ | ❌ |
| 外掛與關係圖 | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |

¹ 雲端服務；價目表把自架列在 Enterprise 方案。
² app 本身免費；共用 vault 要用 Sync，按人計費。
³ HTTP API 能建立與下載筆記，不能修改既有筆記。
⁴ 整篇筆記或整個檔案的版本歷史（Notion 會標出哪些是 AI 改的）：只能回到較早的版本，不能單獨撤回某一次修改。
⁵ 指 CLAUDE.md、memory 檔這類檔案：放在 git 裡的話，每個 commit 都能 revert。
⁶ 要靠社群外掛。
⁷ Bases 把筆記屬性做成資料庫式的檢視。

**Knotebook 怎麼做**

- **自己的伺服器**：用 `docker compose` 跑一個 app 容器加 PostgreSQL（[自行架設指南](docs/self-hosting.md)）。
- **共同編輯**：大家同時編輯，看得到彼此的游標，也知道還有誰開著這篇。
- **不限人數**：MIT 授權，沒有人數上限，也沒有授權門檻。
- **agent**：內建 MCP 端點，最多二十項工具；有 shell 的 agent 也能把筆記當 Markdown 檔讀寫（[MCP](docs/mcp.md)）。
- **agent 的修改**：每一筆都記在筆記的 AI 修改紀錄，通常可以單獨還原（[還原](docs/ai-editing.md#revert)）。
- **編輯器裡的 AI**：站台管理員可以透過 OpenAI 相容的 API 接上你自己架的模型（Ollama、vLLM 等），也可以接 Anthropic（[AI 快速動作](docs/ai.md)）。

沒有讓人註冊使用的雲端服務，你要自己架；就算裝成 app，也要連得到伺服器。目前僅能跑單一 `app` 容器（[單一實例警告](docs/self-hosting.md#single-instance-warning)）。

## 可以拿它做什麼

下面每一部分都分成「現在就能用」和「接下來要做」。「接下來要做」只是打算的方向，不保證一定會做，也沒有時程；進度記在 [issues](https://github.com/sw-willie-wu/knotebook/issues) 與 [milestones](https://github.com/sw-willie-wu/knotebook/milestones)。

### 一起寫、一起整理筆記

![兩個人同時編輯同一篇筆記，各自看得到對方的游標，對方打的字一打出來就出現](docs/images/coediting.gif)

**現在就能用**

- **區塊編輯器**：標題、清單、表格、引言、有語法上色的程式碼區塊、插入區塊用的 `/` 選單，以及打字時的 Markdown 快捷寫法；文字、背景與表格儲存格可以上色（內建九種顏色，或任選一種）；每篇筆記可設標準、寬或全寬。
- **即時共同編輯**：同一篇筆記上的每個人同時編輯（Yjs 與 Hocuspocus），看得到其他人的游標；筆記頁首顯示還有誰開著這篇，點某人的頭像會跳到他的游標。
- **筆記之間的連結**：打 `[[`，或貼上、拖入筆記網址；筆記改名後連結照樣有效，連結也可以指向單一段落，每篇筆記會列出提到它的筆記。
- **圖片與圖表**：PNG、JPEG、GIF、WebP、SVG 圖片，可以調整大小，計入筆記所屬空間的儲存方案；Mermaid 圖表以原始碼儲存（[圖表](docs/diagrams.md)）；兩者都能全螢幕放大檢視。
- **並排**：兩到四欄的並排，用 `/grid` 或把區塊拖到另一個區塊旁邊建立，拖分隔線調整欄寬（[並排](docs/columns.md)）。
- **標題導覽**：筆記右側一條細線，每個標題（H1 到 H3）一個刻度，滑過或點它列出標題，點一個就跳過去。視窗夠寬時，標準寬的筆記可以把導覽釘在文字旁；在手機或窄於 768 px 的視窗，捲動時會出現標出目前位置的泡泡，點它開啟清單，筆記 ⋮ 選單裡的「標題導覽」也能開啟。
- **知識資訊**：標題可以記下何時讀、一句結論、依據、最後驗證日，以及是否仍有效、待驗證或已過時，標題後面會有小狀態圖示；每個資料夾與空間各有一份索引（[知識資訊](docs/knowledge.md)）。
- **版本歷史**：編輯停手後自動存版，也可以手動存；預覽版本、左右並排比較兩個版本，或套用較舊的版本（[版本歷史](docs/versions.md)）。
- **簡報模式**：把筆記當簡報播放，每個標題是一張投影片；從筆記或它的公開連結都能播。
- **搜尋**：側邊欄依標題與內文找筆記，可以用空白分開多個關鍵字或用引號包住片語，並在符合的段落開啟筆記；REST API 與 MCP 的搜尋也一樣，另外可以改成任一關鍵字符合（[MCP](docs/mcp.md#search_notes)）。
- **資料夾、最愛、標籤與垃圾桶**：資料夾最多五層，可以建在你的筆記與每個群組裡，在「與我共享」裡也能建只有你看得到的資料夾，用**移動到…**、一次選取多篇，或用滑鼠拖曳把筆記放進去（[資料夾](docs/sharing.md#folders)）；最愛只有你自己看得到（[最愛](docs/sharing.md#favorites)）；標籤用來標記筆記，顯示在內文上方，側邊欄有色點與篩選（[標籤](docs/sharing.md#tags)）；刪除的筆記在垃圾桶保留 7 天，站台管理員可以改天數或關閉自動刪除（[垃圾桶中的筆記](docs/sharing.md#notes-in-the-trash)）。
- **分享與群組**：個人筆記可以維持私人、分享給指定的人編輯或檢視，或以唯讀的公開連結發布，公開連結可以設自訂網址（[分享](docs/sharing.md)）；群組擁有自己的筆記，成員能做什麼取決於角色，可以是內建的（管理員、一般成員）或自訂的（[群組中的筆記](docs/sharing.md#notes-in-a-group)）。

**接下來要做**

- 除了圖片，也能上傳音訊、影片與文件（[#249](https://github.com/sw-willie-wu/knotebook/issues/249)）；AI 可以引用的參考資料庫（[#71](https://github.com/sw-willie-wu/knotebook/issues/71)）。
- 匯入 Obsidian vault、Notion 匯出檔或 Markdown 檔，`[[連結]]` 轉成筆記之間的連結。

### 讓 agent 和人一起改同一批筆記

**現在就能用**

- **MCP 端點**：`/api/mcp` 提供 Claude Code、Claude Desktop 與其他 MCP 用戶端最多二十項工具，可以搜尋、逐段讀取、建立、編輯、改名、複製與搬移筆記，管理資料夾，把筆記移到垃圾桶與還原，以及讀取圖片（[MCP](docs/mcp.md)）。
- **以檔案讀寫筆記**：用 `open_notes_as_files`，有 shell 的 AI 助理可以把大量筆記下載成 Markdown 檔，再把改過的檔案送回；伺服器只寫入檔案改到的部分（[MCP](docs/mcp.md#open_notes_as_files)）。
- **agent 讀寫知識資訊與標籤**：知識資訊是每個標題底下的一則註解，agent 可以讀也可以寫；標籤則透過檔案的 `tags:` 行設定（[AI 編輯](docs/ai-editing.md#knowledge-info)）。
- **API token 與 OAuth**：可設權限範圍的個人 API token，或透過 OAuth 授權的應用程式（除非你允許更多，否則只能讀取）（[API token](docs/api-tokens.md)）。**設定 → 授權 → 用 MCP 連接 Claude** 會列出你這台伺服器可以直接貼上的設定。
- **編輯器裡的 AI 快速動作**：選取文字後執行改寫（Rewrite）、翻譯（Translate）、摘要（Summarize）、續寫（Continue writing）或指示（Instruct，照你輸入的指示做），結果以行內差異顯示，由站台管理員設定的供應商串流回傳：任何 OpenAI 相容的 API（包括本機的 Ollama）或 Anthropic。管理員設定好供應商之前，什麼都不會送出；管理員也可以改名、停用或新增動作（[AI 快速動作](docs/ai.md)）。
- **REST API**：網頁介面建立在一套你也可以直接呼叫的 REST API 上，包括逐段讀寫筆記內容（[AI 編輯](docs/ai-editing.md)、[API 規格摘要](docs/api.md)）。

**接下來要做**

- 給 agent 的搜尋先回索引行（何時讀、結論、最後驗證日），agent 只要讀最相關的一兩篇。
- 寫回：agent 把新的結論放進待整理的地方，或對既有筆記提出修改建議。
- 語意檢索（[#92](https://github.com/sw-willie-wu/knotebook/issues/92)）。
- 留言、@提及（也能 @ agent）與通知（[#289](https://github.com/sw-willie-wu/knotebook/issues/289)）。
- 內建 agent 與 app 內的對話（[#264](https://github.com/sw-willie-wu/knotebook/issues/264)、[#118](https://github.com/sw-willie-wu/knotebook/issues/118)）。

### agent 改了什麼，看得到也撤得回

**現在就能用**

- **AI 修改紀錄**：透過 API 或 MCP 改動筆記內容的寫入，會即時出現在已開啟的分頁，並記在該筆記的 AI 修改紀錄（在筆記的 ⋮ 選單），寫明用誰的帳號、哪個 agent 名稱改的。每篇筆記最多保留最近 100 筆 AI 修改；只要它寫入的那部分還沒被再改過，通常都能還原。筆記改名與建立筆記不會記錄（[還原](docs/ai-editing.md#revert)）。
- **agent 會出現在筆記裡**：用 token 或已授權的應用程式連進來的 agent，讀寫一篇有人開著的筆記時，會以游標出現，標籤是你的使用者名稱加上 agent 名稱，筆記頁首的在線名單也會把它列成 AI agent（[在線狀態](docs/ai-editing.md#presence)）。每個憑證的 agent 名稱都可以自己改（[agent 顯示名稱](docs/ai-editing.md#agent-display-name)）。
- **版本歷史**列出兩個版本之間改過筆記的人；agent 的修改顯示為那個人的名字，後面括號加上 agent 名稱（[版本歷史](docs/versions.md)）。
- **權限分級**：token 或應用程式可以只讀，也可以編輯；把筆記移入群組（無法復原）和把筆記移到垃圾桶（可以還原）是另外兩項權限，每個憑證分別開啟，token 的權限之後也能再改（[變更 token 權限](docs/api-tokens.md#changing-a-tokens-access)）。
- **筆記快照**：伺服器會定期保存筆記內容的快照，並有操作手冊說明如何從快照或 `pg_dump` 還原筆記（[從備份還原筆記內容](docs/backup-restore.md)）。

**接下來要做**

- **建議模式**：agent 的修改先成為建議，由人逐段接受或拒絕。
- **agent 動態總覽**：一頁看完一段期間內哪個 agent 或 token 改了哪些筆記，並能整批還原。
- **agent 有自己的身分**：每個 agent 有自己的名字與頭像，出現在在線名單與紀錄裡。

### 沒人盯著，筆記也能保持最新

**現在就能用**

- 還沒有。agent 只在有人叫它時才動作。

**接下來要做**

- **排程健檢**：找出斷掉的連結、太久沒驗證的筆記、互相矛盾與重複的頁面，開成待辦或建議。
- **事件觸發**：筆記被修改、被 @、有新上傳時叫 agent 出來處理。
- **把工作過程整理成筆記**：把一段對話或工作紀錄整理成帶知識資訊的筆記。

## 架站的人用得到的

- **Docker Compose**：app 加上內建的 PostgreSQL，或改用你自己的 PostgreSQL（[自行架設指南](docs/self-hosting.md)）。
- **登入**：帳號密碼，以及任意數量的 OpenID Connect 身分提供者（GitLab、Google 或其他），可設成首次登入時自動建立帳號，或設成唯一的登入方式；帳號密碼自行註冊（除非站台管理員關閉，否則開著）、邀請連結與一次性的密碼重設連結（[登入服務](docs/self-hosting.md#sign-in-providers)、[帳號](docs/self-hosting.md#accounts)）。
- **頭貼**：上傳並裁切自己的照片，或使用身分提供者給的照片；它會顯示在你的帳號按鈕、筆記頂端的頭像，以及群組成員等清單裡你的名字旁邊。
- **容量上限**：每個個人空間與群組都屬於一個儲存方案，可以限制附件的總大小（[容量上限](docs/self-hosting.md#storage-quotas)）。
- **站台管理**：使用者、群組、登入服務、儲存方案、AI 供應商，以及 17 項不必重啟伺服器就生效的限制（上傳大小、筆記大小、請求頻率等）（[站台限制](docs/self-hosting.md#site-limits)）。
- **手機版面**：視窗窄於 640 px 時，筆記清單就是首頁，筆記從右側滑入疊在清單上，對話框與選單從底部升起，螢幕鍵盤上方有編輯工具列；640 到 1279 px 時側邊欄是抽屜（[已知限制](docs/known-limitations/phone.md)）。
- **安裝成 app**：把 Knotebook 加到手機或電腦的主畫面，或從 Chrome、Edge 安裝；和瀏覽器分頁一樣，它要連得到伺服器（[把 Knotebook 安裝成 app](docs/install-app.md)）。
- **說明與功能導覽**：使用者選單的**說明**，或 Ctrl+/（Mac 為 ⌘/），會開啟在示範筆記上進行的功能導覽、這一版新增，以及快捷鍵（[說明與功能導覽](docs/feature-tour.md)）。

![Knotebook 的一篇筆記：左邊是含資料夾的側邊欄，右邊是含表格與 Mermaid 圖的筆記，頁首有兩位共編者的頭像，內文裡有他們的游標](docs/images/editor.png)

![筆記頁首有 Bob 與 Carol 的頭像，以及「Bob · Editor, Click to go to their cursor」的提示，筆記的清單裡有他們兩人的游標](docs/images/presence.png)

<p align="center"><img src="docs/images/phone.png" alt="手機上的 Knotebook：含資料夾的筆記清單，以及標題下方顯示所在位置的一篇筆記" width="640"></p>

## 快速上手

你需要裝有 Compose 的 Docker。以下會讓 Knotebook 跑在 `http://localhost:3000`。

1. 在空目錄下載最新 Release 的 compose 檔與範例設定：

   ```sh
   curl -fLO https://github.com/sw-willie-wu/knotebook/releases/latest/download/docker-compose.yml
   curl -fL -o .env https://github.com/sw-willie-wu/knotebook/releases/latest/download/env.example
   ```

   （要從原始碼 build 或跑 `main`，改用 `git clone https://github.com/sw-willie-wu/knotebook.git`、`cd knotebook` 與 `cp .env.example .env`。）

2. 在 `.env` 填入四個值：

   - `APP_SECRET`：至少 64 個十六進位字元，例如 `openssl rand -hex 32` 的輸出。
   - `PUBLIC_URL=http://localhost:3000`
   - `ADMIN_EMAIL` 與 `ADMIN_PASSWORD`（至少 12 個字元）：第一個管理員帳號。資料庫是空的、又沒設這兩項時，伺服器不會啟動；它們只在第一次初始化時生效。

3. 啟動後開啟 `http://localhost:3000`，以 `ADMIN_EMAIL` 與 `ADMIN_PASSWORD` 登入：

   ```sh
   docker compose up -d
   ```

跑哪個映像：用 Release 附的 `docker-compose.yml` 就跑該版，用 repo 裡的則是 `latest`；在 `.env` 設 `KNOTEBOOK_VERSION` 可以鎖定版本（用 clone 時建議這樣做）。在 clone 裡執行 `docker compose up -d --build` 則改從原始碼 build（[App 映像](docs/self-hosting.md#the-app-image)）。

想試共同編輯，從使用者選單開啟**站台管理 → 使用者**，用**建立邀請**產生連結，在無痕視窗打開連結建立第二個帳號，再把筆記分享給它。

**升級**：先讀新版在 [CHANGELOG](CHANGELOG.md) 裡的升級說明，說要備份就先備份。接著用新版的 `docker-compose.yml` 取代舊檔（或更新你的 clone），有設 `KNOTEBOOK_VERSION` 就改成新版本，再執行 `docker compose pull` 與 `docker compose up -d`（[升級與回滾](docs/self-hosting.md#upgrading-and-rolling-back)）。

### 接上 agent

1. 在 Knotebook 開啟**設定 → 授權 → 用 MCP 連接 Claude**，上面有你這台伺服器的端點與可以直接貼上的指令。
2. 伺服器是 `https://` 時，Claude Code 可以用 OAuth 授權，不必建 token：

   ```sh
   claude mcp add -s user -t http knotebook https://<your-host>/api/mcp
   ```

   接著在 Claude Code 輸入 `/mcp`，選 **knotebook**，再選 **Authenticate**。要讓 agent 能寫入，在授權頁勾選「建立與修改筆記」（Create and edit notes）。
3. 伺服器是純 `http://` 時，改建個人 API token，用 header 帶上：

   ```sh
   claude mcp add -s user knotebook http://<your-host>/api/mcp -t http -H "Authorization: Bearer knb_…"
   ```

Claude Desktop 與其他用戶端怎麼接、每項工具做什麼，見 [MCP](docs/mcp.md)。要用編輯器裡的 AI 快速動作，站台管理員先在**站台管理 → AI 代理**新增供應商與模型（[AI 快速動作](docs/ai.md)）。

## 部署到 localhost 以外之前

要在 `localhost` 以外的地方跑，請先讀完整的 [自行架設指南](docs/self-hosting.md)。重點如下：

- **只能跑單一 `app` 容器。**`docker compose up --scale app=N` **不支援**。即時協作的狀態（Yjs/Hocuspocus）放在伺服器記憶體裡，實例之間沒有同步，所以橫向擴充會讓同一篇筆記的編輯在各實例間**悄悄分歧**，不會合併。見 [單一實例警告](docs/self-hosting.md#single-instance-warning)。
- **`PUBLIC_URL` 必填**，而且要選定一種架構：**(a)** 可信任區域網路內的純 http，帳密與 session cookie 以明文傳輸，只適合你信任網路上每一台主機的環境；或 **(b)** 反向代理加 TLS，其他情況（包括公開網際網路）都用這種。完整的取捨、`/collab` 必須轉送 WebSocket，以及在代理後方執行時必須設定的 `TRUST_PROXY`，見 [部署前提](docs/self-hosting.md#deployment-prerequisites)。

## 文件

寫筆記的人：

- [分享](docs/sharing.md)：私人、分享與公開的筆記，群組與角色，把筆記移入或複製到群組，資料夾、最愛、標籤與垃圾桶。
- [知識資訊](docs/knowledge.md)：標題上的何時讀、結論、依據、最後驗證日與狀態，以及索引。
- [版本歷史](docs/versions.md)：版本何時儲存，預覽、比較與套用版本，誰看得到、保留多久。
- [並排](docs/columns.md)：建立、調整、拆除、複製與撤銷並排。
- [圖表（Mermaid）](docs/diagrams.md)：插入、編輯、貼上與複製出 Mermaid 圖表。
- [說明與功能導覽](docs/feature-tour.md)：說明視窗、功能導覽、「這一版新增」頁與快捷鍵。
- [把 Knotebook 安裝成 app](docs/install-app.md)：在 Android、iPhone 與 iPad 加到主畫面，以及在電腦上安裝。
- [值得先知道的限制](docs/limitations.md)：部署 Knotebook 或把筆記交給它之前該知道的事，包括資料可能遺失之處、無法復原的操作、安全上的取捨與尚未提供的功能。
- [已知限制](docs/known-limitations.md)：已知的粗糙之處與刻意取捨的完整清單。

接上 AI 與腳本：

- [MCP](docs/mcp.md)：連接 MCP 用戶端、每項工具收什麼與回什麼、讀寫流程、限制與錯誤。
- [API token](docs/api-tokens.md)：建立、使用與撤銷個人 API token，以及改用 OAuth 授權應用程式。
- [AI 編輯](docs/ai-editing.md)：透過 API 讀寫筆記內容，包括段落、指紋、五種寫入操作、還原與 Markdown 格式。
- [API 規格摘要](docs/api.md)：每個端點的驗證方式、請求內容與錯誤碼。

架設伺服器：

- [自行架設指南](docs/self-hosting.md)：部署前提、反向代理與 TLS、環境變數、站台限制、登入服務、帳號、容量上限、App 映像、升級與回滾，以及疑難排解。
- [AI 快速動作](docs/ai.md)：在**站台管理 → AI 代理**設定 AI 供應商、模型與動作，以及這些動作在編輯器裡的行為。
- [從備份還原筆記內容](docs/backup-restore.md)：從快照或 `pg_dump` 還原筆記內容。

貢獻者與維護者：

- [參與貢獻](CONTRIBUTING.md)：開發環境設定、送出前要通過的檢查與專案慣例（英文）。
- [架構導覽](ARCHITECTURE.md)：程式碼地圖，從伺服器、即時協作到前端與測試（英文）。
- [在本機跑 e2e 測試](docs/e2e-local.md)：在 WSL 裡對一套用完即丟的 Docker Compose 環境跑 Playwright 測試，以及同時跑好幾套。
- [發版流程](docs/releasing.md)：用 `pnpm release:prepare` 準備發版 PR，以及 merge 後 Release workflow 自動做的事。
- [CHANGELOG](CHANGELOG.md)：每個版本與升級說明。

## 參與貢獻

問題回報與功能建議請開在 [issue tracker](https://github.com/sw-willie-wu/knotebook/issues)；規劃記在 [GitHub Milestones](https://github.com/sw-willie-wu/knotebook/milestones)。歡迎發 pull request；在本機跑端對端測試的方式見 [在本機跑 e2e 測試](docs/e2e-local.md)。第一次發 pull request 之前，請先讀 [CONTRIBUTING.md](CONTRIBUTING.md)（英文）。

## 商標

GITLAB is a trademark of GitLab Inc. in the United States and other countries and regions. Google is a trademark of Google LLC.

Knotebook 與 GitLab、Google 沒有隸屬關係，也未獲其背書。登入服務範本只用到這兩個名稱，內建不含任何廠商的標誌；管理員可以自行上傳。

## 授權

MIT，見 [LICENSE](./LICENSE)。隨附的第三方元件（一個字型資源、jsdiff、BlockNote）各有自己的授權，見 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。
