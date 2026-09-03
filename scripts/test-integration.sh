#!/usr/bin/env bash
# scripts/test-integration.sh
#
# 整合測試（DB migration 等）需要真的連到 Docker daemon 起 testcontainers。
# 本機環境：Windows 上沒有 docker，docker 只存在於 WSL；而且這份 repo 若留在原地
# （Windows 檔案系統，WSL 看到的 /mnt/c/...）在 WSL 內對它跑 pnpm install / vitest，
# 會落入 9p 掛載的極慢 I/O ——實測 `pnpm install` 卡 10 分鐘以上還沒解完依賴；
# 把同一份 lockfile 換到 WSL 原生 ext4（$HOME 底下）再裝，2 秒內完成。
#
# 這支腳本把「單向同步到 WSL 原生路徑 → 裝依賴 → 跑整合測試」串成一個原子操作，
# 目的是讓「忘記先同步、直接在 WSL 那份 mirror 裡改東西」這種事物理上不會發生：
# 每次執行都用 `rsync --delete` 覆蓋 ~/knotebook，任何只存在於 ~/knotebook、
# 不存在於這份 Windows repo 的修改都會被蓋掉、憑空消失。
#
# ⚠️ 禁止在 WSL 的 ~/knotebook 內直接編輯任何檔案——單向同步會覆蓋，改動不會被保留。
#    要改程式碼一律在 Windows 這邊的 repo（這支腳本所在的這份）改，然後重跑本腳本。
#
# 用法（在 Windows 側的 Git Bash / 任何能呼叫 `wsl` 的 shell 執行）：
#   bash scripts/test-integration.sh              # 跑 apps/server 的 test:integration
#   bash scripts/test-integration.sh test          # 改跑 apps/server 的 test（unit+integration 全套）
#
# 之後整合測試檔變多、要跑其他 vitest 檔案時，去改 apps/server/package.json 的
# `test:integration` script（glob），不要在這支腳本裡硬編路徑。

set -euo pipefail

# Git Bash（MSYS）預設會把看起來像 POSIX 路徑的參數（例如 /mnt/c/...）自動轉成
# Windows 路徑再傳給 wsl.exe，導致路徑被錯誤地加上 Git 安裝目錄前綴。關掉這個自動轉換。
export MSYS_NO_PATHCONV=1

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Git Bash 的 pwd 是 /c/Users/... 這種格式；WSL 看同一個磁碟要走 /mnt/c/Users/...
WSL_SRC="$(echo "$REPO_ROOT" | sed -E 's#^/([A-Za-z])/#/mnt/\L\1/#')"
PNPM_SCRIPT="${1:-test:integration}"

echo "[test-integration] src(WSL)=$WSL_SRC  dest(WSL)=\$HOME/knotebook  script=$PNPM_SCRIPT"

# ── WSL 的 ephemeral port 只有 301 個：跑測試前必須讓 TIME_WAIT 的 port 可以被重用 ──
#
# 症狀：整合測試會隨機有 1~2 個檔案、3~5 個測試炸 `Error: read ECONNRESET`（errno -104），
# 位置永遠在 `freshDb()` 的 `CREATE DATABASE` 或緊接著的 migration。每次中獎的檔案都不同，
# 且與測試內容完全無關——因為這根本不是程式的問題，是本機 WSL 把 TCP port 用光了。
#
# 成因鏈（實測確認，逐環有數據）：
#   1. `%USERPROFILE%\.wslconfig` 用 `networkingMode=mirrored`。鏡像模式下 WSL 為了不跟
#      Windows 端已保留的 port 打架，會把 Linux 的 ephemeral port range 縮到極窄：
#      `net.ipv4.ip_local_port_range = 60700 61000`——**總共只有 301 個 port**
#      （一般 Linux 預設是 32768-60999，28232 個）。
#   2. WSL 內的 `/etc/docker/daemon.json` 設了 `"iptables": false`，於是 docker 不建 DNAT
#      規則，所有 published port 的流量一律由 userland 的 `docker-proxy` 中繼：它 accept
#      我們的連線後，還要**自己再往 container 的 bridge IP 撥一條**，也吃掉一個 ephemeral port。
#      → 每條 postgres 連線消耗 2 個 port（我們→proxy 是 loopback，proxy→container 是 bridge）。
#   3. `net.ipv4.tcp_tw_reuse` 預設是 `2`＝**只有 loopback** 的 TIME_WAIT port 可以被重用。
#      proxy→container 那條走 bridge、不是 loopback，於是那些 port 得整整卡 60 秒才會釋放。
#   4. 這套整合測試每個 `it` 都會 `freshDb()`（開 admin pool 下 CREATE DATABASE、再開一個
#      pool 跑 migration），152 個測試在約 12 秒內開掉數百條 postgres 短連線。
#      可持續速率只有 301 port / 60 秒 ≈ 5 條/秒，實際需求約 30 條/秒——必爆。
#      （這也是為什麼「改成完全序列執行」救不了：序列化只是把同樣的連線數拉長到一樣超標的速率。）
#   5. Port 一用完，`docker-proxy` 往 container 撥號時拿不到 source port（EADDRNOTAVAIL），
#      它就把已經 accept 的那條 client 連線直接 RST 掉 → node 這端看到的就是 `read ECONNRESET`。
#      同一個 pool 也會讓 docker 自己配 published port 失敗，dockerd journal 會出現
#      `bind: address already in use` 而讓 testcontainers 的 ryuk 起不來，是同一個病的另一個症狀。
#
# 實測數據（每秒取樣 ephemeral range 內的 distinct local port 數）：
#   tcp_tw_reuse=2 → 尖峰 301/301（整個 range 被 TIME_WAIT 佔滿）→ 3 個測試炸 ECONNRESET
#   tcp_tw_reuse=1 → 尖峰 157/301（TIME_WAIT 的 port 可回收）→ 152/152 全綠
#   來回切換 sysctl 各驗一次，紅綠跟著切換，確認是因果而非相關。
#
# 解法：把 `tcp_tw_reuse` 從 2 放寬到 1，讓**所有**（不只 loopback）outbound 連線都能重用
# TIME_WAIT 的 port。同時連線數尖峰實測只有 ~27 條，301 個 port 綽綽有餘。
# 這個值只影響「主動連出去」的 connect()，且需要 TCP timestamps（本機已開）才會生效，
# 是處理 ephemeral port 耗盡的標準做法；真正危險而被 kernel 4.12 移除的是 `tcp_tw_recycle`，
# 不是這個。
#
# 為什麼在這裡做而不是改測試碼：這是本機 WSL 的環境限制，不是測試的問題。任何「少開幾條
# 連線」的改法都只是把爆掉的門檻往後推（連續跑兩輪就又會撞上 60 秒的 TIME_WAIT 尾巴），
# 而且會動到「每個測試一個全新 database」這個刻意的隔離設計。
#
# sysctl 是 kernel 狀態、WSL 重啟就沒了，所以每次跑測試都重設一次（已經是 1 就跳過）。
# 需要 root：WSL 內的 `sudo` 要密碼，但從 Windows 側用 `wsl -u root` 免密碼。
# 拿不到 root 時只警告不中斷——測試照跑，只是可能會看到上述的隨機 ECONNRESET。
if [ "$(wsl -u root bash -c 'cat /proc/sys/net/ipv4/tcp_tw_reuse' 2>/dev/null || echo '')" = "1" ]; then
  echo "[test-integration] net.ipv4.tcp_tw_reuse 已是 1，略過"
elif wsl -u root bash -c 'sysctl -w net.ipv4.tcp_tw_reuse=1' >/dev/null 2>&1; then
  echo "[test-integration] 已設定 WSL net.ipv4.tcp_tw_reuse=1（避免 ephemeral port 耗盡導致的隨機 ECONNRESET）"
else
  echo "[test-integration] ⚠️  無法設定 WSL net.ipv4.tcp_tw_reuse=1（需要 root）。" >&2
  echo "[test-integration] ⚠️  測試會照跑，但可能出現隨機的 'read ECONNRESET'（原因見本腳本註解）。" >&2
  echo "[test-integration] ⚠️  手動修：wsl -u root sysctl -w net.ipv4.tcp_tw_reuse=1" >&2
fi

# 全部邏輯用單引號的 heredoc 丟給 WSL 內的 bash 執行——避免 Windows/WSL 兩邊 shell
# 對 $HOME、~、引號的展開規則不同而互相打架（曾經因為這樣搞錯目的地路徑）。
# 需要從外面傳進去的值（repo 的 WSL 路徑、要跑哪個 pnpm script）一律用「位置參數」
# （$0/$1）傳遞，不做字串內插。
wsl -e bash -lc 'set -euo pipefail
  src="$1"
  script="$2"
  dest="$HOME/knotebook"

  echo "[test-integration] rsync $src/ -> $dest/（--delete 單向覆蓋，排除 node_modules/dist/.git）"
  mkdir -p "$dest"
  rsync -a --delete \
    --exclude=node_modules --exclude="**/node_modules" \
    --exclude=dist --exclude="**/dist" \
    --exclude=.git \
    "$src/" "$dest/"

  export NVM_DIR="$HOME/.nvm"
  if [ ! -s "$NVM_DIR/nvm.sh" ]; then
    echo "[test-integration] 首次執行：安裝 nvm（不需 sudo）"
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  fi
  . "$NVM_DIR/nvm.sh"
  if ! command -v node >/dev/null 2>&1; then
    echo "[test-integration] 首次執行：安裝 Node 22（不需 sudo）"
    nvm install 22
  fi
  nvm use default >/dev/null
  corepack enable >/dev/null 2>&1 || true

  cd "$dest"
  echo "[test-integration] pnpm install（原生 fs，應該幾秒內完成）"
  pnpm install --frozen-lockfile

  # rsync 帶 --exclude=dist，pnpm install 也不會觸發 workspace 的 build：
  # @knotebook/shared 的 dist 在 WSL 端一定是空的，所以這裡自己補一次。
  #
  # ⚠ 別「順手」把這個前置搬回 apps/server 的 test script：`pnpm -r test` 會**並行**
  # 跑 server 與 web，而 shared 的 build 是 `rimraf dist && tsc`——server 那支
  # rimraf 會在 web 的 vitest 正在 import `shared/dist` 時把它刪掉，症狀是 web 隨機
  # 紅在「找不到模組／常數 undefined」。前置因此只留在「不會被並行跑到」的路徑上
  # （root test、server test:unit、server test:integration、以及這裡），不留在
  # `pnpm -r test` 會平行拉起的 leaf script。
  echo "[test-integration] pnpm --filter @knotebook/shared build"
  pnpm --filter @knotebook/shared build

  echo "[test-integration] pnpm --filter @knotebook/server run $script"
  pnpm --filter @knotebook/server run "$script"
' _ "$WSL_SRC" "$PNPM_SCRIPT"
