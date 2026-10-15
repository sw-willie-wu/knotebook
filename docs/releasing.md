# Releasing (maintainers)

A release is cut by merging a release pull request into `main`. Everything after the merge — the `vX.Y.Z` tag, the GitHub Release and the Docker images — is done by the Release workflow (`.github/workflows/release.yml`).

## 1. Prepare the release pull request

1. Start from an up-to-date `main` with all tags fetched (`git fetch --tags`).
2. Run `pnpm release:prepare X.Y.Z` (the version without a leading `v`; add `--date YYYY-MM-DD` to set the release date, which otherwise is today's date on your machine). It only edits files:
   - the `version` of `apps/server/package.json`, `apps/web/package.json` and `packages/shared/package.json`;
   - `CHANGELOG.md`: what is under `## [Unreleased]` becomes `## [X.Y.Z] - <date>`, with a new `## [Unreleased]` holding `_Nothing yet._` above it;
   - the status line in `README.md` (`the latest release is vX.Y.Z (<date>)`) and `README.zh-TW.md` (`最新版本為 vX.Y.Z（<date>）`).

   It changes nothing, and exits with an error, if the version isn't `X.Y.Z`, isn't greater than the greatest `vX.Y.Z` tag in your local clone, already has a section in `CHANGELOG.md`, if `[Unreleased]` is empty or only `_Nothing yet._`, or if either status line can't be found exactly once. It doesn't run any git command that changes anything; at the end it prints the commands for the next step.
3. Check by hand what the script doesn't touch: the feature list and upgrade notes in both READMEs, the "Upgrading to vX.Y" part of [docs/self-hosting.md](self-hosting.md#upgrading-and-rolling-back), and the new CHANGELOG section itself.
4. Commit on a branch, push, and open a pull request against `main`.

Before 1.0, a release with new features or with upgrade notes (anything that needs action on upgrade) bumps the minor version; a release with fixes only bumps the patch version.

## 2. Merge

**Squash-merge** the pull request into `main`, always. The Release workflow only releases from a commit that itself changes the version (see below); with a rebase merge of several commits, the last commit — the one the workflow looks at — usually doesn't, and the release is skipped (the run shows a warning). The push to `main` runs the CI workflow, with both of its jobs, `ci` and `e2e`.

## 3. What happens automatically

When the CI run for that merge commit finishes successfully, the Release workflow runs on the same commit:

1. It checks that this commit itself changed the version in `apps/server/package.json`, compared with its first parent (with squash merges, the previous commit on `main`; for a merge commit, `main` before the merge; a commit without a parent counts as a change). A commit that doesn't change the version never releases anything, even when its version has no tag yet — this is what happens after every ordinary merge (when the version has no tag yet, the run shows a warning). It also stops if the tag `vX.Y.Z` already exists.
2. It checks that `CHANGELOG.md` has a non-empty section for that version, and prepares the two files attached to the Release (below), checking the compose file with `docker compose config`. If either fails, the workflow fails and nothing is pushed, tagged or published.
3. It builds the Docker image from that commit on a linux/amd64 and a linux/arm64 runner, pushes it as `ghcr.io/sw-willie-wu/knotebook:X.Y.Z` and checks that it holds both platforms. If the images fail, nothing is tagged or published.
4. Only then it creates the annotated tag `vX.Y.Z` on that commit and pushes it.
5. It creates the GitHub Release as a draft, with the version's CHANGELOG section as its notes, attaches the two files, and then publishes it — so a published Release always has its images and attachments. The attachments, taken from that commit, let self-hosters skip the clone: `docker-compose.yml`, changed so that it runs this version's image by default and has no `build:` section, and `.env.example`, attached as `env.example` because GitHub doesn't keep a leading `.` in attachment names. A commit whose `docker-compose.yml` has no `image:` (v0.11.1 and earlier) gets no attachments.
6. Only after the Release is published, it points `X.Y` at the new image when this is the highest patch release of its minor line, and `latest` when this is the highest version of all, and checks both platforms under them. So if anything before fails, people who follow `latest` or `X.Y` stay on the previous release.

CI runs for pushes to `main` are never cancelled by a newer push (only pull request runs are), so every merge gets its own result. **If the CI run of the release commit fails** (an e2e test that fails now and then, for example), nothing is released, and later merges don't release it either, because they don't change the version. Re-run that CI run (**Actions → CI →** the run of the release commit **→ Re-run failed jobs**, or `gh run rerun <run id> --failed`); when it succeeds, the Release workflow runs again for the same commit.

**If the Release workflow itself fails before it pushes the tag** (while building the images, for example), re-run that whole workflow run with **Re-run all jobs** (`gh run rerun <run id>`): the first job works everything out again, which is safe as long as the tag doesn't exist. Re-running only the failed jobs needs files the earlier jobs kept for 7 days. **If it fails after pushing the tag**, a re-run stops at once because the tag exists; publish the rest with the manual run below.

**If the release commit's CI is really broken** — a failure that needs a fix, not a re-run — merge the fix as an ordinary pull request (it keeps the version and `CHANGELOG.md` as they are, so it doesn't release anything by itself). When CI on `main` is green for that fix commit, tag it by hand and publish it with the manual run below:

```sh
git fetch origin
git tag -a vX.Y.Z -m "Release vX.Y.Z" <the fix commit on main>
git push origin vX.Y.Z
gh workflow run release.yml -f tag=vX.Y.Z
```

The manual run doesn't look at CI, so tag only a commit whose CI run on `main` succeeded, and whose `apps/server/package.json` and `CHANGELOG.md` already have version X.Y.Z.

Apart from that case, don't create `vX.Y.Z` tags by hand. Pushing a tag doesn't start anything, and because the tag then already exists, the automatic run skips the release.

## Publishing an existing tag again

To publish the GitHub Release and the images for a tag that already exists — for example after a run that failed after pushing the tag, or for a tag created before images were published — run the Release workflow by hand with that tag: **Actions → Release → Run workflow**, or `gh workflow run release.yml -f tag=vX.Y.Z`. It never creates a tag, and it builds `refs/tags/vX.Y.Z`, never a branch of the same name. The images are built from that tag and pushed again as `X.Y.Z` first; then the GitHub Release is created, or updated if it exists (its notes come from `CHANGELOG.md` at that tag, and its two attachments are replaced with the ones made from that tag); then `X.Y` and `latest` are moved. `latest` and `X.Y`, and the Release's **Latest** mark, are only moved when the tag is the highest version of all or of its minor line, so publishing an older release again doesn't move them back.

## The first image: make the package public

A package created on the GitHub Container Registry starts out private. After the first image is pushed, open the `knotebook` package (the **Packages** tab of the owner's profile) and, under **Package settings**, change its visibility to **Public**. Until then, pulls without signing in fail: with a release's `docker-compose.yml`, `docker compose up -d` stops with an authorization error (`denied`, or `failed to fetch anonymous token … 403 Forbidden`); with the repository's, it falls back to building the image from source (see [The app image](self-hosting.md#the-app-image)).
