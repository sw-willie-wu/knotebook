#!/usr/bin/env bash
# scripts/test-e2e.wsl.sh —— 由 scripts/test-e2e.sh 在 WSL 內呼叫，不要直接跑。
# 位置參數：mode src project workdir port idp_port max_parallel max_wait [playwright 過濾條件…]
set -euo pipefail
# bash 是邊讀邊執行；腳本放在 /mnt/c 時，執行中被原地修改會改到正在跑的這次。
# 所以先複製到 WSL 的暫存檔，改由副本執行，結束時刪掉副本。
if [ -z "${E2E_WSL_COPY:-}" ]; then
  self_copy="$(mktemp "${TMPDIR:-/tmp}/test-e2e-wsl.XXXXXX")"
  cp -- "$0" "$self_copy"
  E2E_WSL_COPY=1 exec bash "$self_copy" "$@"
fi
case "$0" in */test-e2e-wsl.*) trap 'rm -f -- "$0"' EXIT ;; esac
  mode="$1"; src="$2"; project="$3"; workdir="$4"; port="$5"; idp_port="$6"; max_parallel="$7"; max_wait="$8"
  shift 8
  [ "$workdir" != "-" ] || workdir=""; [ "$port" != "-" ] || port=""; [ "$idp_port" != "-" ] || idp_port=""
  [ -n "$workdir" ] || workdir="$HOME/knotebook-${project#knotebook-}"

  # ---- 輸入驗證：任何 rm／rsync --delete／docker 動作之前先擋，避免誤動到別的專案或家目錄 ----
  die() { echo "[test-e2e] ❌ $*" >&2; exit 1; }
  [[ "$project" =~ ^knotebook-e2e(-[a-z0-9][a-z0-9-]*)?$ ]]     || die "E2E_PROJECT 必須是 knotebook-e2e 或 knotebook-e2e-<小寫英數與->：'$project'"
  [ -n "${HOME:-}" ] && [ "$HOME" != "/" ] || die "HOME 未設定或是 /"
  # 工作目錄必須是 $HOME 底下名為 knotebook-e2e* 的「直接子目錄」，且本身不是符號連結。
  # 先用 realpath -sm 只做字面正規化（收掉 ..、//、尾斜線），再用 realpath -m 解開連結後比對，
  # 之後的 rm／rsync 一律用驗證過的絕對路徑。
  home_lex="$(realpath -sm -- "$HOME")"; home_real="$(realpath -m -- "$HOME")"
  wd_lex="$(realpath -sm -- "$workdir")"
  wd_base="$(basename -- "$wd_lex")"
  [ "$(dirname -- "$wd_lex")" = "$home_lex" ] || die "E2E_WORKDIR 必須是 \$HOME 的直接子目錄 knotebook-e2e*：'$workdir'"
  [[ "$wd_base" =~ ^knotebook-e2e[-A-Za-z0-9._]*$ ]] || die "E2E_WORKDIR 名稱必須是 knotebook-e2e*：'$workdir'"
  [ ! -L "$wd_lex" ] || die "E2E_WORKDIR 不可是符號連結：'$workdir'"
  [ "$(realpath -m -- "$wd_lex")" = "$home_real/$wd_base" ] || die "E2E_WORKDIR 解開連結後不在 \$HOME 底下：'$workdir'"
  workdir="$home_real/$wd_base"
  [[ "$max_parallel" =~ ^[0-9]+$ ]] || die "E2E_MAX_PARALLEL 必須是數字：'$max_parallel'"
  [[ "$max_wait" =~ ^[0-9]+$ ]] || die "E2E_MAX_WAIT 必須是數字：'$max_wait'"
  for tool in ss flock; do
    command -v "$tool" >/dev/null 2>&1 || die "WSL 內找不到 $tool"
  done

  if ! command -v docker >/dev/null 2>&1; then
    echo "[test-e2e] ⚠️  WSL 內找不到 docker CLI——docker 只在 WSL、需先安裝（見 docs/self-hosting.md）。" >&2
    exit 1
  fi
  if ! docker info >/dev/null 2>&1; then
    echo "[test-e2e] ⚠️  docker daemon 未啟動或無權限存取——確認 WSL 內 dockerd 正在跑。" >&2
    exit 1
  fi

  # 目前在跑的 knotebook-e2e* 專案（不含自己），一行一個
  other_stacks() {
    docker ps --format "{{.Label \"com.docker.compose.project\"}}" \
      | { grep -E "^knotebook-e2e" || true; } | sort -u | { grep -v -x -F "$project" || true; }
  }

  if [ "$mode" = list ]; then
    echo "[test-e2e] WSL 內的 knotebook-e2e* 疊（容器；* 為這次指定或推出的專案名）"
    docker ps -a --filter "label=com.docker.compose.project" \
      --format "{{.Label \"com.docker.compose.project\"}}\t{{.Names}}\t{{.Status}}\t{{.Ports}}" \
      | { grep -E "^knotebook-e2e" || true; } | sort \
      | awk -F"\t" -v me="$project" "{printf \"%s %s  %s  %s  %s\n\", (\$1==me?\"*\":\" \"), \$1, \$2, \$3, \$4}"
    echo "[test-e2e] WSL 內的 knotebook-e2e* 映像與工作目錄"
    docker image ls --format "{{.Repository}}:{{.Tag}}  {{.Size}}" | { grep -E "^knotebook-e2e" || true; }
    ls -d "$HOME"/knotebook-e2e* 2>/dev/null || true
    echo "[test-e2e] 自己這組：project=$project workdir=$workdir"
    exit 0
  fi

  # 只清這個 compose 專案（以 label 精確比對）的容器、volume、網路
  wipe_project_stack() {
    filter="label=com.docker.compose.project=$project"
    ids="$(docker ps -a -q --filter "$filter")"; [ -z "$ids" ] || docker rm -f -v $ids
    vols="$(docker volume ls -q --filter "$filter")"; [ -z "$vols" ] || docker volume rm $vols
    nets="$(docker network ls -q --filter "$filter")"; [ -z "$nets" ] || docker network rm $nets
  }

  # 每個專案同時只能有一個 run 或一個 --clean，避免清到正在跑的那組
  exec 8>"/tmp/$project.run.lock"

  if [ "$mode" = clean ]; then
    flock -w 30 8 || die "$project 的 run 正在跑（或另一個 --clean 進行中），先等它結束再清。"
    echo "[test-e2e] 清掉自己這組：project=$project（不碰別組）"
    wipe_project_stack
    imgs="$(docker image ls -q --filter "label=com.docker.compose.project=$project")"
    [ -z "$imgs" ] || docker image rm $imgs || true
    if [ -d "$workdir" ]; then rm -rf -- "$workdir" && echo "[test-e2e] 已刪工作目錄 $workdir"; fi
    exit 0
  fi

  # 同一專案名同時只能有一個 run；前一輪留下的同名疊（失敗保留除錯用）在這裡清掉再重來
  flock -n 8 || die "同名專案 $project 已有另一個 run 在跑，退出。"
  if [ -n "$(docker ps -a -q --filter "label=com.docker.compose.project=$project")" ]; then
    echo "[test-e2e] 發現上一輪留下的 $project 疊，先清掉再開始。"
    wipe_project_stack
  fi

  # 之後的輸出同時寫進工作目錄下的 e2e-run.log（stderr 併進 stdout）。
  # 從 Windows 用 `> file 2>&1` 導檔會掉行，要留紀錄就看這個檔。
  mkdir -p "$workdir"
  exec > >(tee "$workdir/e2e-run.log") 2>&1
  echo "[test-e2e] log: $workdir/e2e-run.log"

  echo "[test-e2e] project=$project  port=${port:-auto}  idp-port=${idp_port:-auto}  workdir=$workdir"
  echo "[test-e2e] src(WSL)=$src  並行上限=$max_parallel"

  echo "[test-e2e] rsync $src/ -> $workdir/（--delete 單向覆蓋，排除 node_modules/dist/.git）"
  mkdir -p "$workdir"
  rsync -a --delete \
    --exclude=node_modules --exclude="**/node_modules" \
    --exclude=dist --exclude="**/dist" \
    --exclude=.git \
    --exclude=.claude \
    --exclude=/e2e-run.log \
    --exclude=test-results --exclude="**/test-results" \
    --exclude=playwright-report --exclude="**/playwright-report" \
    "$src/" "$workdir/"

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

  cd "$workdir"
  echo "[test-e2e] pnpm install --frozen-lockfile（原生 fs，應該很快）"
  pnpm install --frozen-lockfile

  echo "[test-e2e] playwright install chromium（不帶 --with-deps，避免需要 root）"
  pnpm --filter @knotebook/e2e exec playwright install chromium

  # ---- 同時跑的上限 + 挑埠：用一把鎖串行化，鎖到 stack:up 完成（埠真的被 docker 占住）才放 ----
  wait_start=$SECONDS
  exec 9>/tmp/knotebook-e2e-start.lock
  echo "[test-e2e] 等待啟動鎖…"
  flock -w "$max_wait" 9 || die "等啟動鎖超過 ${max_wait}s，退出。"
  while :; do
    n="$(other_stacks | wc -l)"
    [ "$n" -lt "$max_parallel" ] && break
    waited=$((SECONDS - wait_start))
    if [ "$waited" -ge "$max_wait" ]; then
      echo "[test-e2e] ❌ 已有 $n 組 knotebook-e2e* 在跑（上限 E2E_MAX_PARALLEL=$max_parallel），等了 ${waited}s 仍無空位，退出。" >&2
      other_stacks >&2
      exit 1
    fi
    echo "[test-e2e] 已有 $n 組在跑（上限 $max_parallel）：$(other_stacks | tr "\n" " ")——等待空位…（${waited}s/${max_wait}s）"
    sleep 10
  done

  port_free() { [ -z "$(ss -ltnH "sport = :$1" 2>/dev/null)" ]; }
  pick_port() { # $1=起點 $2=要避開的埠
    p="$1"
    while ! port_free "$p" || [ "$p" = "${2:-}" ]; do p=$((p + 1)); done
    echo "$p"
  }
  offset=$(( $(printf "%s" "$project" | cksum | cut -d" " -f1) % 200 ))
  if [ -z "$port" ]; then port="$(pick_port $((3101 + offset)))"; fi
  if [ -z "$idp_port" ]; then
    if [ "$port" = 3100 ]; then idp_port=9400; else idp_port="$(pick_port $((9401 + offset)) "$port")"; fi
  fi
  export E2E_PROJECT="$project" E2E_PORT="$port" E2E_IDP_PORT="$idp_port"

  echo "[test-e2e] 實際使用：project=$project  port=$port  idp-port=$idp_port  workdir=$workdir（目前別組 $(other_stacks | wc -l) 組）"

  cleanup_hint_shown=0
  print_stack_down_hint() {
    if [ "$cleanup_hint_shown" -eq 0 ]; then
      cleanup_hint_shown=1
      echo "[test-e2e] 疊保留供 debug（未自動 down，仍計入並行上限）。清掉自己這組：" >&2
      echo "  E2E_PROJECT=$project E2E_WORKDIR=$workdir bash scripts/test-e2e.sh --clean" >&2
    fi
  }

  echo "[test-e2e] docker compose stack:up（-p $project）"
  if ! pnpm --filter @knotebook/e2e run stack:up; then
    echo "[test-e2e] ❌ stack:up 失敗。" >&2
    print_stack_down_hint
    exit 1
  fi
  flock -u 9   # 埠已被占住，放開鎖讓下一組開始

  set +e
  pnpm --filter @knotebook/e2e exec playwright test "$@"
  test_exit_code=$?
  set -e

  if [ "$test_exit_code" -ne 0 ]; then
    echo "[test-e2e] ❌ playwright 失敗（exit $test_exit_code）。" >&2
    echo "[test-e2e] 若原因疑似缺系統依賴（chromium 啟動失敗、GTK/NSS 等 .so 找不到），" >&2
    echo "  手動跑一次（需 root，只需一次）：" >&2
    echo "  wsl -u root bash -lc \"cd $workdir && pnpm --filter @knotebook/e2e exec playwright install-deps chromium\"" >&2
    print_stack_down_hint
    exit "$test_exit_code"
  fi

  echo "[test-e2e] docker compose stack:down（只收 $project，連同本機 build 的映像）"
  docker compose -p "$project" -f docker-compose.yml -f docker-compose.e2e.yml down -v --rmi local
