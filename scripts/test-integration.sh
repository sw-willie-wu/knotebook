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

  echo "[test-integration] pnpm --filter @knotebook/server run $script"
  pnpm --filter @knotebook/server run "$script"
' _ "$WSL_SRC" "$PNPM_SCRIPT"
