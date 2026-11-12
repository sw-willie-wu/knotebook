# Running the e2e suite locally

The end-to-end suite (Playwright, `e2e/`) runs against a throwaway Docker Compose stack (`docker-compose.yml` plus the `docker-compose.e2e.yml` overlay: app, Postgres, a fake OIDC provider, an AI stub). On Windows everything runs **inside WSL**: Docker, Playwright and its browser, and the copy of the code all live on WSL's own filesystem. The script only syncs the repo into WSL and runs there; do not run Playwright from Windows or from `/mnt/c`.

```bash
bash scripts/test-e2e.sh                         # whole suite
bash scripts/test-e2e.sh 00-smoke 05-oidc        # only specs whose path matches (Playwright's file filter)
bash scripts/test-e2e.sh -- --grep "login"       # everything after `--` goes to `playwright test`
bash scripts/test-e2e.sh --list                  # every knotebook-e2e* stack in WSL: project, containers, ports
bash scripts/test-e2e.sh --clean                 # remove this checkout's own stack, images and WSL copy
```

To run Playwright by hand from the WSL copy, use `pnpm --filter @knotebook/e2e exec playwright test <file>`. `pnpm ... run test:e2e <file>` also works (pnpm 10 drops a `--` and forwards everything after the script name); options such as `--grep` need the `--` so pnpm does not read them as its own: `pnpm --filter @knotebook/e2e run test:e2e -- --grep login`.

Every run's complete output is also written inside WSL to `$HOME/knotebook-e2e-<sfx>/e2e-run.log` (the path is printed at the start; stderr is merged into it, and the file is overwritten by the next run of the same project). To keep a log, read that file (`wsl cat ...`) rather than redirecting with `> file 2>&1` from Git Bash: through `wsl.exe` that redirect can lose lines from the start of the output.

## Several runs at once

Each run is isolated by four values. Set any of them as environment variables; anything unset is derived from the current git branch (or the directory name when there is no git), as a short stable suffix `<sfx>`:

| Variable | Meaning | Default |
| --- | --- | --- |
| `E2E_PROJECT` | Compose project name | `knotebook-e2e-<sfx>` |
| `E2E_PORT` | Host port of the app | first free port from 3101 (start point depends on the project name) |
| `E2E_IDP_PORT` | Host port of the fake OIDC provider | first free port from 9401 (`9400` when `E2E_PORT=3100`) |
| `E2E_WORKDIR` | Copy of the code inside WSL (a direct child of `$HOME` named `knotebook-e2e*`) | `$HOME/knotebook-e2e-<sfx>` |
| `E2E_SUFFIX` | Force the `<sfx>` | derived from the branch |
| `E2E_MAX_PARALLEL` | Most `knotebook-e2e*` stacks running at once | `3` |
| `E2E_MAX_WAIT` | Seconds to wait for a free slot before giving up (exit 1) | `900` |

The script prints the values it actually uses at the start. Starting a run is serialized by a lock until its containers are up, so two runs started by this script never pick the same port. That holds for stacks started by the script and checked from inside WSL; it does not cover an explicit `E2E_PORT`, stacks started some other way, or (with `networkingMode=mirrored` in `.wslconfig`) a port already used by a program on the Windows side, which `ss` inside WSL cannot see. In those cases `stack:up` fails instead of silently sharing a port. When `E2E_MAX_PARALLEL` stacks are already running, a new run waits (and prints who it is waiting for). A stack left behind by a failed run counts too; remove it with `--clean`.

Fixed ports still work: `E2E_PROJECT=knotebook-e2e E2E_PORT=3100 bash scripts/test-e2e.sh` (the work directory then defaults to `$HOME/knotebook-e2e`). CI itself calls `docker compose -p knotebook-e2e …` directly, with no variables set, and gets ports 3100/9400.

Guard rails: `E2E_PROJECT` must be `knotebook-e2e` or `knotebook-e2e-<lowercase letters, digits, ->`, and `E2E_WORKDIR` (an absolute path inside WSL) must be a direct child of `$HOME` named `knotebook-e2e*` and must not be a symbolic link (the path is normalized and its symlinks are resolved before the check, and the checked path is the one that is deleted or synced into); anything else is rejected before any delete or docker command runs. Two runs of the same project name cannot overlap (the second exits), and `--clean` takes the same per-project lock (it waits up to 30 s, then gives up) so it cannot delete the copy of a run in progress; and a stack left behind by an earlier failed run of the same project is removed when a new run starts. Waiting for the start lock or for a free slot gives up after `E2E_MAX_WAIT` seconds; `stack:up` itself waits at most 300 s for the containers to become healthy.

Tests must take the app and fake-idp origins from `e2e/ports.ts` (`E2E_ORIGIN`, `IDP_CONTROL_ORIGIN`) instead of writing `localhost:3100` or `localhost:9400`; a hard-coded port passes in CI but fails in a parallel run on other ports.

A passing run does `down -v --rmi local` for its own project only (containers, volumes and the images it built; the next run rebuilds from cache). The per-branch work directory `$HOME/knotebook-e2e-<sfx>` stays (it makes the next run an incremental sync) until you run `--clean` once you are done with a branch; `--list` shows these directories and images too. Run `--clean` in a worktree before you remove that worktree, otherwise its `$HOME/knotebook-e2e-<sfx>` is left behind. A failing run leaves its stack up so you can look at it; the output tells you the exact `--clean` command. A leftover stack of the same project is removed automatically when the next run of that project starts; leftovers of other projects stay (and count toward `E2E_MAX_PARALLEL`) until you `--clean` them.

## How many at once

Measured with three stacks running the same 20 specs at the same time on a 24-core, 23 GB WSL machine (`docker stats` and `free` inside WSL, sampled every 5 s):

| Per stack | Typical | Notes |
| --- | --- | --- |
| Containers (app, Postgres, fake OIDC provider, AI stub) | about 0.65 GB | app about 0.55-0.7 GB, Postgres about 0.05 GB, the two stubs about 0.015 GB each |
| Playwright's Chromium + test runner | about 0.6 GB | one worker per run |
| Image build at start | about +1 GB for a minute | the workspace deploy step in the Docker build; starts are serialized, so builds do not pile up |
| CPU | under 1 core on average, short bursts to about 2.4 cores for all three stacks together | three runs kept a 24-core host about 13% busy on average, 27% at most (including load from other things running on that machine) |

So plan on about **1.3 GB of RAM per running stack**, plus about 1 GB of headroom for a build. Size the limit from your own machine: `E2E_MAX_PARALLEL ≈ (available memory in WSL − what the rest of your work needs − 1 GB) / 1.3 GB`, and no more than about a quarter of your cores. On the machine above (about 16 GB available) that allows far more than the default of 3, which is a conservative default; run `free -m` and `docker stats` in WSL to check yours. Each run's wall time did not change noticeably between one and three concurrent runs (2.5 minutes for the 20 specs above).

The WSL disk image lives on `C:`; each stack builds its own app image (shared layers are cached) and a Postgres volume, so keep an eye on free space on `C:` from Windows (`(Get-PSDrive C).Free`) rather than `df` inside WSL.
