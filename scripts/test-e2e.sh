#!/usr/bin/env bash
# scripts/test-e2e.sh
#
# E2E（Playwright）整套都在 WSL 內跑：docker compose 疊、Playwright 與它的瀏覽器、程式碼複本
# 全在 WSL 自己的檔案系統（ext4）。Windows 端只負責把這份 repo 單向同步進 WSL，再用 `wsl -e` 執行；
# 不在 /mnt/c 上跑（9p 掛載的 I/O 極慢），也不在 Windows 端跑 Playwright。
#
# ⚠️ 禁止在 WSL 的工作目錄內直接編輯任何檔案——單向同步（rsync --delete）會覆蓋。
#    要改程式碼一律在 Windows 這邊的 repo 改，然後重跑本腳本。
#
# 用法（在 Windows 側的 Git Bash / 任何能呼叫 `wsl` 的 shell 執行）：
#   bash scripts/test-e2e.sh                      # 跑全套
#   bash scripts/test-e2e.sh 00-smoke 05-oidc     # 只跑符合的 spec（Playwright 的檔名過濾，可多個；
#                                                 #   也收 e2e/tests/00-smoke.spec.ts 這種路徑）
#   bash scripts/test-e2e.sh -- --grep "login"    # 「--」之後原樣交給 `playwright test`
#   bash scripts/test-e2e.sh --list               # 列出 WSL 內所有 knotebook-e2e* 的疊（含埠、狀態）
#   bash scripts/test-e2e.sh --clean              # 清掉「自己這組」：容器、volume、網路、映像、WSL 工作目錄
#
# 同時跑多組：每組靠四個值隔開，全部可用環境變數指定，沒指定就由「git 分支（沒有 git 就用目錄名）」
# 推出穩定的短後綴 <sfx>：
#   E2E_PROJECT   compose 專案名            預設 knotebook-e2e-<sfx>
#   E2E_PORT      app 對外埠                預設自動找空的（從 3101 起，依專案名挑起點）
#   E2E_IDP_PORT  fake-idp 對外埠           預設自動找空的（E2E_PORT=3100 時為 9400）
#   E2E_WORKDIR   WSL 內的程式碼複本目錄    預設 $HOME/knotebook-e2e-<sfx>
#   E2E_SUFFIX    直接指定 <sfx>（預設由分支推出）
#   E2E_MAX_PARALLEL  同時最多幾組（預設 3）；已有這麼多組 knotebook-e2e* 在跑，就等到有空位
#   E2E_MAX_WAIT      最多等幾秒（預設 900），逾時以 exit 1 退出
# E2E_PROJECT 只收 knotebook-e2e／knotebook-e2e-*；E2E_WORKDIR 要給 WSL 內 $HOME 的直接子目錄 knotebook-e2e*（絕對路徑、本身不是符號連結），
# 其他值一律拒絕（不會執行任何刪除或 docker 動作）。
# 開跑時會印出實際使用的值；整段輸出同時寫進 WSL 內 <工作目錄>/e2e-run.log。固定埠的寫法：E2E_PROJECT=knotebook-e2e E2E_PORT=3100 bash scripts/test-e2e.sh
#
# 收尾：成功就 `down -v --rmi local` 只收自己的專案（工作目錄保留，要用 --clean 收）；失敗刻意不 down（保留除錯），訊息會印出清理指令。
# 每組大約吃多少資源、上限怎麼訂 → docs/e2e-local.md。

set -euo pipefail

# Git Bash（MSYS）預設會把看起來像 POSIX 路徑的參數（例如 /mnt/c/...）自動轉成
# Windows 路徑再傳給 wsl.exe，導致路徑被錯誤地加上 Git 安裝目錄前綴。關掉這個自動轉換。
export MSYS_NO_PATHCONV=1

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Git Bash 的 pwd 是 /c/Users/... 這種格式；WSL 看同一個磁碟要走 /mnt/c/Users/...
WSL_SRC="$(echo "$REPO_ROOT" | sed -E 's#^/([A-Za-z])/#/mnt/\L\1/#')"

mode=run
case "${1:-}" in
  --list) mode=list; shift ;;
  --clean) mode=clean; shift ;;
  --) shift ;;
esac

# 穩定的短後綴：分支名（沒有 git 就用目錄名）去掉非英數後取前 12 字，再加 4 碼雜湊避免截斷後撞名。
if [ -z "${E2E_SUFFIX:-}" ]; then
  label="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
  if [ -z "$label" ] || [ "$label" = "HEAD" ]; then label="$(basename "$REPO_ROOT")"; fi
  slug="$(printf '%s' "$label" | tr 'A-Z' 'a-z' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//' | cut -c1-12 | sed -E 's/-+$//')"
  hash4="$(printf '%s' "$label" | cksum | awk '{printf "%04x", $1 % 65536}')"
  E2E_SUFFIX="${slug:-x}-$hash4"
fi
export E2E_PROJECT="${E2E_PROJECT:-knotebook-e2e-$E2E_SUFFIX}"
E2E_WORKDIR="${E2E_WORKDIR:-}"   # 空字串＝在 WSL 內用 $HOME/knotebook-e2e-<sfx>
E2E_PORT="${E2E_PORT:-}"
E2E_IDP_PORT="${E2E_IDP_PORT:-}"
E2E_MAX_PARALLEL="${E2E_MAX_PARALLEL:-3}"
E2E_MAX_WAIT="${E2E_MAX_WAIT:-900}"

# 實際邏輯在 scripts/test-e2e.wsl.sh（WSL 內執行）。值一律用「位置參數」傳遞，不做字串內插；
# 空值以 "-" 代替（wsl.exe 會吞掉空字串參數）。其餘位置參數（第 9 個起）是交給 playwright 的過濾條件。
wsl -e bash -l "$WSL_SRC/scripts/test-e2e.wsl.sh" "$mode" "$WSL_SRC" "$E2E_PROJECT" "${E2E_WORKDIR:--}" "${E2E_PORT:--}" "${E2E_IDP_PORT:--}" "$E2E_MAX_PARALLEL" "$E2E_MAX_WAIT" "$@"
