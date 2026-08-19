#!/usr/bin/env bash
# scripts/test-e2e.sh
#
# E2E（Playwright，Plan 5 Task 11）需要真的連到 Docker daemon 起 compose 疊——docker
# 只存在於 WSL，Windows host 沒有 docker CLI（plan-gate 一輪 MAJOR-7）。跟
# scripts/test-integration.sh 同款理由與形狀：把這份 repo（Windows 檔案系統，WSL 看到
# 的 /mnt/c/...）留在原地對它跑 pnpm install 落入 9p 掛載的極慢 I/O，所以先單向同步到
# WSL 原生 ext4（$HOME/knotebook）再裝、再跑。
#
# ⚠️ 禁止在 WSL 的 ~/knotebook 內直接編輯任何檔案——單向同步（rsync --delete）會覆蓋，
#    改動不會被保留。要改程式碼一律在 Windows 這邊的 repo（這支腳本所在的這份）改，
#    然後重跑本腳本。
#
# 用法（在 Windows 側的 Git Bash / 任何能呼叫 `wsl` 的 shell 執行）：
#   bash scripts/test-e2e.sh
#
# 埠註記：`-p knotebook-e2e`（e2e/package.json 的 stack:up/stack:down）已把這座疊跟
# WSL 裡可能同時掛著的 demo 疊（專案名 knotebook、port 8006）隔開；e2e 疊用 3100
# （app）/9400（fake-idp）不會跟 demo 相撞，兩者可在同一個 WSL 並存，不必先關 demo。

set -euo pipefail

# Git Bash（MSYS）預設會把看起來像 POSIX 路徑的參數（例如 /mnt/c/...）自動轉成
# Windows 路徑再傳給 wsl.exe，導致路徑被錯誤地加上 Git 安裝目錄前綴。關掉這個自動轉換。
export MSYS_NO_PATHCONV=1

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Git Bash 的 pwd 是 /c/Users/... 這種格式；WSL 看同一個磁碟要走 /mnt/c/Users/...
WSL_SRC="$(echo "$REPO_ROOT" | sed -E 's#^/([A-Za-z])/#/mnt/\L\1/#')"

echo "[test-e2e] src(WSL)=$WSL_SRC  dest(WSL)=\$HOME/knotebook"

# 全部邏輯用單引號的 heredoc 丟給 WSL 內的 bash 執行——避免 Windows/WSL 兩邊 shell
# 對 $HOME、~、引號的展開規則不同而互相打架。需要從外面傳進去的值一律用「位置參數」
# （$0/$1）傳遞，不做字串內插。
wsl -e bash -lc 'set -euo pipefail
  src="$1"
  dest="$HOME/knotebook"

  echo "[test-e2e] rsync $src/ -> $dest/（--delete 單向覆蓋，排除 node_modules/dist/.git）"
  mkdir -p "$dest"
  rsync -a --delete \
    --exclude=node_modules --exclude="**/node_modules" \
    --exclude=dist --exclude="**/dist" \
    --exclude=.git \
    --exclude=test-results --exclude="**/test-results" \
    --exclude=playwright-report --exclude="**/playwright-report" \
    "$src/" "$dest/"

  export NVM_DIR="$HOME/.nvm"
  if [ ! -s "$NVM_DIR/nvm.sh" ]; then
    echo "[test-e2e] 首次執行：安裝 nvm（不需 sudo）"
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  fi
  . "$NVM_DIR/nvm.sh"
  if ! command -v node >/dev/null 2>&1; then
    echo "[test-e2e] 首次執行：安裝 Node 22（不需 sudo）"
    nvm install 22
  fi
  nvm use default >/dev/null
  corepack enable >/dev/null 2>&1 || true

  if ! command -v docker >/dev/null 2>&1; then
    echo "[test-e2e] ⚠️  WSL 內找不到 docker CLI——docker 只在 WSL、需先安裝（見 docs/self-hosting.md）。" >&2
    exit 1
  fi
  if ! docker info >/dev/null 2>&1; then
    echo "[test-e2e] ⚠️  docker daemon 未啟動或無權限存取——確認 WSL 內 dockerd 正在跑。" >&2
    exit 1
  fi

  cd "$dest"
  echo "[test-e2e] pnpm install --frozen-lockfile（原生 fs，應該很快）"
  pnpm install --frozen-lockfile

  echo "[test-e2e] playwright install chromium（不帶 --with-deps，避免需要 root）"
  pnpm --filter @knotebook/e2e exec playwright install chromium

  cleanup_hint_shown=0
  print_stack_down_hint() {
    if [ "$cleanup_hint_shown" -eq 0 ]; then
      cleanup_hint_shown=1
      echo "[test-e2e] 疊保留供 debug（未自動 down）。手動清理：" >&2
      echo "  wsl -e bash -lc \"cd \$HOME/knotebook/e2e && pnpm run stack:down\"" >&2
    fi
  }

  echo "[test-e2e] docker compose stack:up（-p knotebook-e2e，見 e2e/package.json）"
  if ! pnpm --filter @knotebook/e2e run stack:up; then
    echo "[test-e2e] ❌ stack:up 失敗。" >&2
    print_stack_down_hint
    exit 1
  fi

  set +e
  pnpm --filter @knotebook/e2e run test:e2e
  test_exit_code=$?
  set -e

  if [ "$test_exit_code" -ne 0 ]; then
    echo "[test-e2e] ❌ test:e2e 失敗（exit $test_exit_code）。" >&2
    echo "[test-e2e] 若原因疑似缺系統依賴（chromium 啟動失敗、GTK/NSS 等 .so 找不到），" >&2
    echo "  手動跑一次（需 root，只需一次）：" >&2
    echo "  wsl -u root bash -lc \"cd \$HOME/knotebook && pnpm --filter @knotebook/e2e exec playwright install-deps chromium\"" >&2
    print_stack_down_hint
    exit "$test_exit_code"
  fi

  echo "[test-e2e] docker compose stack:down"
  pnpm --filter @knotebook/e2e run stack:down
' _ "$WSL_SRC"
