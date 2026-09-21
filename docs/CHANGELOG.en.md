# Changelog

> Per-version release notes and fix records for TaskBoard. For the current version and a project overview, see [README](../README.md).

- **Unreleased — Colored borders on session cards to distinguish adjacent cards (#304)**

  - **#304 Session card background too close to panel background**: The entire wall lacked visual distinction, making it hard to locate a specific card at a glance. Each card needed a border with random colors from a palette, and adjacent cards (up/down/left/right) must have different colors. See [docs/issue-304-session-border.md](./issue-304-session-border.md).
  - **4-color palette**: Defined 4 border color CSS variables (blue/green/orange/purple, `--session-card-border-1` ~ `-4`), low saturation, medium brightness, readable on light backgrounds.
  - **Coloring formula `(row + col) % 4`**: Guarantees horizontal neighbors (col differs by 1) and vertical neighbors (row differs by 1) have different colors. No third-party coloring library needed.
  - **Responsive column count**: CSS grid `auto-fill` column count changes with window width; measured at runtime via `getComputedStyle` reading `gridTemplateColumns`, recalculated on window resize.
  - **Static assertion regression**: `styles.test.ts` adds 5 assertions covering palette, border declaration, coloring formula, column measurement, and ref mount.
  - **Verification**: `npx tsc --noEmit` 0 errors ✅, `npm test` 141 cases passed ✅, `npm run build` ✅, `npx prettier --check` ✅, `scripts/check-mcp-columns.py` ✅, `scripts/check-doc-links.py` ✅.

- **Unreleased — Add "Clear Session" to session cards + change copy buttons to icons (#301)**

  - **#301 Session cards missing clear button + copy buttons visually noisy**: Each card only had one action — "Open in browser". Users wanting to clear ended/mistaken sessions had no UI path, only manual SQLite UPDATE. Backend `clear_session` command was already in place, frontend `api.clearSession(key)` was already wrapped, only the frontend button was missing. Comment also noted: copy buttons were vertical text, visually noisy. See [docs/issue-301-session-clear.md](./issue-301-session-clear.md).
  - **Clear session**: Added a trash icon button to the card action area. Click opens a `ConfirmDialog` for confirmation. On confirm, calls `api.clearSession` + `loadSessions()` to refresh, card removed immediately. Errors go through the existing error channel.
  - **Copy buttons to icons**: All three copyable rows (branch/dir/session) changed to icon buttons — default copy icon, briefly switches to check icon on success (1.5s), tooltips preserved.
  - **2 new i18n keys**: `sessions.clear` + `sessions.clearConfirm`, 1 each in zh-CN / en-US.
  - **No schema / no backend change**: pure frontend UI + i18n, reusing existing `clear_session` command.
  - **Verification**: `npm run i18n:check` 373 keys / locale ✅, `npx tsc --noEmit` 0 errors, `npm test` 136 cases passed, `npm run build` ✅, `npx prettier --check` ✅, `cargo test` 24 cases passed, `scripts/check-mcp-columns.py` ✅, `scripts/check-doc-links.py` ✅.

- **Unreleased — Add Session ID to session cards + fix work_dir write path (#300)**

  - **#300 Session cards missing Session ID + work_dir always empty**: `list_tasks` already returns `sessionId`, but the card didn't display it; `record_session`'s `work_dir` parameter was added in #287, but the write entry points were incomplete (hooks.rs prompt, session-start.sh, AGENT_INSTRUCTIONS.md, task-handoff.md all missed `work_dir`), resulting in all 17 active sessions having empty `work_dir`. See [docs/issue-300-session-card.md](./issue-300-session-card.md).
  - **Session ID display**: Added a "Session" row to the card, showing `task.sessionId` in full (no truncation), monospace font + one-click copy button. Positioned after "Dir" row, before "Agent" row.
  - **work_dir write path fix**: hooks.rs `script_variant` prompt adds `(branch, work_dir)`; taskboard-session-start.sh example adds `work_dir` parameter; AGENT_INSTRUCTIONS.md trigger table + 2 examples add `work_dir`; task-handoff.md (claude) adds `work_dir=$(pwd)`; task-handoff.md (opencode) adds `work_dir` auto-fill note. opencode plugin already has `work_dir` auto-fill logic, no change needed.
  - **2 new i18n keys**: `sessions.sessionId` (Session) + `sessions.copySession` (Copy session ID), 1 each in zh-CN / en-US.
  - **No schema / no Rust change**: pure frontend UI + i18n + hooks scripts + docs.
  - **Verification**: `npm run i18n:check` 371 keys / locale ✅, `npx tsc --noEmit` 0 errors, `npm test` 136 cases passed, `npm run build` ✅, `npx prettier --check` ✅, `cargo test` 24 cases passed, `scripts/check-mcp-columns.py` ✅, `scripts/check-doc-links.py` ✅.

- **Unreleased — Remove page title from Task Sessions panel (#298)**

  - **#298 Panel title duplicated with sidebar**: The "Task Sessions" panel displayed a large page title "Task Sessions" at the top, while the sidebar's active nav item already highlighted "Task Sessions" — completely redundant, and taking up an entire row at the top of the panel. See [docs/issue-298-sessions-title.md](./issue-298-sessions-title.md).
  - **How**: Removed the `<header>` and `<h2>` elements from the top of `SessionsPanel.tsx`, so the panel content area starts at the top. Reference: Agent panel retains its title because it has action buttons in the toolbar; Sessions panel has no top-level actions, so the title row is pure redundancy. Cleaned up `sessions.title` i18n key (1 each in zh-CN / en-US), retained `sessions.title_format` (card title format, unrelated).
  - **No schema / no Rust change**: pure frontend UI + i18n change.
  - **Verification**: `npm run i18n:check` 369 keys / locale ✅, `npx tsc --noEmit` 0 errors, `npm test` 136 cases passed, `npm run build` ✅, `npx prettier --check` ✅, `scripts/check-doc-links.py` ✅.

- **Unreleased — PR body bare #N references incorrectly associated (#299)**

  - **#299 PR body bare #N references incorrectly associated**: `parse_issue_refs` in `sync.rs` treated every bare `#N` in PR bodies as a linked issue, so a passing mention of an issue number (e.g. PR #1342 mentioning `#1340`) caused a false association even when the two were unrelated. See [docs/issue-299-pr-linkage.md](./issue-299-pr-linkage.md).
  - **How**: `parse_issue_refs` now only matches references preceded by closing keywords (Closes/Fixes/Resolves/Refs/References/关闭/解决/修复), consistent with `scripts/merge-cleanup.py`'s `CLOSE_RE`. Word-boundary check before keywords prevents substring false-matches (e.g. `prefixfixed`), but allows preceding Chinese characters (e.g. `已关闭 #284`). After keywords: whitespace, optional colon, repo prefix, and consecutive references (`Closes #1 #2 #3` matches all three in one pass).
  - **Impact**: PR body bare `#N` no longer associates; only keyword-prefixed references do. Previously mis-associated PRs will be cleared on next sync. MCP `record_session` / `set_work_branch` unaffected (they query by `issue_key`, not PR association).
  - **Verification**: 9 new test cases covering keyword matching, bare-reference rejection, Chinese keywords, URL anchors, prefix substrings; `cargo test --lib parse_issue_refs` 9/9 pass, `cargo test --lib` 116/116 pass, `cargo clippy -- -D warnings` 0 warnings, `scripts/check-doc-links.py` ✅, `scripts/check-mcp-columns.py` ✅.

- **v0.6.2 (2026-09-20) — Task Sessions overview: standalone panel for active sessions (#287)**

  - **#287 How many tasks am I working on, and on which branches**: users need a quick overview of "how many tasks am I working on simultaneously, and on which branch each one is" — a consolidated view of all active sessions. Core requirements: (1) record project directory + branch + session + agent + time (2) standalone panel display (3) auto-write on task-start + manual view (4) auto-cleanup on task completion (5) quick overview. See [docs/issue-287-task-sessions.md](./issue-287-task-sessions.md).
  - **Data model**: `tasks` gains `work_dir` column (`TEXT NOT NULL DEFAULT ''`), reusing existing `work_branch` / `session_id` / `session_agent` / `session_at`. `touch_session` (common.rs) gains `work_dir: Option<&str>` parameter, only written when non-empty (same pattern as `work_branch`).
  - **Read path**: new Tauri command `list_active_sessions`, returns all tasks where `session_id IS NOT NULL` (sorted by `session_at DESC`). MCP `SELECT_COLS` synced (Rust 28 cols + Python 28 cols), `row_to_value` positional indices updated.
  - **Auto-cleanup**: `update_task_status` auto-calls `clear_task_session` when status becomes `done` (clears `session_id` / `session_agent`, preserves `session_at` for audit).
  - **Frontend**: new standalone `SessionsPanel.tsx` (parallel to Notes panel), sidebar gains "Task Sessions" nav item. Session cards show: task title + number, work branch (copyable), work directory (copyable), agent name, start time (relative), click to open GitHub issue. `Task` type gains `workDir` field, `taskSig.ts` fingerprint includes `workDir`.
  - **task-start integration**: `.claude/commands/task-start.md` adds `work_dir=$(pwd)` parameter; `.opencode/plugins/taskboard.js` auto-fills `work_dir` (project directory) in auto-start and `tool.execute.before`; `.opencode/commands/task-start.md` documents that `work_dir` is auto-filled by the plugin.
  - **Docs**: `AGENTS.md` / `mcp_server/AGENT_INSTRUCTIONS.md` / `AGENT_INSTRUCTIONS.en.md` updated with `record_session` tool signature (added `work_dir?` parameter).
  - **Verification**: `scripts/check-mcp-columns.py` ✅ (28 cols consistent), `scripts/check-doc-links.py` ✅, `npm run i18n:check` 369 keys per locale, `npx tsc --noEmit` 0 errors, `npm test` 13 files / 136 cases, `cargo check` compiles.

- **v0.6.1 (2026-09-19) — Board goes blank after "Sync now" until app restart (#285)**

  - **#285 After clicking "Sync now", the current account's board went completely blank and only recovered after restarting the app**: the root cause was in the product layer, not the sync itself — once a sync finishes, the frontend always runs one `listTasks`, and under some filters that query either errored out or returned an empty set unconditionally, so "no data" was written into state and the board cleared; `ownership` is local frontend state that resets to "all" on restart, which is why a restart recovered it. Both defects live in `commands.rs::rows_to_tasks` (see [docs/issue-285-sync-empty-board.md](./issue-285-sync-empty-board.md)).
  - **Defect A (column-count mismatch)**: the ownership-filter SELECT dropped the two `#278` columns `parent_issue` / `sub_issues` (27 → 25), but the mapper reads positional indices 25/26 fixed, so `Row::get(25)` went out of bounds and `list_tasks` errored wholesale — breaking the "assigned / notassignee / assigned-others" filters.
  - **Defect B (empty `meta.login`)**: the `my-created` filter read `meta.login` as "me", but that field is only written by the v0.3.15 single-account `save_pat`; `add_account` / `device_login_poll` never write it, so in a multi-account production DB it is always empty — making that filter return an empty set unconditionally.
  - **How**: unified all filter branches onto a single `TASK_SELECT_COLUMNS` (27 cols) + one shared `task_mapper`, eliminating the "ownership branch dropped columns" class; added `my_logins` to resolve the login set from the `accounts` table by view scope (aggregate = all accounts, single account = filtered / active account, **never `meta.login`**); pulled out `read_active_account_id` for the fallback. `doSync` (#19) now snapshots the filter at click time and refreshes through the `loadWith` coalescer (avoiding clobbering from the concurrent coalesced `load` triggered by `onSynced`), and explicitly re-pulls `project_statuses` / account columns after sync — because sync clears and rewrites `project_statuses`, and stale columns would also drop new tasks outside every column.
  - **No schema change**: no SQLite touch, no new columns, no migration change.
  - **Verification**: 3 new Rust regression tests (`ownership_filter_returns_matching_rows_without_column_error` / `my_created_uses_account_login_not_legacy_meta_login` / `active_account_id_drives_default_filter`) reproduce and fix both defects, including aggregate view and the "account login empty → empty set" boundary; `cargo test --lib` 9 command-module cases green, `cargo clippy -- -D warnings` 0 warnings, `tsc --noEmit` 0 errors, `npm run build` ✅, `npm test` 13 files / 136 cases, `i18n:check` 356 keys per locale, `npm run lint` 18 warnings (within `--max-warnings 20`), `prettier --check` ✅, `scripts/check-mcp-columns.py` ✅, `scripts/check-doc-links.py` ✅.

- **v0.6.1 (2026-09-19) — Add project open-source license (#281)**

  - **#281 The repository had no license statement at all**: no `LICENSE` in the root, and no `license` field in either `package.json` or `Cargo.toml`. Legally this means **all rights reserved by default** — anyone can fork and read, but nothing grants permission to copy, modify or distribute. It's the most common compliance gap on GitHub. A license declaration lives in four places (the `LICENSE` file, the `license` fields in both package managers, the README, and CONTRIBUTING), and missing any one of them means downstream tooling can't read it. See [docs/issue-281-license.md](./issue-281-license.md).
  - **License chosen: MIT** — the issue's own recommendation, on three grounds. ① **Stack convention**: Tauri core and `tauri-plugin-updater` are MIT, `rusqlite` / `serde` / `react` are all MIT, `@tauri-apps/cli` is Apache-2.0 — a fully permissive dependency tree with zero MIT conflicts. ② **Fits the project**: a personal productivity tool, not a commercially integrated component — no need for Apache-2.0's explicit patent grant, and copyleft would actively block users from modifying it (GPL / AGPL clash head-on with "personal tool, take it and go"). ③ **Low contribution bar**: MIT only asks for the copyright notice to be retained, so PR authors don't need to understand modification-statement obligations. The full decision table (MIT / Apache-2.0 / GPL-3.0 / AGPL-3.0 trade-offs) is in the KB doc §2.
  - **Landed**: new root `LICENSE` (canonical MIT text, only the copyright line changed to `Copyright (c) 2026 ShawnLiuSZ` — matching the owner attribution used throughout the README / CI / release artifacts; the older short form `authors = ["liushizhao"]` in `Cargo.toml` was deliberately left alone to avoid widening the diff); `license = "MIT"` added to both `app/package.json` and `app/src-tauri/Cargo.toml`; a license badge under the preview image and a "License" section at the bottom of `README.md` / `README.en.md` (stating the single obligation — retaining the copyright notice — and noting the disclaimer exists); a new license section in `CONTRIBUTING.md` (a PR is a contribution under MIT, third-party code you introduce is your responsibility to check for compatibility, and each dependency keeps its own `LICENSE`).
  - **Deliberately not done**: ① The SPDX identifier `MIT` is used, not the natural-language string `"MIT License"` (which normalises to `Unknown` in `npm license` / `cargo metadata`), **not** `MIT-0` (which drops the retain-the-copyright-notice obligation — retaining it is a free benefit for upstream traceability, and dropping it buys nothing), and not npm's historical `ISC` (different text, would mislead license scanners); ② `Cargo.lock` untouched — Cargo only records `license` for registry packages; local path packages (including the workspace root) record only name / version / dependencies, verified via `cargo metadata --locked`; ③ `package-lock.json` untouched — `license` takes no part in dependency resolution, and `npm ci`'s sync check only compares `dependencies` / `devDependencies`; the lock's root entry was already version-stale relative to `package.json`, so the diff was not widened. `"private": true` in `package.json` does not conflict with the new `license`: the former only blocks `npm publish`, the latter is metadata for consumers.
  - **Verification**: `package.json` is still valid JSON with `license` parsing as `MIT`, `cargo metadata --locked` passes (no invalid-license error), `npm ci` passes (exit 0, no lock-mismatch complaint), `scripts/check-doc-links.py` ✅ (new relative `LICENSE` links and the badge URL all resolve), `scripts/check-workflow-yaml.py` ✅, `scripts` unit tests green (the latter two as a regression guard — no workflow or script was touched here).
  - **No schema / no code changes**: no SQLite, no Rust business logic, no frontend, no MCP dual implementation, no CI config touched — pure repository metadata and documentation.

- **v0.6.1 (2026-09-19) — Automated post-merge cleanup: delete branch + close linked issues (#284)**

  - **#284 Manual cleanup after every merge**: deleting the `feature/issue-N-xxx` branch and closing the issues declared in the PR title / body had to be done by hand on every single merge — and neither step involves any judgment (the branch name and issue numbers are already in the PR metadata). A frequently overlooked fact: GitHub's closing keywords (`Closes #N`) only fire when a PR merges into the **default** branch, `main`; day-to-day development merges into `develop`, so for the vast majority of PRs a `Refs #N` never triggers an automatic close. Manual closing is the norm, not the exception. See [docs/issue-284-merge-cleanup.md](./issue-284-merge-cleanup.md).
  - **How**: new `merge-cleanup.yml`, triggered on `pull_request: closed` with `merged == true` and base ∈ {`develop`, `main`}. It runs `check-workflow-yaml.py` against every workflow **before** any write — if the config isn't validated, nothing is written. The extraction rule is a pure function, `extract_issue_refs`, and is **deliberately conservative: rather miss a close than close the wrong issue**. PR **titles** match `#N` outright; PR **bodies** only match references carrying a closing keyword (`Closes` / `Fixes` / `Resolves` / `Refs` / `关闭` / `解决` / `修复`) — a bare `#N` in the body is never closed, because this repo's PR bodies routinely cite historical issues ("following the lessons of #155 / #175 / #237"), and a bare match would post comments into long-closed, unrelated issues. Safety rails: skip deletion for forks; skip deletion when the title contains `test` / `draft` (keeps the scene intact while validating this workflow itself); never delete when the remote branch sha differs from the PR head sha; skip already-closed issues without re-commenting; a single-item failure only emits `::warning::` and never interrupts. The PR body travels via the `GITHUB_EVENT_PATH` event payload file rather than a shell variable — bodies contain single quotes, backticks and multi-line code blocks, and escaping is a hazard.
  - **Also closed the zero-coverage gap in workflow syntax**: CI previously ran only i18n / MCP column names / doc links — **nothing ever touched `.github/workflows/`**. New `check-workflow-yaml.py` (zero dependencies, line-oriented structural checks, deliberately **not** PyYAML — GitHub-specific constructs such as `${{ }}` expressions and `on:` being parsed as a YAML 1.1 boolean make general parsers more prone to false positives) catches 9 defect classes: tab indentation, odd indentation on structural lines, duplicate keys within a scope, missing `name`/`on`/`jobs`, `on:` with no trigger, jobs lacking both `runs-on` and `uses`, steps lacking both `uses` and `run`, unpinned third-party actions, `${{ "..." }}` quote collisions, unquoted `if:` scalars containing `: `, empty or malformed `permissions:`, and referencing `scripts/` without a checkout. The checker itself is also run in CI, so it has a **two-sided** requirement — a single false positive turns every PR red, and the eventual outcome is just deleting the check — so both directions are covered by tests. `quality-check.yml` gains a `scripts-checks` job that runs on every PR.
  - **Real defects caught by the tests**: `args.dry-run` (Python parses it as `args.dry - run` → `AttributeError`; unreachable from pure-logic unit tests, only the dry-run integration tests trigger it); `rest = s[len(key):]` left the colon inside the value (`if: >-` became `": >-"`, so the first version reported 30 false positives across all 6 workflows); `on_block` / `jobs` reset at every top-level key (always empty after the loop); step sub-keys recorded against `job.keys` (every two-line step flagged as both "empty step" and "duplicate key"); `run: |` flushed before `has_run` was set; odd indentation enforced inside block scalars (odd continuation indent under `if: >-` is a legal format); `USE_RE` not matching the inline `- uses:` form (this repo's most common style was never checked at all); `strip_comment` comparing a 3-character slice against the 2-character string `"}}"` (never equal, so expression depth only reset when `}}` happened to sit at end of line); and a missing `actions/checkout` in `merge-cleanup.yml` (a runner workspace is empty by default, which fails silently with "file not found"). Review caught two more: `CLOSE_RE` used `\b` as its word boundary (CJK characters are all `\w`, so `已关闭 #284` could never match); and branch deletion issued **two** GETs against the same endpoint (collapsed into a single `head_branch()` call, saving one round trip).
  - **Verification**: `python3 -m unittest discover -s scripts -p 'test_*.py'` **62 green** (`test_merge_cleanup.py` 29 = 21 extraction cases + 8 dry-run cases driving full `main()`; `test_workflow_yaml.py` 33 = positive regression over the 6 existing workflows + reverse verification of every claimed defect class + parser unit tests), `scripts/check-workflow-yaml.py` all 6 workflows green, `scripts/check-mcp-columns.py` ✅ (26 columns, both sides identical), `scripts/check-doc-links.py` ✅ (135 markdown files, no broken links). Four dry-run scenarios verified: normal path; fork skipping deletion while still closing the issue; `test` marker skipping deletion; body containing only bare references closing nothing — all exit 0 with no network calls at all.
  - **Follow-up ([#289](https://github.com/ShawnLiuSZ/task-dashboard/issues/289) — only surfaced by the first real merge)**: after PR #287 merged, the workflow ran for real for the first time. Closing the issue worked (#284 was automatically CLOSED), but **branch deletion failed** — the runner logged `::warning::删除分支 feature/issue-284-merge-cleanup 失败（HTTP 404）` and the remote branch was still there. Root cause: the DELETE used the **singular** `/git/ref/heads/{branch}`, and on GitHub `git/ref/{ref}` (singular) **has a GET route but no DELETE route**, so it returns 404 for any branch name. The trickier part: GET routes both singular and plural, so "branch exists + sha matches" all came out green, every safety rail passed, and only the DELETE step 404'd — **the read path completely masked a write-path bug**. Every branch in this repo is `feature/issue-N-xxx` (containing `/`), so the defect applied to every branch from day one; and dry-run makes no network calls at all, so 62 green tests never caught it. Fix: a pure `ref_head_path()` helper that GET and DELETE now **share the same path** (plural `/git/refs/heads/`; the `/` is deliberately left unencoded — the endpoint accepts both encoded and literal `/`, and a literal one keeps branch names readable in the logs). New tests: `RefPathTest` 4 cases (including an explicit reverse assertion that `/git/ref/` must never appear in the path) and `BranchDeleteFlowTest` 4 cases (`mock.patch.object` on `api`, zero real network, driving the non-dry-run paths: correct endpoint / sha mismatch keeps the branch / branch already gone / DELETE failure warns only and does not stop the issue close) — **70 green**. Reverse verification: reverting the endpoint to singular fails 5 cases. Live re-check: a temporary `probe/merge-cleanup-verify` branch was actually deleted by the script, confirmed gone via `git ls-remote`, exit code 0.
  - **No schema / no frontend changes**: no SQLite, no Rust, no frontend, no MCP dual implementation touched — pure repository engineering automation.

- **v0.6.1 (2026-09-19) — Task detail shows parent / sub issues with open & copy actions (#278)**

  - **#278 Task detail didn't show an issue's parent / sub relationships**: GitHub issues support parent/child relationships (sub-tasks), but TaskBoard's detail panel didn't surface them at all — if an issue sat under a parent, or had sub-tasks of its own, the board showed nothing, and you had to leave the app to check GitHub. Requirement: show the parent issue number plus the sub-issue list, and make the parent and every sub-item openable in the browser and copyable as a link. See [docs/issue-278-issue-links.md](./issue-278-issue-links.md).
  - **How**: two new columns on `tasks` — `parent_issue` / `sub_issues` (`TEXT NOT NULL DEFAULT ''`, holding a JSON object / array with only `number` / `title` / `url`) — instead of a link table: the relationship is asymmetric (0..1 / 0..N), takes part in no local logic (status sync, filtering and sorting never touch it), and MCP can pass the JSON string straight through, saving a table, a CRUD set, and one more dual-implementation to keep in sync. Sync uses **batched alias GraphQL**: grouped by `(owner, repo)`, numbers sorted and deduped, then 25 per request (`a0` / `a1` … each `issue(number: N)`), keyed by each node's own `number`. `subIssues` is behind a feature flag, so the `GraphQL-Features: sub_issues` header is injected into **every** request from `graphql()` rather than duplicating a POST implementation for this one query. Failure handling is best-effort per repository: a failed group only skips that repo and **keeps its existing values** (logged, never aborting the sync) — the same trade-off as PR association — while a successful fetch that finds the relationship removed writes empty strings to clear it.
  - **Interface / migration**: `common.rs` gains `IssueLink` / `IssueLinks` plus silently-degrading `parse_parent_link` / `parse_sub_links` (one bad row can't break the list); `github.rs` gains `fetch_issue_links` and two pure functions; `commands.rs`'s `Task` exposes `parentIssue` / `subIssues` (appended at the end of both SELECTs, positional indices 25/26); `on_demand.rs` can't get the relationship from a single-issue REST pull, so both columns are written empty. `open_db()` applies an idempotent hot-path `ALTER` — **not** only inside `migrate_legacy_alters`, which runs solely when `user_version < 1`, because the v2 physical rebuild's hard-coded-column `INSERT..SELECT` would drop the column. Same migration lesson as #155 / #175 / #237. The frontend adds a "Linked issues" block that renders **only when there is something to show** (reusing `openExternal` / `copyToClipboard`) plus 3 i18n keys; MCP `SELECT_COLS` grows 24 → 26 columns, column-for-column and order-for-order identical across Rust and Python, passing the JSON strings through untouched.
  - **Verification**: `cargo test` 135 green (111 lib + 24 db, including three migration regressions — v2 backfill, no column loss after rebuild, clear-on-conflict and update-on-conflict — three pure-function tests for query layout and parser degradation, and a 26-column no-misalignment assertion for MCP), `cargo clippy -- -D warnings` 0 warnings, `tsc --noEmit` 0 errors, `npm run build` ✅, `npm test` 13 files / 136 tests, `i18n:check` 356 keys per locale, `npm run lint` 18 warnings (within `--max-warnings 20`), `prettier --check` ✅, `python3 -m unittest discover -s mcp_server` 29 green, `scripts/check-mcp-columns.py` ✅ (26 columns, both sides identical), `scripts/check-doc-links.py` ✅. Live check of the alias query (with the feature header): `errors: null`, `parent: null`, `subIssues.nodes: []`, aliases and `owner.login` returned correctly.

- **v0.6.1 (2026-09-19) — `work_branch` still pinned to the baseline branch (develop/master) after starting a task (#279)**

  - **#279 `work_branch` not updated after starting a task**: a user assigns an issue to an agent; the agent "starts the task" while still on `develop` / `master`, then only later creates / switches to that issue's work branch. The branch is created on GitHub, but the board detail's `work_branch` still points at the baseline branch. Root cause: both `task-start` slash commands captured the branch in step 1 — while the agent was still on the baseline branch — and wrote it into `work_branch`; the opencode variant filled it in even earlier, at command-expansion time. See [docs/issue-279-work-branch-not-updated.md](./issue-279-work-branch-not-updated.md).
  - **How**: two complementary fixes — ① rewrote both `task-start` commands and the prompt-reminder hook to **switch to the issue's work branch first, then record the session** (branch capture moved after the switch); ② added a narrow tool `set_work_branch(issue, branch)` that the agent calls after switching to correct `work_branch` — it writes only `work_branch` and never touches the PR `branch` that sync pulls automatically. Implemented consistently in Rust (`common.rs` / `commands.rs` / `mcp.rs`, with 3 mcp tests) and Python (`mcp_server/server.py`, with 3 unit tests); `record_session`'s `branch` parameter is unchanged.
  - **Verification**: `cargo test --lib` green (3 new cases), `python3 -m unittest discover -s mcp_server` 29 cases green, `scripts/check-mcp-columns.py` ✅, `scripts/check-doc-links.py` ✅.

- **v0.6.1 (2026-09-19) — Restart button added to manual-download flow (#272)**

  - **#272 No restart option after manual download**: the `about.restart` button only appeared in the `installed` phase (after the updater channel's `installAppUpdate()` resolved). When the updater failed and the UI fell back to the manual download branch (`manualUrl`), clicking "Go to download" opened the browser and left the app with **no restart button at all** — the user had to manually quit and reopen. See [docs/issue-272-restart-after-manual.md](./issue-272-restart-after-manual.md).
  - **How**: a secondary "I've installed it — restart app" button was added to the manual-download branch of the `available` phase, reusing the existing `api.restartApp()` (Tauri 2 `app.restart()`). The label makes the "install first, then restart" ordering explicit. Pure frontend + i18n change — zero Rust / schema changes.
  - **Verification**: `tsc --noEmit` 0 errors, `npm test` 136 passed, `i18n:check` 350 keys per locale.

- **v0.6.1 (2026-09-19) — Codebase-wide hidden-bug batch fix**

  - **Python MCP `serverInfo.version` hard-coded 7 minor versions stale**: `mcp_server/server.py:953` returned `"version": "0.3.47"` (actual app is 0.6.1), diverging from Rust's `mcp.rs` which uses `env!("CARGO_PKG_VERSION")`. Agents reading `initialize.serverInfo.version` get a misleading capability signal. Updated to `"0.6.1"`.
  - **Python MCP `ensure_schema` only added 2 columns, missing 6**: `server.py:139` only ALTERed `branch` / `handoff`, but `SELECT_COLS` references `project_status` / `candidate_done` / `account_id` / `work_branch` / `author` / `comments_count`. Against a partially-migrated DB this raised `no such column` hard failures. All 6 columns now added.
  - **Device-login poll loop never cancelled on unmount**: `AccountsPanel.tsx`'s `while` loop was only cancellable via UI actions, not on unmount — it kept calling `device_login_poll` and `setState` on an unmounted component (network leak every few seconds). Added a `useEffect` cleanup that increments `oauthRunRef`.
  - **AgentPanel read stale `targetDir`**: `refreshHooksStatus`'s `useCallback` deps were missing `targetDir`, so after typing a path, refresh still sent `target_dir=null` → backend error "target directory is empty". Added to deps.
  - **Hooks auto-refresh missing empty-target guard + omitted `hooksBusy`**: switching to project scope without typing a path triggered a refresh → error banner; changing scope mid-operation never re-refreshed. Added guard and deps.
  - **`handleSwitchView` read stale `filterRef`**: after `await loadSettings()`, the passive effect hadn't refreshed `filterRef` yet, so `load()` queried with the old `accountFilter`. Changed to pass `accountId` explicitly (same fix as `handleSwitchAccount`).
  - **`onUpdateProgress` listener leaked if unmounted before `listen()` resolved**: AboutPanel's `listen()` Promise hadn't resolved when the modal closed → listener never unregistered, kept firing `setState`. Added `cancelled` flag (same pattern as App.tsx).
  - **`quarantine-cleared` event never received by frontend**: #101's macOS Gatekeeper auto-clear `emit`s an event at app startup, but the frontend hasn't loaded yet → the message is always lost. Changed to store in `AppState.quarantine_notice` (`Mutex<Option<String>>`), added `get_quarantine_notice` command for frontend polling (one-shot, backend auto-clears after read), App shows a warn banner on startup (click to dismiss).
  - **`taskListSignature` fingerprint missing `workBranch`**: `taskSig.ts` omitted `workBranch` from the fingerprint computation, so when an agent updated `work_branch` via `record_session`, the frontend didn't detect the change (`signature` unchanged → `useEffect` skipped re-render). Now included.
  - **`iso8601_to_secs` panics on empty string**: `common.rs`'s `iso8601_to_secs` called `.unwrap()` on a parse result that could be `Err` for empty input. Changed to `.unwrap_or(0)`, consistent with the `created_at DEFAULT 0` semantics.

- **v0.6.1 (2026-09-19) — Task card shows issue creation time (#280)**

  - **#280 Card lacks a creation-time dimension**: users need to know when an issue was created to gauge task freshness. See [docs/issue-280-created-time.md](./issue-280-created-time.md).
  - **How**: new `created_at` column on `tasks` (`INTEGER NOT NULL DEFAULT 0`), parsed from GitHub Search API + REST responses as RFC3339 and converted to Unix seconds; card inserts a "Created" row between "Created by" and "Assignees" (`YYYY/MM/DD HH:mm` format, hidden when value is 0); MCP `SELECT_COLS` gains the new column (27 total); new i18n key `card.createdAt`.
  - **No breaking schema change**: existing databases get the column via idempotent `ALTER TABLE`, `DEFAULT 0` is transparent to existing rows.

- **v0.6.1 (2026-09-19) — Search state not reset after account switch (#286)**

  - **#286 Cross-account search interference**: searching for an issue number in account A then switching to account B left the search query intact, filtering the new account's board to zero results. See [docs/issue-286-search-reset.md](./issue-286-search-reset.md).
  - **How**: `handleSwitchAccount` now resets `query`, `repo`, and `hiddenAfterSync`, matching `clearAllFilters` behavior. Pure frontend change — zero backend / schema changes.

- **v0.6.0 (2026-09-17) — Fix Rust test random disk I/O error (CI flake) (#266)**

  - **#266 Test temp-db naming was not isolated, causing intermittent CI failures**: the `mem_conn()` test helper named its temp DB only by `process::id()` and `remove_file`d it twice per call. Since Rust tests run in parallel within one process, all callers shared the same file and unlinked each other's open DB, so initializing the schema randomly hit `disk I/O error` (green on rerun). `sync.rs:843`'s fully fixed name `taskboard_headless_test.db` was the same class of hazard. See [docs/issue-266-test-flake.md](./issue-266-test-flake.md).
  - **How**: `mem_conn()` now appends a per-call `AtomicUsize` sequence to the temp path (`{pid}_{SEQ}`) so every connection gets its own file, and no longer `remove_file`s while the connection is alive. The `sync.rs` fixed name was also made pid-unique. Added a regression assertion `mem_conn_returns_unique_paths_per_call` (two calls must return different paths). Pure test-helper change — no product code / public API / schema touched.
  - **Verification**: `cargo test --lib -- --test-threads=16` → 102 passed / 0 failed / 3 ignored; 4 consecutive `cargo test --lib` runs all green (including the new assertion). CI `Rust Tests` green across reruns.
  - **Follow-up**: the `sync_target_accounts` test in `sync.rs` and 6 tests in `db.rs` still called `remove_file` / `remove_dir_all` while the connection was alive (the same anti-pattern #266 fixed for `mem_conn()`, missed during that fix). Cleaned up in this release — all now `drop(conn)` before cleanup, eliminating the silent sharing-violation failure on Windows and the orphaned `-wal`/`-shm` files on Unix.

- **v0.6.0 (2026-09-17) — Multi-account sync now covers all accounts (#262)**

  - **#262 Multi-account sync was broken: only the active account was ever synced.** With ≥2 GitHub accounts configured, all four sync triggers (manual / scheduled / startup / tray) synced only the active account every round, so the 2nd, 3rd… accounts were never pulled and no failure was surfaced. Root cause: the sync target set was gated by `meta.view_mode`, which was permanently stuck at its default `'single'`. Its only writer (the topbar `<select>`) had been deleted by commit `597840b`, so the backend `set_view_mode` command, `api.setViewMode`, and the i18n keys were all left as orphans with no caller — "implemented but unreachable". See [docs/issue-262-multi-account-sync.md](./issue-262-multi-account-sync.md).
  - **How**: adopted the preferred Plan A — **decouple sync scope from view mode**. Sync no longer reads `view_mode`; it always covers every configured account (a multi-account user's core need is "all data in the local DB"). Target selection moved into a small pure helper `sync_target_accounts(conn)` that returns all accounts, making the contract unit-testable. `view_mode` now affects display only (single / aggregated), and the **topbar view-mode `<select>` was restored** (reverting `597840b`'s UI part), re-wiring `api.setViewMode` → `set_view_mode` and eliminating the dead-code `#[allow(dead_code)]` mis-annotation and the dead i18n keys. Bonus fix: in the per-account loop, `get_account_pat(...)?` was changed to a `match` that records the failure and `continue`s, so one account's PAT read error no longer aborts the whole round. `SyncResult` gained an `accountsSynced` field, and the UI banner now shows "覆盖 N 个账号" when ≥2 accounts were synced.
  - **No schema change**: `meta.view_mode` / `active_account_id` still exist and are consumed (now only for display); `SyncResult` is an in-process return struct.
  - **Verification**: new Rust regression test `sync_target_accounts_covers_all_accounts_regardless_of_view_mode` (sets `view_mode=single` + 2 accounts, still asserts 2 targets returned); full `cargo test --lib` 102 passed, `tsc --noEmit` 0 errors, `npm test` 13 files / 136 tests, `i18n:check` 349 keys per locale, `prettier --check` ✅, `npm run lint` 18 warnings (within the `--max-warnings 20` limit), `check-doc-links.py` ✅.

- **v0.6.0 (2026-09-17) — Agent Setup panel: device scan (#263)**

  - **#263 The refresh button becomes a device scan**: one click now reports which agents are **installed** on this machine and which have been **uninstalled**, answering "what agents does this box actually have?". Previously `host_present` was derived purely from whether the config root directory exists (`root.is_dir()` in `hooks.rs`), which caused three gaps: ① an agent whose CLI is on PATH but has never run (no config dir) was reported as **not installed** — measured on this machine, `codex` is on PATH but `~/.codex` does not exist; ② only 5 agents have an `AgentSpec`, so the other 34 always landed in the "manual setup" group with no hint about local installation; ③ after removing a CLI or deleting its `.app`, a leftover config dir (or a live integration) produced no signal at all. See [docs/issue-263-agent-device-scan.md](./issue-263-agent-device-scan.md).
  - **How**: three signal classes are merged — executables found on PATH and in conventional install dirs, `$HOME` config dirs, and `.app` bundles under macOS `/Applications` and `~/Applications` — and the strongest signal becomes `cli` / `app` / `config-only` / `none`. A new `scan_agent_hosts` command returns all 39 probes and diffs them against the previous snapshot (`meta.agent_scan_snapshot`, the only thing this feature writes) to derive "newly installed" / "likely uninstalled"; a first scan reports no changes (otherwise the initial run would flag every installed agent as new). On the frontend the grouping rules moved into a pure module `src/agent-groups.ts`, with a new **Likely uninstalled** group (red dot, showing the residual path inline and reusing the one-click uninstall to clean up) and a per-row device badge (installed via CLI / installed as an app / config residue only / not detected; hidden until a scan has run, to avoid a wall of "not detected"). `status_one` gained an optional probe argument: on the real path an installed-but-never-run CLI now counts as **available to integrate** instead of "not installed", while tests pass `None` to keep the config-dir-only semantics (otherwise assertions would depend on the developer machine's PATH).
  - **No schema change**: no new or altered SQLite tables, just one `meta` key (a key/value table, so old databases degrade gracefully — a missing key means "first scan"). The scan itself is read-only on the filesystem: no network, and no agent config file is written.
  - **Verification**: 6 new Rust tests — including an anti-drift assertion that the `HOST_SPECS` and `app/src/agents.ts` agent-id sets are **identical in both directions** (parsing the frontend source via `include_str!`), the four snapshot-diff transitions (install / uninstall / reinstall / first scan), and case-insensitive app-bundle matching; 11 existing `status_one` call sites were updated with the new argument, semantics unchanged. The frontend adds 15 cases in `src/agent-groups.test.ts` plus one SSR smoke test (button label is "Scan device", and no device badge appears before a scan). `cargo test` 101 + 21 passed / 0 failed, `tsc --noEmit` 0 errors, `npm test` 13 files / 132 tests, `npm run build` ✅, `i18n:check` 347 keys per locale, `check-doc-links.py` ✅. Real-machine rendering verification still needs a dev server (headless Chrome is no longer usable inside this machine's sandbox).
  - **#263 follow-up: groups consolidated to 4** — "Not installed" and "Manual setup" (a *device* axis vs a *capability* axis) were merged into **Not integrated**. Rationale: ① the "is it installed here?" fact that justified the split is now carried by the new **per-row device badge**; ② both groups are equally non-actionable in this panel (no install button — one because the upstream agent isn't installed yet, the other because one-click install isn't verified); ③ the "Not installed" group holds at most 5 candidates and in practice often a single row, so the group header outweighed its content. No information is lost: the inline detail makes each row **describe itself** (manual agents show "Manual setup: ~/.codex/hooks.json", supported-but-absent ones show "Not detected on this device"), and the group-level hint was rewritten to cover both cases; a manual agent flagged as uninstalled still never enters the "Likely uninstalled" group (this panel never installed anything for it, so there is no residue to clean). Along the way the bottom hint was fixed to key off the group result rather than `newlyRemoved` alone (which could show a hint with no cleanable rows). i18n drops `group.missing` / `group.manual` and adds `group.notIntegrated` / `manualPath` / `notDetected` (348 keys per locale); `npm test` is 13 files / 134 tests (including a guard that the 4 groups must not regress to `missing`/`manual`).

- **v0.6.0 (2026-09-17) — Sidebar collapses to icon-only on narrow windows (#265)**

  - **#265 The sidebar collapses to icon-only when the window is narrow**: when the window width drops below `900px`, the left Sidebar automatically collapses from its fixed 200px text+icon navigation into a ~56px icon-only mode — icons stay, while text labels / account names / group titles / empty-state hints are hidden, and account rows are identified by their `title` tooltip. See [docs/issue-265-sidebar-collapse.md](./issue-265-sidebar-collapse.md).
  - **How**: purely responsive and not persisted — `App.tsx` seeds `sidebarCollapsed` from `window.innerWidth < 900` and flips it on `resize`; when the value is unchanged (still false / true) the `setState` is a no-op so dragging across the threshold only re-renders on an actual transition (no manual debounce needed). `Sidebar` gains an optional `collapsed?: boolean` prop and toggles a `.collapsed` class on its root `nav`. The main content stays `flex: 1` and absorbs the 144px the sidebar gives back, so the main area needs no changes. Frontend only — SQLite / Rust untouched.
  - **Verification**: `tsc --noEmit` 0 errors, `npm run build` ✅, `npm test` 13 files / 136 tests (2 new static-regression cases in `styles.test.ts` for the collapsed sidebar), `i18n:check` 348 keys per locale (no new keys), `prettier --check` ✅, `check-doc-links.py` ✅. Real-machine rendering still needs a dev server (headless Chrome unavailable in the sandbox).

- **v0.6.0 (2026-09-17) — Left-right layout + Agent Setup panel (#259)**

  - **#259 Left-right layout refactor**: a new fixed left Sidebar (200px) hosts every entry point — Notes / account list (click-to-switch + add account) / Settings / Agent Setup / Sync Logs / Account Login / About in the footer. The topbar shrank from "account dropdown + 4 buttons + sync" to "brand + total count + last-sync time + sync now". Settings / Accounts / Sync Logs moved from modals to **full-height embedded pages** in the main area (zero changes inside the panel components — handled by the `.panel-page` container + CSS overrides); NotesPanel became a main-area "page", rendered only when selected. See [docs/issue-259-sidebar-nav.md](./issue-259-sidebar-nav.md).
  - **How**: the `activeModal` state was replaced with `nav` (`notes | board | settings | agents | synclogs | accounts`) plus a standalone `showAbout` (About stays a modal); account switching reuses `handleSwitchAccount` and returns to the board view; two new components (`Sidebar.tsx`, `AgentPanel.tsx`); the `main-layout` CSS was replaced by `app-shell` + `main-content`. Frontend only — SQLite / Rust untouched.
  - **Verification**: `tsc --noEmit` 0 errors, `npm run build` ✅, `npm test` 12 files / 99 tests, `i18n:check` 334 keys per locale, `check-doc-links.py` ✅. Real-machine manual QA pending.

- **v0.6.0 (2026-09-17) — Notes page: full-width panel + four side-by-side columns + create-column-only collapse (#259)**

  - **#259 Notes four-column layout fix**: on a real machine the four columns were squeezed into ~18px slivers (text wrapping character by character), the panel occupied only the left quarter of the main area, and the four-column region still carried an internal horizontal scrollbar; the four columns were never side by side at any window size either (2+2 at the 1180×760 default, 3+1 at 1440, four stacked rows at 900). **Two defects stacked**: ① `NotesPanel` put an inline `style={{flex:'0 0 25%', width:'25%'}}` on the panel (a leftover from the `#202` resize feature); inline styles outrank stylesheets, so the `.notes-page .notes-panel { flex:1 1 auto; width:100% }` "fill the page" override **never took effect** (measured panel width 245px — narrower than the create column's own 280px, leaving the four-column region just 20px ⇒ horizontal scrollbar); ② the columns were fixed `flex: 0 0 260px` inside a `flex-wrap: wrap` container, needing 1076px ⇒ guaranteed wrapping. See [docs/issue-259-sidebar-nav.md](./issue-259-sidebar-nav.md).
  - **How**: first removed the `#202` width machinery (`widthPct` / `clampNotesWidthPct` / `readNotesWidthPct` / `.notes-resizer` / `notes.resizeTitle` / drag and keyboard handlers) and made `.notes-panel` a page-shaped element (`flex: 1 1 auto` + `min-width/min-height: 0`, dropping the 320px lock / sticky positioning / 50% cap) so an inline width can never be reintroduced; then rebuilt the four columns along the existing board `.column` pattern — container lost `flex-wrap` and gained `overflow: hidden`, `.note-col` became `flex: 1 1 0` + `min-width: 0`, vertical scrolling moved into `.note-col-body`, and narrow columns wrap instead of clipping (`.note-card { min-width: 0 }` + `.note-foot { flex-wrap: wrap }`). The **collapse granularity changed from the whole panel to the create column only** (a 30px `.notes-add-rail` sibling of the four-column area), the four columns always render even with zero notes, and the create-column textarea fills the column height. Dead CSS (`.notes-panel.collapsed` / `.notes-rail*` / `.notes-add-col-open` / `.notes-empty*` / `.notes-resizer*` / `.notes-date-list` / `.notes-group*`) and 5 unused i18n keys (337 per locale) were removed, along with the now-defunct `notes-width.test.tsx`. Frontend only — SQLite / Rust untouched.
  - **Verification**: the corrected isolated repro page (with the previously missed inline style) reproduces the panel at `245x617`, the four-column region at `20x575` (`scrollLeft=260`, i.e. scrollable) and the columns at `w260@top52 | w260@top329`; `app/src/components/notes-layout.test.ts` grew to 12 cases (including "the panel element must carry no inline width" and "`.notes-panel` must not return to a fixed 320px / sticky / 50% cap"), **reverse-verified** by reintroducing 5 defect patterns in one round (7 assertions fail; restored byte-identically afterwards). ⚠️ **Post-fix rendering verification could not be completed**: headless Chrome no longer starts inside this machine's sandbox (`sandbox initialization failed`, escalation not applied), so the visual result needs confirmation in the `npm run tauri dev` window. `tsc --noEmit` 0 errors, `npm test` 12 files / 105 tests, `npm run build` ✅, `i18n:check` 337 keys per locale, `prettier --check` clean on new/changed files, `check-doc-links.py` ✅.

  - **#259 notes interaction finalized (round 3): the four columns become board-style columns** — they now have a **fixed width equal to the leftmost create column** (`--notes-col-w: 280px` defined on `.notes-panel`, shared by `.notes-add-col` and `.note-col`, so one variable retunes everything), and when they don't fit the region shows an **intentional** horizontal scrollbar (`.notes-card-cols` declares `overflow-x: auto` explicitly, no wrapping) — matching the board's task columns. Note cards **no longer use a colored left bar** for priority (`.note-card::before` removed; `--note-accent` is now only used by the label dot in the card footer). A fixed column width structurally removes the "container gets narrow ⇒ columns squash into slivers" class of failure, **superseding** the previous equal-share + no-scroll approach. 13 regression cases, reverse-verified by injecting 5 defect patterns in one round (3 new assertions fail; the first injection script was a false pass because its `overflow-x: auto` fragment matched a different rule in the file — injections are now selector-anchored and asserted to hit).

  - **#259 notes round 4: visible column frames + no dead space on wide windows** — on a real machine the four columns' frames were **invisible**: `.notes-panel` and `.note-col` were both `--surface-2`, so the columns melted into the page and looked like cards floating in blank space (the "inconsistent top margins" the user marked were hand-drawn boxes around different content); and the fixed 280px columns left a large blank area on the right of a wide window. Fix: the panel background became `var(--bg)` (same as the board page ⇒ the surface-2 column frames are visible, i.e. the board's own styling); `.note-col` became `flex: 1 1 0` + `min-width: var(--notes-col-w)` (on wide windows the four columns share the width **with no dead space**, on narrow windows they never go below 280px and the excess scrolls horizontally — satisfying both "fairly fixed width + horizontal scrollbar" and "width matches the panel"); the create column got the **same frame** as the other columns (surface-2 rounded block, `border-right` dropped) with `.notes-body` unifying `gap/padding`; `.notes-card-cols` declares `align-items: stretch` explicitly (full-height columns, equal to the create column); the empty-column hint now matches the board's `.empty` grey text. 16 regression cases, reverse-verified (4 defects ⇒ 4 new assertions fail).

  - **#259 notes round 5: header row removed, import/export moved into the create column; uniform column-head spacing** — the header (Notes title + count + import/export + collapse) duplicated the sidebar title and consumed a full row of vertical space, so it is gone (`.notes-head*` / `.notes-tools` CSS removed; `.notes-head-icon` kept — AgentPanel still reuses it); import/export and "collapse create column" moved into a **tool row at the top of the create column** (hidden while the column is collapsed); the head-to-content gap is now uniform (`margin-bottom 2px→0` on the head, `padding-top 0→8px` on the body, no extra padding on the empty hint) — previously a column with records had only 2px of top spacing, inconsistent with empty ones; `.notes-body` padding matches the board (`12px 16px 16px`). 19 regression cases, reverse-verified (header regression / tools moved out of the create column / spacing reverted ⇒ 3 assertions fail; injection anchors must use the target node's own signature — `fileInputRef` first occurs at its declaration, which once cut the wrong block and produced a false pass).

  - **#259 notes round 6: column heads at different heights** — the column with records (whose body scrolls internally) had its head ~5-7px higher than the empty columns'. Pixel measurement confirmed all five column boxes are perfectly aligned (same top and height); only the scrollable column's head was offset: an `overflow: hidden` box is still a scroll container, so after the body reaches its scroll end the continuing gesture **chains into the column frame itself** and scrolls it a few pixels. Fix: `.note-col` additionally declares `overflow: clip` (clips without being a scroll container; falls back to hidden), and `.note-col-body` gets `overscroll-behavior: contain` (no chaining past the body). 20 regression cases, reverse-verified.

  - **#259 notes round 7 (root-caused by the user in DevTools): empty note columns reused the board's bare `.empty` class, adding 8px of top padding** — the note column frame carried the `empty` class, and the board's `.empty { padding: 8px 4px }` is a global selector that matched it directly, pushing empty columns' heads down 8px relative to columns with records. Fix: the notes column now uses a dedicated `note-col--empty` class (related CSS renamed), and the board's `.empty` rule is scoped to `.board .empty` so it cannot leak again. 21 regression cases, reverse-verified.

  - **#259 notes round 8: the four columns now match the board's columns visually** — per the user's request, the notes columns adopt the account panel (board) column styling and width so both panels' columns look like one design. Everything is now aligned rule-by-rule with `.column` / `.column-head` / `.column-body`: a **fixed 320px width** (same as the board; narrower windows scroll the column area horizontally), head geometry `margin: 8px 8px 2px / padding: 5px 10px / radius 7px`, head backgrounds taken from the **same light palette by priority** (urgent `#fde7ec`, high `amber-bg`, medium `#dbe9fc`, low `#e6e7ea`), head content switched to "dot + title + right-aligned grey count" (was a colored count badge with a `::before` dot inside the title), and body `padding: 0 8px 10px / gap 8px`. Classes are renamed to `note-col--<priority>`; the empty-column greying was **removed** for board parity (the board shows colored heads and a count of 0 even when empty). 24 regression cases, reverse-verified by injecting 7 defects (5 assertions fail).

  - **#259 notes round 9: column heads switched to the board's status-column style** — round 8 copied the light capsule heads of the board's **4-state views** (`.column-todo .column-head { background }`), but the account panel actually uses the **status-column style**: `.column-status-N { border-top: 3px solid var(--status-N) }`. Now: a 3px status-color bar across the top of the column (`.note-col { border-top: 3px solid var(--col-accent) }`) plus a head with **no background** (the status color appears only on the top bar and the dot; the title uses the default text color), while head geometry and the "dot + title + right-aligned grey count" layout stay aligned with the board. 24 regression cases, reverse-verified.

  - **#259 UI copy renamed: 记事本 → 备忘录 (memos)** — all 10 Chinese user-visible strings switched from 记事本 / 记事 to 备忘录 (sidebar entry, panel title/rail, import-export buttons and toasts, priority group name, delete confirmation, load-failure message). The English locale keeps the `Notes` naming, and internal identifiers/classes remain `notes` / `NotesPanel` (no behaviour change). `i18n:check` still reports matching key counts and placeholders across both locales.

- **v0.6.0 (2026-09-17) — Concurrent dual-channel update check (#256)**

  - **#256 Slow update check with invisible failure cause**: v0.5.0's check was sequential — it awaited the tauri updater channel first (no built-in timeout, hangs long on weak networks) and only then ran the GitHub API fallback, so total latency was the sum; the updater's error was also swallowed silently, leaving only a late "Go to download" button. Observed on v0.5.0 + macOS Apple Silicon. See [docs/issue-256-update-check.md](./issue-256-update-check.md).
  - **How**: both channels start together with staged rendering — the fallback shows the manual download first (no waiting for the slow updater channel), and the updater upgrades it to one-click install or attaches its failure reason when it arrives; per-channel timeout caps (30s fallback / 90s updater). Frontend only (new pure module `src/utils/updateCheck.ts` + `AboutPanel`), no new dependencies, no Rust changes.
  - **Verification**: 11 new unit tests (4 `viewFallback` + 4 `viewUpdater` + 3 timeout-settling), `npm test` 12 files / 99 tests, `tsc --noEmit` 0 errors, `i18n:check` 305 keys per locale. Real-machine re-verification awaits a release containing this fix (v0.5.0's old panel can't be changed in place — one manual install of the new version needed).

- **v0.5.1 (2026-09-15) — Existing CI fixed (#252) + on-demand pull for not-yet-synced issues (#250) + horizontal scrolling for sync-log tables (#248)**

  - **#252 `quality-check.yml` is green again**: when #246 introduced that workflow it left two pre-existing failures — `Frontend Lint`'s `format:check` reported **29 unformatted files** (`.prettierrc` was added but `npm run format` was never run), and `Rust Clippy` / `Rust Tests` lacked Tauri's Linux system libraries (`glib-sys` / `gio-sys` / `gobject-sys` fail pkg-config during their build scripts). Both had been red on `develop` for a while, making every new PR's CI red by construction (#249 and #251 were both blocked). See [docs/issue-252-ci-green.md](./issue-252-ci-green.md).
  - **How**: the formatting is a standalone commit, and its semantic neutrality is proven by the **built artifacts having byte-identical sha256 before and after** (stronger evidence than passing tests). The system libraries were **not copied a third time** — they were extracted into the composite action `.github/actions/install-linux-deps`, shared by `release.yml` and both Rust jobs in `quality-check.yml` (the `runner.os` guard lives inside the action).
  - **Notes**: `npm run lint` (ESLint) was always passing (`--max-warnings 20` was never triggered; only 17 warnings), so no ESLint config was touched; the Rust jobs were not moved to a macOS runner (roughly 10× the cost, and the release matrix already covers Linux).
  - **Verification**: `format:check` 29 → 0, identical artifact hashes before/after formatting, `tsc --noEmit` 0 errors, `npm test` 11 files / 88 tests, `npm run lint` exit 0, `i18n:check` 302 keys per locale, all 5 workflows + action.yml parse as valid YAML with an assertion that both Rust jobs reference the action. CI results are confirmed by this PR's run.

  - **#250 Eliminates the "task not found" dead end on write**: the `tasks` table is filled only by one-way sync while the MCP tools are pure local SQL, so an issue that was **just created and not yet synced** made every write path fail with "task not found" (observed: issue created at 10:26, `update_task_status` still failing at 10:52). A local miss now **pulls that single issue on demand**, stores it, and retries the original operation. It only reads GitHub (one `GET`), never triggers a full sync, and costs zero extra requests for tasks that already exist. Responses gain a `pulled` flag (`get_task_status` also gains `reason`). See [docs/issue-250-ondemand-issue-pull.md](./issue-250-ondemand-issue-pull.md).
  - **Implementation notes**: the sync's inline upsert was extracted into `db::TaskUpsert` + `db::write_task` (both modes share one column list and parameter binding); the on-demand path uses `InsertIfAbsent` (`ON CONFLICT DO NOTHING`) because a single-issue REST response has no `project_status` / `mentioned` / `pr_*` — an overwriting upsert would wipe what sync had just written. The pull has to happen **before** the write (custom-column validation reads that row's `account_id`). `parse_issue_ref` used to drop the owner (the pull needs owner+repo); parsing moved into a shared parser. New on the Rust side: `on_demand.rs` and `github.rs::fetch_issue` (404 → `Ok(None)`).
  - **Two traps found only on a real machine (unit tests could not catch them; tests added)**: (1) account matching must consider both `org` and `login` — the task-dashboard account has an **empty `org`** (personal namespace) in practice, and matching on `org` alone made this feature completely unusable for that repo; (2) "the owner used for the API request" and "the `owner` column written to the DB" are different things (the latter stays consistent with sync and stores `account.org`) — conflating them produces `/repos//repo/...`. Also, for an owner-less `repo#N` reference a 404 does not mean the issue is missing; the error now states the exact target queried plus how to rewrite the reference.
  - **No schema change**: `tasks` is untouched, no migration needed.
  - **Verification**: `cargo test --lib` 93 passed (+11), `cargo test --test db_test` 21 passed, Clippy clean, `python3 -m unittest discover -s mcp_server` 26 passed (new `mcp_server/test_server.py`, wired into `mcp-schema-check.yml`), `tsc --noEmit` 0 errors, `npm test` 10 files / 84 tests, `check-mcp-columns.py` 24 columns, `check-doc-links.py` ✅. Plus **real end-to-end verification** (DB copy + real PAT): writing to a not-yet-synced issue returns `pulled:true`, a second call returns `pulled:false`, stored fields match the real GitHub response, and failure paths carry a reason (results in the KB doc).

  - **#248 Right-hand columns were silently clipped in both tabs**: `overflow: hidden` on `.sync-logs-table-wrap` cut overflowing columns off and produced **no scrollbar whatsoever** — the "Error" column in "Sync records" and the "Details" column in "API details", which are exactly the interactive entry points added by `#161` / `#235`, were unusable at the default window size (1180×760). Now `overflow: auto`; `.sync-logs-body` becomes a column flex container and the wrapper gains `min-height: 0`, so **both scrollbars share one viewport**. Changing `overflow-x` alone is not enough: the horizontal scrollbar would sit at the bottom of the full table (1029px below the fold with 40 rows), unreachable without scrolling all the way down. See [docs/issue-248-synclogs-hscroll.md](./issue-248-synclogs-hscroll.md).
  - **Verification**: `tsc --noEmit` 0 errors, `npm run build` ✅, `npm test` 11 files / 88 tests (new `src/styles.test.ts`, 4 cases, reverse-verified — reverting `overflow` to `hidden` fails them), `i18n:check` 302 keys per locale, `check-doc-links.py` ✅. To let the test read the real CSS text, `vitest.config.ts` now sets `css: true` (the default `css: false` stubs CSS to an empty string) and `src/vite-env.d.ts` supplies `?raw` typings — **no new dependencies**, using Vite's `?raw` instead of `node:fs` (which needs `@types/node`, not installed here, and makes CI fail with TS2307).

- **v0.5.0 (2026-09-13) — No repeated Gatekeeper approval + in-app auto-update (#231/#232) + in-app API call details (#235) + board card rework (#237) + doc integrity (#239)**

  - **#231/#232 No repeated Gatekeeper approval on macOS updates + in-app auto-update**: the root cause is that an ad-hoc signature (`signingIdentity="-"`) produces a designated requirement bound directly to the `cdhash`, which **changes on every build** — macOS therefore treats each new version as a brand-new, never-approved app, so the approval record can never match. Fixed by signing with a **stable self-signed certificate** so the DR stays constant (approve once, reuse long-term), and by adopting `tauri-plugin-updater` for in-app updates — the update package is downloaded by the **app's own process**, so it never carries `com.apple.quarantine` and Gatekeeper is not involved at all. Also fixed #101's quarantine auto-clear, which had been silently doing nothing: the attribute lives on the **bundle root**, while the old code only cleared `current_exe()`, and `xattr -dr` does not walk upwards, so `has_quarantine(exe)` was always false and it returned early; both the bundle root and the executable are now cleared. Adds `check_app_update` / `install_app_update` / `restart_app` commands and the `taskboard://update-progress` event; the About panel's "Check for updates" prefers the in-app path and **silently falls back** to the old version-compare + download-link flow on failure. See [docs/issue-231-macos-gatekeeper-update.md](./issue-231-macos-gatekeeper-update.md).
  - **#235 Request/response parameters persisted, visible in-app**: new `api_logs` table (`kind` / `method` / `target` / `status` / `ok` / `elapsed_ms` / `request` / `response`) records the **request and response parameters** of all three GitHub API call paths: sync, claim (`claim_issue`), and status write-back (`set_project_status`). The sync-log panel becomes **two tabs** ("Sync records" / "API details"); the details tab supports type filtering and per-row expansion showing request and response. This continues [#228](./issue-228-api-logging.md) (stderr instrumentation, silent by default, terminal-only) by adding persistence and in-app visualization. See [docs/issue-235-in-app-api-log.md](./issue-235-in-app-api-log.md).
  - **#235 implementation notes**: `GitHubClient` gains an optional sink (`new_with_sink`; `new` keeps its signature and passes `None`), so existing call sites are untouched. Draining happens in a `sync_account` wrapper so **failure paths still persist** despite early `?` returns inside `sync_account_inner`. `ApiLogEntry.ok` is independent of the status code (GraphQL can return HTTP 200 carrying `errors`). Request/response are stored as character-truncated summaries (400/600), retained 7 days with a 2000-row cap, and PATs are never written.
  - **#237 Remove account row / add creator row / enlarge repo#number**: the card's first line (the "owning account" badge, e.g. `@liushizhao2025`) is removed entirely — every card shows the same value in single-account view, so it carried no information. In its place the issue **creator** is shown, positioned on the row **above** "Assignees". The `repo #number` row (`fad-backend #1198`) goes from 11px to **13px**, making it the visual anchor when scanning a column. See [docs/issue-237-card-creator-row.md](./issue-237-card-creator-row.md).
  - **#237 implementation notes**: new `author` column on `tasks` (taken from Search API `user.login` and GraphQL `author { login }`; a missing value becomes an empty string and never fails the sync). The frontend **omits the row entirely** when the creator is empty/whitespace, so no empty label row appears. The now-dead `accountLabel` / `accounts` prop chain (TaskCard → Board → App) was removed, the `card.accountTitle` i18n key deleted and `card.creatorLabel` added. **Migration note**: the `ALTER TABLE` for `author` must go on the hot path **after** `migrate_tasks_v2_rebuild` — the v2 physical rebuild's column whitelist is hard-coded and omits newly added columns, so placing it earlier would have the column dropped by the rebuild (same trap as #175).
  - **#239 Doc integrity fix**: removed 7 classes / 24+ defects at once — three documents that were **referenced but never created** (`issue-118-*` / `issue-119-*` / `perf-audit-optimization.md`; the first two also violated §2.4 "every feature must ship a KB doc") are now backfilled from real commit diffs; 15 `file:///Users/<home>/...` absolute paths and 4 wrong-depth relative paths were converted to `../app/...`; 5 `#Lxxx` line anchors that had drifted onto unrelated code were removed. The CHANGELOG itself was also corrected and backfilled: the v0.3.48 #119 entry's claim of "new zip format" was false (`zip` is not a valid Tauri 2 bundle type and was rolled back the same day), v0.3.50's entry was backfilled with the 13 previously-missing issues, and **`v0.3.49` is documented as a ghost version number** (never tagged, never released). Adds `scripts/check-doc-links.py` + CI to prevent regressions. See [docs/issue-239-doc-integrity.md](./issue-239-doc-integrity.md).
  - **One-time prerequisites**: #231 requires creating a self-signed code-signing certificate named **`TaskBoard Local Signing`** via Keychain Access → Certificate Assistant (identity type "Code Signing", 3650 days recommended); CI overrides it through `APPLE_SIGNING_IDENTITY`, and `tauri.conf.json` keeps `signingIdentity="-"` so that **machines without the certificate can still build locally**. The first release also needs the updater's minisign key pair generated and `latest.json` configured.
  - **Schema changes**: new `api_logs` table plus two indexes (#235; new table via idempotent `CREATE TABLE IF NOT EXISTS`, existing DBs create it on startup); `tasks` gains `author TEXT NOT NULL DEFAULT ''` (#237; idempotent hot-path ALTER covering every `user_version`). **No breaking changes** — existing databases migrate automatically.
  - **Verification**: `cargo test --lib` 80 passed, `cargo test --test db_test` 21 passed (+2), `tsc --noEmit` 0 errors, `npm run build` ✅, `npm test` 10 files / 84 tests (+5), `i18n:check` 302 keys per locale, `check-mcp-columns.py` 24 columns consistent, `check-doc-links.py` 116 files clean.

- **v0.4.0 (2026-09-12) — GitHub write-back reversal (#214 claim + #215 status) + notes width + detail rework**

  - **Write-back reversal (product-constraint change)**: `AGENTS.md §2.1` / `PRD.md` relaxed from "read-only GitHub" to "read by default + explicit user-confirmed writes"; the sync path itself stays read-only and MCP tools stay local-only. PATs need matching write scopes (classic `repo` + `project`; Device Flow scope now includes `project`, old tokens must re-authorize).
  - **#214 Card claim**: click "unassigned" → confirm dialog → `POST assignees` assigns yourself, with optimistic local update; owner falls back to URL parsing when empty; full-chain logging. See [docs/issue-214-claim-assignee.md](./issue-214-claim-assignee.md).
  - **#215 Detail Project-status write-back**: sync now stores item/field/option IDs (`projects.status_field_id`, `project_statuses.option_id`, new `project_items` table with migration); `set_project_status` (on-demand refresh when IDs are missing, rejects closed issues, optimistic update reuses sync semantics); clickable GitHub-status row in Detail with confirm dialog. See [docs/issue-215-proj-status-write.md](./issue-215-proj-status-write.md).
  - **#196/#200 Detail rework**: status section always follows `project.status` (#196); width 460px → 50%, four-state buttons removed, +1px row gap (#200).
  - **#202/#209 Resizable notes**: right-edge drag + keyboard ±1%, percent of main area (25%–50%, default 25%), localStorage persisted; direct-DOM writes + rAF coalescing while dragging; `main-layout` switched from grid to flex row.
  - **#190 Hooks backup**: backups now happen before install-overwrite/uninstall-strip (project-level opencode previously backed up the post-strip file).
  - **#191/#204 Opencode auto-start**: check both MCP results, dedupe only after success, no `processed` downgrade (#191); per-message detection so multiple tasks in one window start in turn (#204).
  - **#206 No more auto-enroll on startup**: everything goes through manual one-click install; dev-binary installs get an expiry notice.
  - **#192 Label priority**: explicit label→todo wins over gh_status (owner confirmed).
  - **Smaller items**: dev-binary auto-register skip + `workBranch` in Detail (#193); collapsible agent groups (#207); account column in sync logs (#224); request/response API logging (#228).
  - **Fixes**: #197 session row on cards; #212 zero dead-code warnings; #216 deleting the last remaining account; #220 fingerprint covers projectStatus (instant refresh after write-back); #221 coalesced loads (no more stale account board).
  - **Schema changes**: `projects.status_field_id`, `project_statuses.option_id`, new `project_items` table (SCHEMA + migration).
  - **Verification**: `cargo test` (72 lib + 19 db_test cases) zero warnings, `tsc --noEmit`, `vitest` 10 files / 54 cases, `i18n:check` 279 keys consistent, `check-mcp-columns.py` 24 columns consistent.

- **v0.3.55 (2026-09-11) — Cross-agent board hooks (#177) + sync-filter hint (#178) + external-write auto-refresh (#181) + board-mode simplification (#108)**

  - **#177 Cross-agent board hooks with one-click install/uninstall**: new project-level `.claude/` (commands `/task-start` `/task-done` / hooks) and `.opencode/` plugin record "processing + session_id/session_agent + work_branch" in one call when work on an issue starts, and clear the session when it ends; `AGENT_INSTRUCTIONS.md` pins down the trigger timing, fixing "prompt-only convention is easy to forget". See [docs/issue-177-claude-session-hooks.md](./issue-177-claude-session-hooks.md).
  - **#177 follow-up: opencode auto-start + global MCP auto-merge**: the `.opencode/plugins/taskboard.js` event hook extracts a single issue reference from user messages and calls the local `taskboard mcp` directly (`get_task_status` + set processing + `record_session`; multiple references fall back to manual); `hooks.rs::merge_global_opencode_mcp` auto-merges the global MCP config into the first effective file (`opencode.jsonc > opencode.json > config.json`, preserving JSONC comments and other people's entries). See [docs/issue-177-claude-session-hooks.md](./issue-177-claude-session-hooks.md).
  - **#178 Hint when synced tasks are hidden by filters, with one-click clear**: snapshot `issueKey → updatedAt` before/after sync and diff to count "newly changed yet hidden by current filters" tasks; only then show an amber banner with the count + one-click filter reset; never bothers when no filter is active. New unit-testable pure module `syncHint.ts` (8 cases). See [docs/issue-178-sync-filter-hint.md](./issue-178-sync-filter-hint.md).
  - **#181 Auto-refresh after external writes**: frontend re-queries on window focus / `visibilitychange` plus a 20s polling fallback (skipped while hidden, `loadingRef` re-entry guard); `taskSig.ts` fingerprint covers locally-written fields (`updated_at` alone is not enough — local writes don't bump it), skipping re-render when nothing changed; backend `update_task_status` / `record_session` / `clear_session` / `record_handoff` emit the new `taskboard://tasks-changed` event (multi-window correctness). No MCP-protocol or DB-schema change. See [docs/issue-181-auto-refresh.md](./issue-181-auto-refresh.md).
  - **#108 Board-mode simplification**: the settings "board mode" dropdown drops the "four-state columns" option, keeping only "Project Status Columns" and "Custom Columns"; historic `status` values degrade to `project` at the Board render layer, zero schema change; settings modal widened 460px → 520px. See [docs/issue-108-simplify-board-mode.md](./issue-108-simplify-board-mode.md).
  - **Repo rename + full bug audit**: remote renamed to `task-dashboard` with all references synced (incl. the About-page link typo); new [docs/bug-audit-2026-09.md](./bug-audit-2026-09.md) (13 issues + 3 open questions + 2 false positives ruled out, inventory only, no source changes).
  - **CI**: Intel builds now cross-compile on `macos-latest`, fixing `macos-13` runner queueing.
  - **No schema change**. Verified: `npm test` 7 files / 36 cases pass, `tsc --noEmit` passes, `i18n:check` 273 keys consistent, `check-mcp-columns.py` 24 columns consistent.

- **v0.3.54 (2026-09-09) — Rust built-in MCP read path column mix-up fix (#173)**

  - **#173 `row_to_value` positional indices didn't follow the 24-column `SELECT_COLS`**: after #155 rebuilt the `tasks` table and inserted columns such as `url`, `issue_state`, `project_status`, `pr_number`, and #169/#171 grew `SELECT_COLS` to 24 columns, `mcp.rs::row_to_value` still read positions `get(0..10)` using an older, slim column order. As a result, the built-in MCP's `list_my_tasks` / `get_task_status` returned almost all fields misaligned (`repo` held the owner, `number` held the repo string, `status` held the title…). `check-mcp-columns.py` only diffs the `SELECT_COLS` strings on both sides — it can't cover the "position → column" mapping — so CI stayed green while the feature was broken. `row_to_value` is now rewritten to map strictly against the 24-column order (including `work_branch` / `updated_at`), matching the Python side's `dict(row)`.
  - **#173 Regression tests**: 2 new Rust unit tests (`list_my_tasks_returns_correct_column_values` / `get_task_status_returns_correct_column_values`) build an in-memory `tasks` table with all selected columns, fill each with a distinct recognizable value, and assert every field maps to the right value. lib tests 34 → 36.
  - **#175 `work_branch` migration gap**: the `work_branch` ALTER lived only in `migrate_legacy_alters` (user_version < 1), so old DBs at `user_version = 2` (already rebuilt by #155, and not re-triggered since they lack the legacy `key` column) never got the column — `SELECT_COLS` then failed with `no such column: work_branch`. The ALTER is now promoted to an idempotent hot path that runs on every `open_db` connect (ignore when it already exists), applying uniformly across all `user_version` values. New db_test 18 → 19.
  - **No schema change (just a data-migration backfill) & zero interface change**. See [docs/issue-173-mcp-read-row-to-value.md](./issue-173-mcp-read-row-to-value.md) and [docs/issue-175-work-branch-migration-gap.md](./issue-175-work-branch-migration-gap.md).

- **v0.3.53 (2026-09-09) — Python MCP out of sync with column rename (#169) + record_session records working branch (#171)**

  - **#169 Python MCP read path fixed**: #155 renamed `tasks.key` to `issue_key` and `mcp_server/server.py` never followed — `SELECT_COLS` and `tool_get_task_status` still used `key`, so `list_my_tasks` / `get_task_status` always failed with `no such column: key`. Both sides now share one `SELECT_COLS` (23 columns, adding `url`, `issue_state`, `project_status`, `pr_number` and other post-#155 fields), and the returned field is `issue_key` instead of `key`. See [docs/issue-169-mcp-server-schema-sync.md](./issue-169-mcp-server-schema-sync.md).
  - **#169 Writes were silently lost**: None of the four task write tools called `commit()`, so under sqlite3's default transaction mode everything rolled back when the process exited. The connection now uses `isolation_level=None` (autocommit) — harder to miss than remembering `commit()` at 11 tool exits. See [docs/issue-169-mcp-server-schema-sync.md](./issue-169-mcp-server-schema-sync.md).
  - **#169 Column-name regression guard**: Added a zero-dependency `scripts/check-mcp-columns.py` plus a `mcp-schema-check` CI job. Treating `db.rs::SCHEMA` as the single source of truth, it verifies that the columns used by `server.py` and `mcp.rs` really exist and match each other line for line. See [docs/issue-169-mcp-server-schema-sync.md](./issue-169-mcp-server-schema-sync.md).
  - **#171 `record_session` accepts an optional `branch` parameter**: record the current working branch (into a separate **`work_branch`** column, only when non-empty) as soon as work on an issue begins. Reuses `common::touch_session` (Rust) and `server.py` (Python) with a conditional update; both sides add `work_branch` to `SELECT_COLS` (24 columns).
  - **#171 `branch` reverts to PR-dedicated**: `sync.rs` still clears `branch` when an issue has no associated PR (the PR head.ref semantics don't regress); `work_branch` is not in the sync upsert columns, so **sync never overwrites the agent's working branch**.
  - **#171 Earlier trigger**: `AGENT_INSTRUCTIONS.md` now says to call `record_session` (with `git branch --show-current`) right when work starts.
  - **#171 Schema change**: `tasks` gains `work_branch TEXT NOT NULL DEFAULT ''` (new-db SCHEMA + legacy ALTER + v2 rebuild migration).
  - **Verification**: `cargo test` (lib 34 + db_test 18), `cargo check` pass. See [docs/issue-171-record-session-branch.md](./issue-171-record-session-branch.md).

- **v0.3.52 (2026-09-08) — Settings-panel freeze fix (#167)**

  - **#167 UI freezes when opening settings during sync/diagnosis**: `diagnose_project_status`, `test_pat`, `test_account_pat`, `save_pat`, `add_account` and `update_account` were synchronous commands containing GitHub network I/O; running them on the Tauri main thread blocked the event loop → macOS beachball. All six were converted to `async + spawn_blocking` (same pattern as `sync_now` in v0.3.7), moving network work to a worker-thread pool while the main thread only fetches DB data quickly and returns. Pure-SQL config commands are unaffected; sync uses a separate connection and WAL so readers are never blocked. Zero API change, zero frontend change. See [docs/issue-167-async-net-commands.md](./issue-167-async-net-commands.md).

- **v0.3.51 (2026-09-08) — Frontend fix trio (#159 #160 #161)**

  - **#159 Custom-column mode falls back to project columns when empty**: Selecting "Custom columns" for an account with no columns configured no longer misleadingly falls back to the four-state columns; it now falls back to the project.status columns. See [docs/issue-159-160-161-frontend-bugs.md](./issue-159-160-161-frontend-bugs.md).
  - **#160 In-app confirm dialog replaces window.confirm**: Tauri WebView has no native `window.confirm` (silently returns false), so the second-step confirmation for "Clear all logs" and "Delete account" now uses an in-app ConfirmDialog, fixing the click-does-nothing issue. See [docs/issue-159-160-161-frontend-bugs.md](./issue-159-160-161-frontend-bugs.md).
  - **#161 Sync-log error messages are expandable**: Error cells are single-line truncated by default, show the full text on hover, and expand/collapse on click. See [docs/issue-159-160-161-frontend-bugs.md](./issue-159-160-161-frontend-bugs.md).
  - **#163 Frontend tests added**: 3 new test files with 18 cases (21 total), zero new dependencies, covering the #159/#160/#161 fixes; extracted 4 pure functions (e.g. `resolveBoardView`) for testability. See [docs/issue-163-frontend-tests.md](./issue-163-frontend-tests.md).
  - **#165 Unmapped-value hint in custom view**: The "Unlabeled" column now shows unmapped `project_status` values (deduplicated with counts, full list on hover) so missing/mismatched custom columns are easy to spot. See [docs/issue-165-unmapped-hint.md](./issue-165-unmapped-hint.md).

- **v0.3.50 (2026-09-08) — Performance / security optimization batch + sync-log & custom-column improvements + tasks table physical rebuild (#133 #134 #135 #137 #138 #143–#150 #155)**
  - ℹ️ **Version-number note**: this release actually carries what was planned as "v0.3.49" — **`v0.3.49` was skipped and never tagged or released** (tag sequence is `v0.3.48` → `v0.3.50`). The ~50 source comments labelled `v0.3.49 (#143)` therefore refer to this very release v0.3.50; they are deliberately left untouched to avoid polluting `git blame`. The #133–#150 entries below are **backfilled** (previously only #155 was recorded), reconstructed from `git log v0.3.48..v0.3.50` and the issues themselves. See [#239](https://github.com/ShawnLiuSZ/task-dashboard/issues/239).
  - **Performance / security optimization batch (8 issues)**, batch index at [docs/perf-audit-optimization.md](./perf-audit-optimization.md):
    - **P0-1 #143 Sync pipeline concurrency**: the 5 Search sources and Project fetches now run in parallel, fixed `sleep`s removed, shared Search rate-limit gate added. See [docs/issue-143-147-sync-concurrency.md](./issue-143-147-sync-concurrency.md).
    - **P0-2 #144 Sync N+1 elimination + single-transaction writes**: preloading replaces per-task queries; N autocommits collapse into one commit. See [docs/issue-144-146-sync-db.md](./issue-144-146-sync-db.md).
    - **P0-3 #145 Frontend parallel loading**: `Promise.all` + `Board`/`TaskCard` `memo` + search debounce. See [docs/issue-145-148-150-frontend.md](./issue-145-148-150-frontend.md).
    - **P1-1 #146 Hot-query indexes**: `label_mappings` composite index / `tasks` board composite index / `notes` content unique index / prune index. See [docs/issue-144-146-sync-db.md](./issue-144-146-sync-db.md).
    - **P1-2 #147 Versioned connection migrations**: introduced `PRAGMA user_version` migrations + extracted `common.rs` + transactional `import_notes`. **This is the prerequisite for every later column migration** (see [docs/issue-237-card-creator-row.md](./issue-237-card-creator-row.md), "Decision 5"). See [docs/issue-143-147-sync-concurrency.md](./issue-143-147-sync-concurrency.md).
    - **P1-3 #148 Type / spelling fixes**: zeroed i18n `any`, added i18n to `SyncLogsPanel`/`NotesPanel`, fixed the `check_update` URL. See [docs/issue-145-148-150-frontend.md](./issue-145-148-150-frontend.md).
    - **P2-1 #149 Security hardening**: PAT into Keychain, minimal CSP + external-link allowlist, cross-platform `open_in_browser`, DB file mode 0600, log gating. See [docs/issue-149-security-hardening.md](./issue-149-security-hardening.md).
    - **P2-2 #150 Accessibility + CSS cleanup**: keyboard-reachable `TaskCard`, modal `role` / focus trap, contrast improvements. See [docs/issue-145-148-150-frontend.md](./issue-145-148-150-frontend.md).
  - **#133 `gh_status` badge in custom-column view**: switching to custom columns stopped showing `project.status` on cards; fixed the class name, made the badge show even with no column config, and auto-set `boardMode=custom` when saving column config. See [docs/issue-133-custom-col-status-badge.md](./issue-133-custom-col-status-badge.md).
  - **#134 Sync-log retention 7 → 30 days + "Clear all logs"**: added a full-clear button with a confirmation dialog. See [docs/issue-134-sync-logs-cleanup.md](./issue-134-sync-logs-cleanup.md).
  - **#135 Sync-log trigger type**: added `auto` / `manual` / `startup`; the Trigger column no longer always reads "Auto". See [docs/issue-135-sync-trigger-type.md](./issue-135-sync-trigger-type.md).
  - **#137 Skip per-issue `fetch_state` for closed issues**: batch-mark `candidate_done` instead, saving GitHub API calls. See [docs/issue-137-skip-fetch-state.md](./issue-137-skip-fetch-state.md).
  - **#138 Custom-column mapping flattened per account**: accounts are listed flat instead of behind a dropdown, each configured independently. See [docs/issue-138-flat-account-config.md](./issue-138-flat-account-config.md).
  - **#155 tasks table physical rebuild**: Field naming fully clarified — `key→issue_key` (business reference, added), auto-increment `id` primary key + `UNIQUE(repo, number, account_id)` fixing multi-account overwrites, `gh_state→issue_state`, `gh_status→project_status` (semantic separation from the local four-state `status`), and `updated_at` normalized from TEXT to INTEGER seconds. Versioned migration based on `PRAGMA user_version` plus idempotent `key`-column detection; legacy DBs rebuild automatically with full data migration. See [docs/issue-155-tasks-schema-rebuild.md](./issue-155-tasks-schema-rebuild.md).

- **v0.3.48 (2026-09-07) — Expanded platform support & CI optimization (#118 #119 #120 #121 #122)**
  - **#118 Expanded platform support**: Added macOS ARM/x64 and Windows ARM64 dual-architecture build support to GitHub Actions release workflow. See [docs/issue-118-expand-platform-support.md](./issue-118-expand-platform-support.md).
  - **#119 Expanded Release build matrix**: Added arm64 support for all platforms plus rpm and msi formats. macOS/Windows/Linux all support dual architectures. See [docs/issue-119-expand-release-matrix.md](./issue-119-expand-release-matrix.md).<br>⚠️ **Correction (added 2026-09-13, [#239](https://github.com/ShawnLiuSZ/task-dashboard/issues/239))**: this entry originally claimed "new zip/msi/rpm formats", but **`zip` was rolled back the same day** — Tauri 2's `--bundles` only accepts app/dmg/nsis/msi/deb/rpm/appimage, so `zip` is not a valid type (commit `18049ec`). Portable zip was never shipped; do not retry that form.
  - **#120 CI deprecation warning fix**: Upgraded GitHub Actions (checkout@v5, setup-node@v5, tauri-action@v2), Node.js version upgraded to 22 LTS, eliminating deprecation warnings. See [docs/issue-120-upgrade-ci-actions.md](./issue-120-upgrade-ci-actions.md).
  - **#121 Removed agent-specific text from About page**: Removed WorkBuddy/claude-code specific agent onboarding text from AboutPanel, consolidated to generic description. See [docs/issue-121-remove-workbuddy-text.md](./issue-121-remove-workbuddy-text.md).
  - **#122 Database path documented for all platforms**: README and Rust doc comments now cover Windows/Linux/macOS database paths. See [docs/issue-122-db-path-docs.md](./issue-122-db-path-docs.md).

- **v0.3.47 (2026-09-07) — MCP stdio framing fix (#115)**
  - **#115 MCP stdio framing fix**: `read_message` now auto-detects framing format — first byte `{` triggers NDJSON (MCP spec), otherwise Content-Length header (LSP legacy compat); `write_message` responds in the same framing format as the request. Fixes `connection timed out after 30000ms` for Claude Code / Cursor and other standard MCP clients. Diagnostic stderr output added for silent exit paths. Both Rust and Python implementations updated in sync. See [docs/mcp-stdio-framing-ndjson.md](./mcp-stdio-framing-ndjson.md).

- **v0.3.46 (2026-09-07) — Settings board mode simplified (#108) + MCP cross-platform docs (#109)**
  - **#108 board mode simplified**: removed the "Four-state columns" option from the settings dropdown, keeping only "Project Status Columns" and "Custom Columns"; simplified `boardModeProject` text; legacy `boardMode="status"` accounts gracefully degrade to `project` in Board.tsx — zero schema changes. Settings modal width increased from 460px to 520px. See [docs/issue-108-simplify-board-mode.md](./issue-108-simplify-board-mode.md).
  - **#109 MCP cross-platform docs**: AboutPanel detects the current OS via `navigator.userAgent` and renders the matching `command` path in the MCP snippet (macOS / Windows / Linux). README adds a platform-specific path table and consolidates to a single agent config example. See [docs/issue-109-mcp-platform-docs.md](./issue-109-mcp-platform-docs.md).

- **v0.3.45 (2026-09-07) — Notes export defaults to the device downloads dir (#103)**
  - **#103 export to downloads**: `export_notes` gains an optional `target_dir`; when omitted it writes via `dirs::download_dir()` to the real system download dir (macOS `~/Downloads` / Windows `%USERPROFILE%\Downloads` / Linux `$XDG_DOWNLOAD_DIR`), falling back to the app data dir's `notes-backup/` when unavailable/unwritable. Added `resolve_export_dir` for precedence + writability checks. **Zero new deps** (`dirs` already in use). The frontend success notice already shows the full `path`. See [docs/issue-103-notes-export-download.md](./issue-103-notes-export-download.md).
  - **Verification**: `cargo check`; new unit test `resolve_export_dir_prefers_target_then_download` (26 total).

- **v0.3.44 (2026-09-07) — Auto-clear Gatekeeper quarantine on first launch; MCP works out of the box without sudo (#101)**
  - **#101 self-quarantine auto-clear**: on macOS first launch, `setup()` detects `com.apple.quarantine` on the main binary (`taskboard mcp`) via `xattr` and recursively removes it (`xattr -dr`) when present — the current user owns its own bundle, so **no sudo** is needed. After one GUI approval, the app clears the quarantine itself; subsequent MCP clients spawn the binary without the slow Gatekeeper evaluation, fixing the "MCP connection timed out after 30000ms" issue. See [docs/issue-101-quarantine-autoclear.md](./issue-101-quarantine-autoclear.md).
  - **Verification**: `cargo check` (macOS) passes; acceptance is multi-machine manual (`xattr -l` shows no quarantine after launch, MCP tools discoverable/callable).

- **v0.3.40 (2026-09-07) — Settings tab layout + custom-column Project status mapping (#95)**
  - **#95 custom-column Project status mapping config**: the settings panel is now **tab-based (General / Column Mapping / Diagnose)**, and custom-column config is its own page with a close button in the title bar. The "column key (colKey)" concept is removed — `col_key` is auto-generated, so users only need to **enter a column display name and select the matched Project statuses (multi-select chips + free-text)**, which save to the `matchRules` JSON array. Backend logic and storage are unchanged and backward-compatible. See [docs/issue-95-status-mapping-dropdown.md](./issue-95-status-mapping-dropdown.md).
  - **Verification**: `npx tsc --noEmit`, `npm run i18n:check` (zh-CN / en-US 177 keys each) pass.

- **v0.3.39 (2026-09-07) — Audit cleanup wrap-up (#72 #73 #80)**
  - **#72 board-mode dropdown status option**: verified `status / project / custom` options all exist (completed with v0.3.29 #64); no code change, issue closed.
  - **#73 MCP serverInfo version injection**: removed hardcoded `SERVER_VERSION = "0.3.24"` from `mcp.rs`, switch to `env!("CARGO_PKG_VERSION")` for single-source versioning. Doc-compliance wrap-up — restore CHANGELOG references for orphan KBs: create [docs/issue-55-update-check.md](./issue-55-update-check.md) and reference [docs/issue-54-auth-account-refresh.md](./issue-54-auth-account-refresh.md), [docs/issue-55-update-check.md](./issue-55-update-check.md), [docs/issue-56-project-status-order.md](./issue-56-project-status-order.md).
  - **#80 remove 21 dead i18n keys**: leftover keys from the removed "Label status mapping" and "Label column order" UIs (`settings.labelMapping.*`, `settings.labelColumns.*`, `settings.labelMappingsTitle/Desc`, `settings.labelColumnsTitle/Desc`) plus stale `settings.boardModeLabel`, `settings.boardModeLabelOnly`. zh-CN / en-US now 172 keys each, bilingual consistent.
  - **Verification**: `npm run i18n:check` (172 keys each), `npx tsc --noEmit`, `cargo check` all pass.

- **v0.3.38 (2026-09-07) — TaskCard repo color & all-accounts dropdown fixes (#77 #78)**
  - **Background**: the four-state view's `TaskCard` missed `repoIndex` so repo labels shared a single color; on `viewMode=all` the account dropdown was still switchable but had no effect on the list, creating ambiguity.
  - **Changes**: **#77** build a `repoIndexMap` in the four-state view and pass `repoIndex`, building separately per view so repo labels get distinct colors alphabetically. **#78** disable the account dropdown when `viewMode=all` and set the tooltip to clarify aggregation (new i18n key `topbar.switchAccountAll`).
  - **Verification**: `npx tsc --noEmit` and `npm run i18n:check` (193 keys each) pass. See KB doc [docs/issue-77-78-card-board-fixes.md](./issue-77-78-card-board-fixes.md).

- **v0.3.37 (2026-09-07) — NotesPanel shortcut & DetailPanel timer fixes (#75 #76)**
  - **Background**: NotesPanel's ⌘/Ctrl+Enter shortcut bypassed the `adding` guard, creating duplicate notes on repeated presses; DetailPanel's bare `setTimeout` in `copyToClipboard` was never cleared, firing `setCopiedKey` after unmount (setState on unmounted component).
  - **Changes**: **#75** the shortcut now requires `!adding && draft.trim()`, matching the add button's disabled condition — repeated presses / empty draft no longer trigger. **#76** `copyToClipboard` manages the reset timer via `useRef` (clear-old-then-store-new to avoid stacking); a cleanup `useEffect` clears the timer on unmount.
  - **Verification**: `npx tsc --noEmit` passes. See KB doc [docs/issue-75-76-ui-fixes.md](./issue-75-76-ui-fixes.md).

- **v0.3.36 (2026-09-07) — Fix i18n text leaks (#71)**
  - **Background**: the SettingsPanel "Diagnose & Project List" diagnostic text and the DetailPanel agent dropdown (Doubao/Zhipu GLM/Tongyi Lingma) were hardcoded Chinese and did not follow the UI language (outside the scope already covered by #62).
  - **Changes**: display-only i18n wiring. **DetailPanel**: the three Chinese agent labels get an `i18nKey`; new `agentLabel(value, t)` helper unifies translation for the dropdown and the "recorded at {agent}" echo. **SettingsPanel**: `diagnoseProject` composes text via `t()` interpolation. Locales gain 8 keys (`agents.doubao/glm/tongyi`, `settings.diag*`).
  - **Verification**: `npm run i18n:check` passes (192 keys each), `npx tsc --noEmit` passes. See KB doc [docs/issue-71-i18n-leaks.md](./issue-71-i18n-leaks.md).

- **v0.3.35 (2026-09-07) — Deduplicate concurrent `run_sync` (#69)**
  - **Background**: multiple entry points (Tray "sync now", startup sync, scheduled sync, frontend `sync_now`) are unaware of each other and can run full syncs concurrently; `sync::run` holds the `db` lock across 5 Search + 1 GraphQL calls (5–15s), queuing back-to-back runs that block the UI and amplify GitHub rate limits.
  - **Changes**: added a `syncing: AtomicBool` dedup flag to `AppState` and a `SyncGuard` (acquire via `swap`/reset on `Drop`). **`lib.rs::run_sync`** and **`commands.rs::sync_now`** share the same flag — when a sync is in progress, auto entry points skip silently and the manual button returns "sync in progress".
  - **Verification**: new unit test `sync_guard_dedupes_concurrent_acquisition` covers acquisition dedup and reset-on-drop; `cargo test` lib 23 passed. See KB doc [docs/issue-69-sync-dedup.md](./issue-69-sync-dedup.md).

- **v0.3.34 (2026-09-07) — validate `status` in `update_task_status` (#70)**
  - **Background**: the frontend `update_task_status` wrote the passed `status` straight into `tasks.status` with no validation; a mistyped non-four-state value or a deleted custom-column key leaves the task in no column, silently disappearing from the board.
  - **Changes**: unified the validation scope to "four states ∪ Chinese four states ∪ the task's account `account_columns::col_key`". **`commands.rs::update_task_status`** normalizes Chinese four states to English and adds `validate_task_status` — rejects non-four-state values that are not the account's custom columns and leaves the DB unchanged. **`mcp.rs::tool_update`** likewise validates the account's custom-column `col_key` (previously it rejected custom columns outright, inconsistent with the other entry).
  - **Verification**: new unit test covers four-state pass, account custom-column pass, and rejection of typos/unknown columns/missing tasks; `cargo test` lib 22 passed. See KB doc [docs/issue-70-status-validation.md](./issue-70-status-validation.md).

- **v0.3.33 (2026-09-07) — MCP dual-implementation consistency fixes (#68 #79)**
  - **Background**: the built-in MCP (Rust `mcp.rs`) and the portable fallback (Python `server.py`) behave differently on `delete_note` return key and `update_note_label` empty-label handling, so the same call yields different results across environments.
  - **Changes**: **#68** `server.py::tool_delete_note` return key `id` → `note_id`, aligning with Rust. **#79** `server.py::tool_update_note_label` empty label now falls back to `low` instead of erroring, consistent with `tool_add_note` and Rust `normalize_note_label`.
  - **Acceptance**: built-in app and portable server return/persist identically for `delete_note`, `update_note_label("")`, and `add_note("")`. See KB doc [docs/issue-68-79-mcp-consistency.md](./issue-68-79-mcp-consistency.md).

- **v0.3.32 (2026-09-07) — PRs in Project V2 are no longer treated as issues (#67)**
  - **Background**: `fetch_project_issues` detected PRs by `pull_request`/`mergedAt`/`headRefOid`, but the GraphQL query did not select those fields, so the check was always false and PRs in Project V2 were pulled onto the board as issues.
  - **Changes**: added `__typename` to the `content` selection; the type check now skips via `content["__typename"] == "PullRequest"`, which is reliable and consistent with the query.
  - **Acceptance**: when a Project contains both issues and PRs, PRs no longer appear on the board after sync while issues still do (and do not occupy status columns). See KB doc [docs/issue-67-pr-typename.md](./issue-67-pr-typename.md).

- **v0.3.31 (2026-09-07) — Reset DetailPanel session state on task switch (#66)**
  - **Background**: `DetailPanel` initializes `sessionInput`/`agent`/`handoff` via `useState(task.sessionId)`, which only reads on first mount; when the selected task changes without the panel unmounting, state is not reset and the previous task's session/handoff can be written into the current task.
  - **Changes**: `App.tsx` adds `key={selectedTask.key}` to `<DetailPanel>` so switching tasks forces a remount and state initializes from the new task.
  - **Acceptance**: switching directly to another task (panel open) no longer shows the previous task's session/handoff values; switching back to the same task does not lose unsaved edits. See KB doc [docs/issue-66-detailpanel-session-reset.md](./issue-66-detailpanel-session-reset.md).

- **v0.3.30 (2026-09-07) — Fix tasks wrongly removed on empty search results (#65)**
  - **Background**: when the Search API returns 422, `search()` treated it as "no results"; partial search-source failures let real related tasks be marked stale and removed from the board (data-loss risk).
  - **Changes**: **#65a** `github.rs::search()` — a 422 (including 422/non-2xx after rate-limit retry) now returns `Err` instead of an empty result, so it is recorded into `failed` and downstream can tell the search pipeline is incomplete. **#65b** `sync.rs::sync_account()` stale cleanup — when any search source fails, tasks still open are only un-staled and kept (not deleted); confirmed closed tasks are still marked done as before.
  - **Acceptance**: sync no longer aborts or removes open tasks on search 422/failure; the "move off board" behavior is unchanged when search is complete. See KB doc [docs/issue-65-empty-search-no-delete.md](./issue-65-empty-search-no-delete.md).

- **v0.3.29 (2026-09-06) — Board mode persistence and consistency fixes (#64 #72 #74)**
  - **Background**: a second audit found three defects in the board mode (boardMode) system that made custom columns unusable, caused tasks to disappear from the four-state view, and prevented mode switches from persisting.
  - **Changes**: **#64 boardMode persistence** — backend `Settings` struct adds `board_mode` field; `get_settings` reads it back from `meta.board_mode`; frontend serializes `setBoardMode` → `loadSettings` so the old value no longer overwrites the user's choice. **#72 restore four-state option** — board mode dropdown re-adds `status` (four-state) option; `Board.tsx` default changes from `status` to `project` to align with `db.rs` default. **#74 custom column gate** — `sync.rs` only applies custom column mapping when `board_mode == "custom"`, preventing tasks from being assigned a col_key status and vanishing from the four-state / Project views.
  - **Acceptance**: board mode can be freely switched among status / project / custom and persists; sync under non-custom views no longer shunts tasks into custom columns; cargo check / tsc / i18n:check pass. See KB doc [docs/issue-64-board-mode-fixes.md](./issue-64-board-mode-fixes.md).

- **v0.3.28 (2026-09-06) — Custom column mapping (#52)**
  - **Background**: each account may use a different set of GitHub Project Status values; the board needs per-account custom column mapping rules instead of only fixed four-state columns or Project Status columns.
  - **Changes**: backend adds `account_columns` table supporting per-account column config (col_key, col_name, match_rules, order_index); adds `list_account_columns` and `save_account_columns` Tauri commands; custom column mapping takes priority over label mapping and Project Status mapping in `sync.rs` status determination. Frontend `Board.tsx` adds `custom` mode rendering with dynamic columns per account config (unmatched tasks fall into "Unclassified" column); `App.tsx` adds "Custom Columns" option to the board mode dropdown; `SettingsPanel.tsx` adds column mapping editing UI (select account → column list → add/edit/delete → save). i18n adds 12 keys (zh-CN / en-US).
  - **Acceptance**: each account can independently configure column mapping rules; matched tasks auto-sort into the corresponding columns after sync; selecting "Custom Columns" board mode renders the custom columns; closed tasks always go to "Done". See KB doc [docs/issue-52-custom-column-mapping.md](./issue-52-custom-column-mapping.md).

- **v0.3.27 (2026-09-06) — Notepad export / import (#53)**
  - **Background**: destructive updates (reinstall / data wipe / upgrade accidentally deleting SQLite) could lose local notepad data, and there was no backup/restore entry point.
  - **Changes**: backend adds two Tauri commands `export_notes` and `import_notes` — exports all notes to JSON under the app data dir `notes-backup/`; import dedupes by content, preserves original timestamps, and never overwrites existing data. The `NotesPanel` header gains export/import icon buttons; after export it shows the saved path, after import it reports "added / skipped" counts.
  - **Acceptance**: exported file is complete and readable; importing restores notes (content, label, timestamps) fully; repeated imports create no duplicates; data can be recovered after a destructive update. See KB doc [docs/issue-53-notes-backup.md](./issue-53-notes-backup.md).

- **v0.3.26 (2026-09-06) — Auto-refresh the accounts modal after GitHub authorization (#54)**
  - **Problem**: after completing the GitHub device-flow authorization inside the Accounts modal, the account list did not refresh; the newly authorized account only appeared after closing and reopening the modal.
  - **Root cause**: `AccountsPanel` snapshotted the parent prop into local state (`useState<Account[]>(settings.accounts)`) with **no mechanism to sync later prop changes back into local state**. On successful authorization it only called `onAccountsChanged()` (the parent runs `loadSettings()`), so the local `accounts` never changed and only a remount could refresh it.
  - **Changes**: `AccountsPanel.tsx` gained a `useEffect` that syncs `settings.accounts` back into local state; it replaces the list wholesale rather than appending, which inherently avoids duplicates. This also fixes the same-rooted issue where the "default" tag did not update immediately after "Set default".
  - **Acceptance**: the account list auto-refreshes right after a successful authorization callback and the new account shows immediately; no need to close/reopen the modal; no duplicate accounts or data corruption.

- **v0.3.25 (2026-09-06) — Fix disabled "Check for Updates" button (#55)**
  - **Problem**: the "Check for Updates" button in the About modal was always disabled, so users could never trigger a check manually. Root cause: `AboutPanel` initialised `state` to `{ phase: "loading" }`, reusing one phase for both "not checked yet" and "checking in progress", while the button's `disabled` test was `state.phase === "loading"` — so it was disabled the moment the modal opened.
  - **Changes**: `AboutPanel.tsx` adds an `idle` initial phase (not checked, clickable) and keeps `loading` strictly for "checking in progress"; removed the redundant `checkedOnce` flag; the button shows "Checking…" and is briefly disabled during a check to prevent double-clicks, then becomes clickable again once the check finishes (success or error); the up-to-date status now shows the concrete version number. `zh-CN.json` / `en-US.json`: `about.upToDate` gained a `{version}` placeholder.
  - **Acceptance**: the button is clickable as soon as the modal opens; clicking it correctly shows either "up to date vX.Y.Z" or "new version X available (current: Y)" with a download link; the button returns to clickable after the check completes.

- **v0.3.24 (2026-09-05) — Notepad & account system & sync logs & topbar layout (incl. #6/#7/#27/#26/#31/#24/#25/#37/#38/#41/#33/#9/#48)**
  - **Multi-account & account system (#25/#31/#33/#38)**: fixed second-account 422; added an accounts panel (add/remove/switch); deleting an account now cascades clean-up of all its local data; removed the org default switch.
  - **Notepad panel (#9)**: a standalone notes column on the far left of the board.
  - **Sync logs (#27)**: records the last week's sync activity in-app with auto-expiry; new "Sync Logs" modal.
  - **Topbar layout optimization (#48)**: right button group no longer wraps; removed the leftmost "TaskBoard" text; 5 buttons got inline SVG icons (icons only below 1100px); the four modals unified into a mutually-exclusive `activeModal` (fixes overlap, root cause same as #26); modal height clamps to the viewport with internal scroll; mask z-index raised so the modal is no longer covered by the search bar.
  - **Sync experience (#24)**: auto-refresh after a sync completes.
  - **i18n (#7)**: Chinese/English UI switching; GitHub auth countdown format fix (#6).
  - **MCP silencing (#41)**: hides db column-migration logs in MCP calls.
  - **KB docs**: [`docs/issue-48-topbar-layout.md`](./issue-48-topbar-layout.md), [`docs/issue-27-sync-logs.md`](./issue-27-sync-logs.md), [`docs/issue-33-cascade-delete-account.md`](./issue-33-cascade-delete-account.md), [`docs/issue-41-mcp-silent-migration.md`](./issue-41-mcp-silent-migration.md), [`docs/issue-9-notepad-panel.md`](./issue-9-notepad-panel.md)

- **v0.3.23 (2026-09-05) — Sync logs feature (#27)**

  - Requirement: after sync operations (scheduled/manual), users cannot view sync history and error details, making it difficult to troubleshoot issues like "partial account failures / 422 errors".

  - Changes:

    - `db.rs`: added `sync_logs` table (account_id, trigger_type, started_at, finished_at, status, added/updated/removed/candidate_done/pruned counts, failed_sources, error_message), auto-creates table and indexes.

    - `sync.rs`: inserts log at sync start for each target account, updates log status and statistics on completion; auto-cleans logs older than 7 days after each sync.

    - `commands.rs`: added `list_sync_logs` (list sync logs) and `prune_sync_logs` (clean expired logs) Tauri commands.

    - `lib.rs`: registered new commands.

    - `types.ts`: added `SyncLog` type.

    - `api.ts`: added `listSyncLogs` and `pruneSyncLogs` API calls.

    - `SyncLogsPanel.tsx`: new sync logs panel component, displays recent 100 sync records (time, trigger type, duration, status, added/updated/removed counts, error info), supports manual cleanup of expired logs.

    - `App.tsx`: added "Sync logs" button in the top bar.

    - `styles.css`: added sync logs panel styles.

  - Verification: `cargo check` passes; `npx tsc --noEmit` passes; `npm run tauri build` compiles successfully.

  - Knowledge base doc: [`docs/issue-27-sync-logs.md`](./issue-27-sync-logs.md)

- **v0.3.19 (2026-09-05) — About page + check for updates (#21)**

  - Background: the app had no in-app version display or update entry, so users could not tell the current version or trigger an upgrade.

  - New "About" page (opened via the top-bar "About" button):
    - Shows the current version (read from the Rust package version on the backend, not hard-coded in the frontend)
    - "Check for Updates" button: calls the GitHub Releases API `releases/latest`, compares current/latest, and shows "You are up to date" or "New version available" with a one-click link to download
    - The repository name is now a clickable link that opens `https://github.com/ShawnLiuSZ/task-dashboard` in the system browser
    - Built-in bilingual support (i18n keys `about.*` / `btn.about`)

  - Technical notes: `check_latest_release` only reads the public repo (no PAT needed); it uses `spawn_blocking` so the blocking-reqwest request does not stall the main thread.

  - Version number unified to 0.3.19 (Cargo / package / tauri.conf / built-in MCP / portable server.py).

  - **Bundle Identifier changed to `com.shawnliu.taskboard`** (was `com.liushizhao.taskboard`): the default data directory is now `~/Library/Application Support/com.shawnliu.taskboard/`. ⚠️ To keep existing local data, manually move `taskboard.db` from the old directory, or point `TASKBOARD_DB` at the old DB.

- **v0.3.18 (2026-09-05) — Establish and run a version-release process (first unified version number)**

  - Background (#5): starting from v0.3.17, establish a clear SemVer release process so the Rust/Cargo, frontend package.json, Tauri config, built-in MCP, portable `mcp_server/server.py`, and doc version numbers all stay consistent, and provide a reproducible base for future releases.

  - Version number unified to 0.3.18:

    - `app/src-tauri/Cargo.toml` `version=0.3.18`

    - `app/package.json` + `package-lock.json` `version=0.3.18`

    - `app/src-tauri/tauri.conf.json` `version=0.3.18` (artifacts `TaskBoard_0.3.18_*.app/dmg`)

    - `app/src-tauri/src/mcp.rs` `SERVER_VERSION=0.3.18` (built-in MCP `serverInfo.version`, returned via `taskboard mcp` `initialize`)

    - `mcp_server/server.py` `serverInfo.version` corrected from the stale 0.3.10 to 0.3.18 (portable fallback stays consistent with the built-in binary)

  - Docs synced: README / PRD / bilingual CHANGELOG now reference 0.3.18; added English docs (README.en / AGENT_INSTRUCTIONS.en / CHANGELOG.en).

  - Cross-platform docs (#8) ship with this release: README / CLAUDE / PRD drop the "macOS-only" wording, now Windows / macOS / Linux.

  - Verification: `cargo check` zero warnings; `cargo build --release` produces the built-in MCP binary (smoke `initialize`→`serverInfo 0.3.18`, `tools/list` with all 6 tools); portable `mcp_server/server.py` smoke-consistent.

- **v0.3.17 (2026-09-04) — GitHub OAuth Device Flow sign-in (replacing PASTE-ing a PAT)**

  - Requirement: no more manually creating/pasting a PAT to sign in to GitHub; move to a "click the button → authorize in the browser" linked-login experience.

  - Implementation (RFC 8628 Device Flow): added `src-tauri/src/oauth.rs` — ① `start` requests a device code (`POST /login/device/code`, scope=`repo read:org read:project`); ② `poll_once` polls the access token (full coverage of `authorization_pending` / `slow_down` / `expired_token` / `access_denied`; **the backend does not sleep** — the frontend paces it via the interval). **The token never flows back to the frontend** — on a successful poll the backend probes the login and creates/updates the account directly.

  - First-use prerequisite (one-time): GitHub → Settings → Developer settings → OAuth Apps → New OAuth App (Callback can be anything), enable **Device Flow**, copy the Client ID into the settings panel (stored in `meta.oauth_client_id`). After that, sign-in is zero-config.

  - UI (SettingsPanel): the add-account form is now "Account name + Org + Client ID + Sign in with GitHub authorization"; the authorize panel shows the user_code in large text + "Reopen authorization page" (using `verification_uri_complete` to pre-fill so no code typing) + poll status; the old "GitHub Personal Access Token (compat field)" whole UI block is removed (the backend `save_pat` / `test_pat` / `clear_pat` commands are kept for compatibility).

  - Command registration: `save_oauth_client_id` / `device_login_start` / `device_login_poll`; `Settings` gains an `oauthClientId` field; MCP SERVER_VERSION synced to 0.3.17.

  - Accounts with the same login are auto-reused on login (updating the PAT instead of creating duplicates); the first account is auto-set as default and activated.

  - Verification: `cargo check` zero warnings; `cargo test` 16 lib + 15 integration all pass (2 new oauth unit tests); `npm run build` passes.

- **v0.3.16.1 (2026-09-04) — Fix first-launch SIGABRT + SQLite WAL hardening**

  - Symptom: the v0.3.16 binary SIGABRTs within 1.6s of its first launch, reproducibly; crash log top frame `tao::app_delegate::did_finish_launching + 272` (C-boundary `panic_cannot_unwind`), threadState.x22 = `sqlite3azCompileOpt` (panic while SQLite compiles SQL).

  - Root-cause chain: v0.3.16's start transaction (create accounts table + write default settings + ALTER ADD account_id) aborted mid-way → left a half-committed `.db-journal` in DELETE mode → bundled SQLite 0.31 fails forward-rollback on macOS 26.6 with "disk I/O error" → column migration fails but is swallowed by `let _ = ...` → the DB is half new / half old → later sync panics. The system sqlite3 3.51 reads/writes it fine, proving the file itself is healthy — it's the bundled SQLite's differing handling of a leftover journal.

  - DB recovery (manual): back up then move the `-journal` away, backfill the `account_id` column with the system sqlite3; all 78 tasks intact.

  - Code hardening (`db.rs::open_db`): ① force `PRAGMA journal_mode=WAL + synchronous=NORMAL + busy_timeout=5000` — in WAL mode the main DB file is always consistently readable, crashes are inherently safe; ② ALTER failures are no longer swallowed, surfaced via `eprintln!`.

  - New tests: `open_db_uses_wal_journal_mode` / `open_db_recovers_from_dirty_journal_file` (forge a leftover journal and verify `open_db` still succeeds).

- **v0.3.1 (2026-09-04) — Board misses tasks "assigned to me"**

  - Symptom: the board randomly misses issues assigned to me (e.g. `fad-backend#1200` and #1066/#1071/#1072/#1100/#1138/#1139, `pq-backend#259`).

  - Root cause: the original sync used only a single `involves:<login>` query, and GitHub's `involves:` search does not reliably cover assignees, occasionally dropping assigned issues.

  - Fix: switch to two queries — `assignee:<login>` (authoritative) + `involves:<login>` (other related) — merged and deduped by key; compiles and verified end-to-end that all 7 lost issues are now on the board.

  - Residual limitation: "related but not mine" (`assigned-others` / `notassignee`) still relies on `involves:`, theoretically subject to the same occasional drops; "assigned to me" is now fully stable.

- **v0.3.2 (2026-09-04) — Fully eliminate random drops caused by `involves:` flakiness**

  - Further diagnosis: GitHub `involves:` search results are **nondeterministic/flaky** — the total always says 76, but members are randomly dropped (the same set of assigned issues appears sometimes but not others across queries). A single `assignee:` only covers "assigned to me", not "related but not mine".

  - Fix: merge **5 stable query sources** — `assignee:` + `author:` + `mentions:` + `commenter:` + `involves:` (fallback), deduped by `repo#number`. `github.rs` extracts a common `fetch_search` + 4 dedicated `fetch_*` functions + `merge_tasks_all`; `sync.rs` merges all five sources.

  - Verification: the 5-source merged unique total = 76 (i.e. the complete related set), immune to `involves:` flakiness; any single-source drop is backfilled by the others. Each sync issues 5 Search API calls (auth limit 30/min, ample).

- **v0.3.3 (2026-09-04) — Multi-source sync tolerance + failure hinting**

  - Problem: after the multi-source rework, each sync issues 5 Search API calls; if one occasionally fails (rate limit / network jitter) the old `?` made the **whole sync fail**, which could mislead users into thinking "tasks are gone".

  - Fix: `sync.rs` switched to **best-effort merge** — a single-source failure only skips that source, the rest merge normally; only when all sources fail is it an error. Added a `warning` field to `SyncResult`; `App.tsx` shows a ⚠️ banner for "some data sources failed" (no silent task loss).

  - Verification: `cargo check` + `npm run tauri build` pass (`.dmg` still sandbox-blocked); end-to-end sync of 76 records in, distribution unchanged.

- **v0.3.4 (2026-09-04) — Top search + repo/ownership filter on the board (visibility polish)**

  - Background: sync no longer drops tasks, but on long columns (e.g. "to-do" with 61 `fad-backend` items) a specific task is hard to locate, and users misjudge it as "not pulled" (e.g. `fad-backend#1200`).

  - Changes: added a top `.toolbar` — search box (matches `repo#number title`, live) + repo dropdown (scope by repo) + ownership dropdown (moved from the topbar) + reset button; `visible` is filtered client-side via `useMemo`, and "N total" now shows the visible count.

  - Verification: `npm run build` passes; `npm run tauri build` produces both `.app` and `.dmg` this time; relaunching auto-syncs 76 records, `fad-backend#1200` in the DB, normal startup.

  - Usage: just search `1200` or `fad-backend` to locate the task in one second.

- **v0.3.5 (2026-09-04) — Board state follows GitHub issue state + sync robustness fixes**

  - User feedback: almost all tasks on the board stayed at "to-do"; only those manually changed via MCP/skill changed; they want **the board state to reflect the issue's real state**.

  - Changes (`sync.rs`): GitHub-closed issues now **auto-move to "Completed"** (`status='done'`, overriding local manual state) with a `candidate_done` flag; tasks still open but no longer related to the user are removed from the board. Open issues keep their local manual four-state (todo/doing/processed/done), not force-overridden.

  - **Also fixed two real robustness defects** (surfaced while debugging):

    1. `github.rs`'s `run_gh` originally waited indefinitely via `Command::output()`; a hung `gh` (rate-limit backoff / network TLS timeout) would block the whole sync **forever**. Added a 30s invocation timeout (polling `try_wait`, kill + error on timeout, skipped by best-effort).
    2. `sync.rs`'s stale loop originally `DELETE`d tasks when `fetch_state` failed — under rate limit / jitter it could wrongly delete and empty the whole board. Now it only deletes when `fetch_state` explicitly returns `open` (i.e. confirmed still open but unrelated to me); query failures always keep tasks, avoiding a single rate-limit clearing the board.

  - Verification: `open -g` to launch the new build → auto-sync → inserted a real closed issue (`fad-backend#1195`) simulating "opened then closed"; after sync that task has `status=done / gh_state=closed / candidate_done=1`, while the other 77 open issues stay `todo`. During debugging, old code + a rate limit once wrongly deleted 76 records; restored with the fix (normal sync re-pulls them automatically, no external recovery needed).

- **v0.3.6 (2026-09-04) — Board state linked to GitHub Project (OMS Kanban) Status field**

  - User feedback: issues like `#1247/#1237/#1223` already show progress like "dev complete, testing" on GitHub, but the board stays at "to-do".

  - Root cause: the board previously **only read the `state` (open/closed) from the GitHub Search API**. The team expresses progress via the GitHub Project **"OMS Kanban" Status field** (e.g. `🔎dev complete/testing`), which the Search API never returns — so the board has no awareness of these issues and stays at the initial `todo`.

  - Changes:

    - `github.rs` added `fetch_project_status()`: paginate the whole OMS Kanban items' `Status` at once via GraphQL (mapped by `repo#number`); added `run_gh_graphql()` reusing `run_gh`'s 30s timeout.

    - `sync.rs` added `map_project_status()`, mapping Project Status to the board's four states (`🧠需求池/🤔产品规划/🚧待开发处理→待处理`, `✨开发中→处理中`, `🔎开发完成/测试中/✅测试通过/待上线→已处理`, `🎉完成/上线/↩️取消→已完成`); during sync, for issues "in the Project" the Project Status is authoritative and overrides local manual state; issues not in the Project stay unchanged.

    - `db.rs` added a `gh_status` column (with legacy migration); `commands.rs` / frontend `types.ts` / `TaskCard.tsx` pass it through and show that raw status badge on the card.

  - Verification: `npm run tauri build` passes (`.app` produced; `.dmg` still restricted by the sandbox `/Volumes`); launching the new build and auto-syncing then cross-checking — `#1223`→已处理 (`🔎dev complete/testing`), `#1247`→处理中 (`✨dev in progress`), `#1237`→待处理 (`🧠需求池`, whose real state is indeed the demand pool, not testing); all 77 issues' `gh_status` are populated and mapped correctly.

  - Note: the user assumed all three were "dev complete/testing"; in fact only `#1223` is; `#1247` is in-progress and `#1237` is in the demand pool — after the fix the board reflects the **real** state on GitHub. To adjust the mapping later (e.g. also classify "测试通过/待上线" as done), edit `sync.rs`'s `map_project_status`.

- **v0.3.7 (2026-09-04) — Fix "Sync now" freezing the whole app (beachball spin)**

  - Symptom: clicking "Sync now" in the UI makes the mouse spin (macOS rainbow/beachball), looking frozen.

  - Root cause: the frontend `doSync` already sets `syncing=true` and shows "Syncing…" and disables the button, but the Rust end `sync_now` is a **synchronous command** that runs the entire sync (5 Search API + 1 GraphQL, 5–15s) **on the main (event-loop) thread**. The main thread saturated → macOS spins, the UI can't render "Syncing…", looks frozen. The tray's "Sync now" went through `thread::spawn` on a worker thread so it didn't have the problem — only the UI button's frontend `invoke('sync_now')` did.

  - Fix: `sync_now` became an `async` command, moving the real `sync::run` to a worker thread via `tauri::async_runtime::spawn_blocking`; the main thread only dispatches and returns immediately. The UI never freezes; "Syncing…" renders normally. No frontend change needed (`invoke` is transparent to sync/async commands).

  - Verification: `cargo check` + `npm run tauri build` pass; launching the new build auto-syncs fine (77 records, mapping unchanged, `last_sync_error` empty), process stays alive. The macOS spinner issue is structurally eliminated (async commands no longer block the main thread).

- **v0.3.8 (2026-09-04) — Auto-purge completed tasks after 30 days + show real assignee names**

  - User feedback (two items):

    1. "Keep completed issues for only 1 month" — completed tasks pile up, the board gets longer and longer.
    2. "If a task is already assigned to someone else, show that person's name instead of 'assigned to others'" — `assigned-others` uniformly showed "assigned to others", hiding who it is.

  - Changes:

    - `db.rs` added two columns: `assignees TEXT` (all assignee logins of the issue, comma-separated) and `done_at INTEGER` (timestamp when first entering "Completed", default 0); both with legacy `ALTER TABLE` migration.

    - `sync.rs` writes: INSERT stores `assignees = t.assignees.join(",")`; `done_at` uses a `CASE` — stamps the current timestamp the **first time** it becomes `done`, then stays unchanged (not reset each time), and resets to zero when leaving `done` (re-do restarts the clock). The stale loop's GitHub-closed→`done` path stamps `done_at` too.

    - `sync.rs` adds **30-day pruning** at the end: `DELETE FROM tasks WHERE status='done' AND done_at>0 AND now-done_at > 2592000`. Records with `done_at=0` (pre-v0.3.8 history with unknown completion time) are **not pruned** — only new tasks with a real timestamp and >30 days past completion are retired, avoiding a one-shot deletion of history. Prune count is returned via `SyncResult.pruned`.

    - Frontend passthrough: `commands.rs`'s `Task` gains `assignees` (SELECT/mapper indices synced); `types.ts`'s `Task` gains `assignees`, `SyncResult` gains `pruned`; `App.tsx` sync-result text adds "· cleaned completed N".

    - `TaskCard.tsx`: `assigned-others` no longer shows "assigned to others"; instead shows `@login1 @login2` (split from `assignees`). `notassignee` still shows "unassigned", and `assigned` still shows no ownership tag.

  - Verification: `cargo check` + `npx tsc --noEmit` both pass; `npm run tauri build` produces `.app` (`.dmg` handled separately when the sandbox blocks `/Volumes`). Logic self-check: freshly completed tasks' `done_at` within 30 days aren't cleared; historical `done_at=0` tasks are kept; `assigned-others` cards show the real `@name`.

- **v0.3.9 (2026-09-04) — Card enhancements: my-red marker / assignee / @me / new-comment link / linked PR**

  - User feedback (five items, merged into one release):

    1. Issues assigned to me (own) get a **red, eye-catching** marker.
    2. Add a row for **assignee** above the "time" on the card, supporting multiple (some issues have two assignees), format `@a @b`.
    3. Mark cards where someone **@mentions me** in the comments.
    4. When there is a **new comment**, record the latest comment's link, one-click jump from the card.
    5. If an issue has a corresponding **PR**, record the PR number and link for easy lookup.

  - Changes:

    - `db.rs`: added five columns `mentioned` / `comments_count` / `latest_comment_url` / `pr_number` / `pr_url` (with legacy `ALTER` migration).

    - `github.rs`: `RawTask` gains `comments` (comment count from search); added `fetch_prs()` (one paginated pull of all org PRs, taking `repo#number/url/body`) + `fetch_comments()` (the issue's latest comment `html_url`); new `JQ_PRS` projection.

    - `sync.rs`:

      - **@me**: reuse the `mentions:` search source (`mention_keys` set); `mentioned = in the set && not assigned to me`; if the mentions source fails, keep existing markers.

      - **PR linking**: after `fetch_prs`, parse each PR body's `#N` / `owner/repo#N` refs with `parse_issue_refs()` to build a reverse `repo#issue -> (pr_number, pr_url)` map; only updated if the PR list fetch succeeded (else keep existing).

      - **New comments**: only re-fetch `fetch_comments` when the comment count increased since last time **and** the single-sync budget (≤30 records) allows, taking the latest comment's permanent link; otherwise keep the cache, controlling API call volume.

      - All the above written via `INSERT/ON CONFLICT`.

    - Frontend: `commands.rs`'s `Task` gains `mentioned/latestCommentUrl/prNumber/prUrl` (SELECT/mapper indices synced); `types.ts` synced; `TaskCard.tsx` renders — `mine` red left border + "★ 我的" red badge, an `分配人` row (multiple `@names`), an orange "📣 @我" badge, "💬 新评论" and "🔗 PR #N" jump links (click opens the local browser via `open_in_browser`, without triggering card selection); `styles.css` adds matching styles; `DetailPanel.tsx` shows assignee/@me/PR/comment links too.

  - Verification: `cargo check` + `npx tsc --noEmit` pass; `parse_issue_refs` validated against multiple sample sets (including `owner/repo#N`, `/path/repo#N`, no-ref) for correct mapping; `npm run tauri build` produces `.app` and `.dmg`.

  - Notes (trade-offs):

    - **@me** is based on the GitHub `mentions:` search (covers @ in body+comments), not a per-comment fetch, so it costs zero extra API calls and stays consistent with the existing 5-source merge; if an issue only @s me in comments and `mentions:` misses it (rare flakiness), it may go unmarked.

    - **New-comment links**: the first sync fetches comments for all issues with "comment count > 0" (bounded by the 30-records-per-sync budget; a few issues are deferred to later syncs); `fetch_comments` only takes the last of up to 100 comments (generally enough).

    - **PR linking** infers from `#N` in PR bodies, a plain-text heuristic: strings like "step #1" that aren't real refs could be mis-linked (low risk); cross-repo `owner/repo#N` is supported.

- **v0.3.9.1 (2026-09-04) — Fix PR linking stuck at 0 (pipe-buffer deadlock, not rate limiting)**

  - Symptom: of v0.3.9's five card enhancements, the first four (red badge/@me/assignee/new comments) worked, but **only "linked PR" (`pr_number`) was 0 across the board**. Isolated verification (`parse_issue_refs` + real PR bodies + real DB keys) proved the logic layer should hit 44/77, yet production was always 0.

  - Root cause (overturning the earlier "GitHub secondary rate limit" misdiagnosis): `github.rs`'s `run_gh_once` only called `read_to_end` on stdout/stderr **after** the `gh` process had exited. When `gh`'s output exceeds the OS pipe buffer (macOS ~64KB, e.g. a single-page `fad-backend` PR JSON at 442KB), `gh` **blocks on write after filling the pipe and the process never exits**, so it waits until the 60s timeout then `kill` — that page of PRs is skipped by best-effort → `prs` empty → `pr_number` all 0. Evidence: running `fetch_prs` in isolation (no searches) still hit 60s timeouts on 3/4 repos, **only the small-response repo `flutter-driver` succeeding**; the same `gh api .../pulls?per_page=100` ran in 2.3s directly in bash yet timed out at 60s in the Rust subprocess.

  - Fix:

    1. `run_gh_once` now **drains stdout/stderr concurrently on a separate thread** (`thread::spawn` + `read_to_end`), while the main loop only `try_wait`-polls the timeout; `gh` no longer blocks on a full pipe (the core fix).
    2. `RawPr.repo` gets `#[serde(default)]`: the REST pulls JQ projection doesn't emit `repo`, and the original deserialization failed with "missing field repo" (`flutter-driver` already exposed it).
    3. PR fetch timeout relaxed to 60s per call (`gh` handles per-`Retry-After` backoff itself; removed the outer 3× retry that amplified to 180s/page).
    4. `sync.rs`: 4s phase cooldowns at search→PR and PR→project-status, plus comment budget 30→12 (polish, not the main cause).

  - Verification: `cargo test --lib -- --ignored test_fetch_prs_isolated` — isolated `fetch_prs` at 793 PRs / 31.6s (was 60s timeouts on 3/4 repos pre-fix); `test_headless_sync_pr_linkage` (updated to copy the production DB to a temp copy, not mutating user data) — full `sync::run` measured `pr_number>0 = 44/77` in 69.7s (was 222.9s and all 0 pre-fix). Frontend `TaskCard.tsx`(🔗 PR #N) / `DetailPanel.tsx`(PR #N button) closed via `rename_all=camelCase`.

  - Takeaway (general): in Rust, when pulling output from a subprocess that "may exceed the pipe buffer", **always drain stdout/stderr concurrently**, or use `output()`; "wait for exit then read output" is guaranteed to deadlock with large payloads — a more common pitfall than "rate-limit retry / timeout tuning".

- **v0.3.10 (2026-09-04) — Card info rework + branch/handoff records + UX fixes (8 items total)**

  - Background: 8 pieces of feedback/requests on "task card info" from the user (incl. 4 screenshots). Landing each below:

    1. **(design clarification) how session ids are stored**: currently **manual entry** — enter the session id + pick an agent in the detail page's "Interrupted session" → the `record_session` command writes to local SQLite (`session_id` / `session_agent` / `session_at`). It is **not** MCP-auto-written; the "MCP Server + Skill auto-recording" planned in PRD.md is not yet implemented (architecture reserved, not started). This release keeps manual entry; MCP auto-recording waits for a separate slot.
    2. **agent dropdown filled out with mainstream entries**: `DetailPanel.tsx`'s agent `<select>` expanded from 3 items (claude-code / workbuddy / doubao) to **10**, adding `opencode` / `codex` / `zcode` / `gemini-cli` / `cursor` / `aider` / `qwen-code` (kept in a centralized const array, easy to extend).
    3. **click empty space to close the detail**: `App.tsx` wraps a `.detail-backdrop` mask outside `DetailPanel` (covering the board area, `z-index:10`); clicking the mask runs `setSelected(null)`; the detail panel is `z-index:11`, clicks on it don't pass through. The close button remains.
    4. **"Unassigned" moved above the time row + only "mine" beside the issue**: `TaskCard.tsx` removes "assignee @name" / ownership badge from `card-top`; `card-top` keeps only `repo` / `#number` / "★ 我的" (if assigned to me) / Project status. `Unassigned` and `assignee @name` are consolidated into the "row above the time" (`meta-row`), no longer crowding the title row.
    5. **"@me" moved to the row above the time**: the `mention-badge` (📣 @me) moves from `card-top` (title row) to `meta-row` (above the time row), on the same line as "unassigned/assignee"; the title row is no longer crowded.
    6. **record the linked branch**: a GitHub issue has no branch field; it can only be inferred from the **linked PR's `head.ref`**. `github.rs`'s `RawPr` gains `head_ref` and is added to the `JQ_PRS_REST` projection; `sync.rs`'s `pr_map` expands from `(num,url)` to `(num,url,branch)`, writing to the new `branch` column on a match; `db.rs` adds the `branch` migration; the card `meta-row` shows "🌿 <branch>" when `branch` is non-empty.
    7. **record handoff tasks**: added a `handoff TEXT` column + `record_handoff(key, text)` command + frontend `api.recordHandoff`. `DetailPanel.tsx` adds a "Handoff" section (textarea + save, restorable). Once connected to claude / codex etc., the agent invokes this command when it recognizes a "create handoff task" intent; this release lands the storage layer and manual entry first; agent auto-trigger requires MCP/command integration (same source as #1).
    8. **fixed card width + controlled truncation**: `styles.css` board grid changed from `repeat(4, minmax(0,1fr))` to `repeat(auto-fill, minmax(248px,1fr))`, cards `width:100%` and no longer squashed too narrow; `card-top` set `flex-wrap:nowrap` with `repo/num/★mine` not shrinking/wrapping (root-cause the "wrapping that shouldn't wrap"); only `gh-status` (Project status, possibly long) keeps an ellipsis.

  - Files changed: `db.rs` (two-column migration), `github.rs` (`head_ref` + JQ), `sync.rs` (`pr_map` triples + read/write `branch` + test DB ALTER), `commands.rs` (`Task` gains `branch`/`handoff`, SELECT/mapper index sync, `record_handoff` registered), `lib.rs` (register `record_handoff`), `types.ts` / `api.ts` (add `branch`/`handoff` + `recordHandoff`), `TaskCard.tsx` (meta-row rework), `DetailPanel.tsx` (agent list + handoff block), `App.tsx` (backdrop), `styles.css` (grid/card/meta-row/backdrop styles).

  - Verification: `cargo check` passes; `npm run build` (`tsc --noEmit && vite build`) passes; `npm run tauri build` produces `TaskBoard.app` (`.dmg` still sandbox-blocked on `/Volumes`, not produced). The `record_handoff` command is registered in `invoke_handler`, alongside `list_tasks` etc.

  - Migration note: the new `branch` / `handoff` columns are auto-backfilled by `db.rs::init`'s `ALTER TABLE` on app startup (old DBs without them won't error); **after relaunching with the new build** the first-screen `SELECT` can read the new columns.

- **v0.3.11 (2026-09-04) — agent dropdown expanded to 38 mainstream coding agents**

  - Background: v0.3.10 only expanded the agent dropdown to 10 items, but the user's screenshot showed 20+ mainstream agents in the wild, needing completion to cover common tools.

  - Changes: `DetailPanel.tsx`'s `AGENTS` const array expanded from 10 to **38 items** (covering Claude Code / Codex / Codex CLI plus OpenCode, ZCode, Gemini CLI, Cursor, Aider, Qwen Code, and Copilot, Windsurf, Augment, Amazon Q, Devin, Replit, Bolt, v0, Cline, Roo Code, Continue, Cody, Codeium, OpenHands, Factory, Goose, Phind, Tabnine, ChatGPT, Grok, Codestral, Llama, Helix CLI, and Chinese agents 豆包 / 通义灵码 / 智谱 GLM / Trae / Kimi / DeepSeek / CodeBuddy etc.). `value` uses a normalized slug (matching the name MCP/agents self-report, so archived `session_agent` still matches), `label` is the display name; the rest of the storage/display chain is unchanged.

  - Sync note: agent names in the MCP Server, AGENT_INSTRUCTIONS.md, and CLAUDE.md are **free strings** (no whitelist), so they don't need to be synced with the dropdown; the dropdown is only a quick pick for manual entry.

  - Verification: `npm run build` (`tsc --noEmit && vite build`) passes; `npm run tauri build` compiles and packages `TaskBoard.app` successfully (`.dmg` still not produced due to the sandbox `/Volumes` restriction — as before, not a code issue).

- **v0.3.12 (2026-09-04) — MCP Server built into the app binary (eliminating scattered folders + Python dependency)**

  - Background (user feedback): after installing `.app`, the MCP Server is still a separate process, referenced by `~/.workbuddy/mcp.json` via an **absolute path hard-coded to this machine** pointing at `mcp_server/server.py` + a managed python interpreter. It and the app are two separate things — installed app ≠ installed MCP; you must keep the `mcp_server/` folder separately, and that config breaks on another machine.

  - Root cause: MCP was previously an external Python script never packaged into the Tauri artifact; though its DB path matched the app's (`~/Library/Application Support/com.liushizhao.taskboard/taskboard.db`), its runtime was fully separate.

  - Approach (user chose B: a native Rust subcommand): make MCP a **fully built-in** `mcp` subcommand of the `taskboard` binary, rather than packaging Python resources (option A still depended on the system python3 and was still scattered files).

  - Changes:

    1. `db.rs`: extracted GUI-less `db_path_default()` (derived from `dirs::data_dir()` + `APP_IDENTIFIER`, consistent with Tauri `app_data_dir` resolution), `data_dir()`, and the `APP_IDENTIFIER` const; added a shared `open_db(path)` (create tables + all historic `ALTER` migrations + default settings); the GUI's `init(app)` now calls it, ensuring **a single source of truth for the schema and zero drift between MCP and GUI**.
    2. New `mcp.rs`: `src-tauri/src/mcp.rs` implements stdio JSON-RPC 2.0 (LSP `Content-Length` framing, byte-by-byte reading to avoid `BufRead` vs `read_exact` misalignment); full coverage of `initialize` / `ping` / `tools/list` / `tools/call`, notifications (no id) not replied to; `busy_timeout=5000` (set via `execute_batch`, compatible with GUI concurrent usage); 6 tools (`list_my_tasks` / `get_task_status` / `update_task_status` / `record_session` / `record_handoff` / `clear_session`) fully aligned with `mcp_server/server.py`; `issue` reference parsing (`repo#number` / `owner/repo#number` / GitHub URL) and the state enum (four states + Chinese) consistent; `parse_issue_ref` hand-written with the pure standard library (no `regex` dependency).
    3. `main.rs`: when argv contains `mcp`, call `taskboard_lib::run_mcp()` (stdio loop, **no GUI**); otherwise the original `run()`. `lib.rs` registers `mod mcp` + `pub fn run_mcp()`.
    4. `mcp_server/server.py` kept as a **portable / dev fallback** (on non-macOS or before the app is installed, agents can still read/write the same DB), keeping the same tool contract as the built-in binary; the README config snippet now points at the in-app binary and explains the fallback path.
    5. The `taskboard` entry in `~/.workbuddy/mcp.json` changed to `"command": "/Applications/TaskBoard.app/Contents/MacOS/taskboard", "args": ["mcp"]` (the standard path once installed at `/Applications`; change to the absolute path if installed elsewhere).

  - Verification: `cargo check` passes; `cargo build --release` produces `target/release/taskboard` (12 MB); **smoke test** (Python driving the binary's `mcp` subcommand) measured: `initialize`→`serverInfo v0.3.12`, `tools/list`→all 6 tools present; against **the production DB** `list_my_tasks` returns 78 real tasks; against a **DB copy** all 4 write tools (`update_task_status` / `record_session` / `record_handoff` / `clear_session`) return `isError:false` and `get_task_status` reads back `handoff` correctly (production DB untouched). Copied the new binary `cp` into `TaskBoard.app/Contents/MacOS/taskboard` and re-tested `initialize` / `tools/list` against that in-app binary — normal, no `busy_timeout` error (the PRAGMA-returning-a-row error was fixed by using `execute_batch`).

  - Result: installed app = MCP built in; point mcp.json at the in-app binary and you're done — **no separate `mcp_server/` folder, no managed python dependency**.

- **v0.3.13 (2026-09-04) — Card tweaks: remove assignee display + fixed column width with horizontal scroll**

  - Background (3 user feedback items, with screenshots):

    1. Move "unassigned" up one row, above the date.
    2. Remove the assignee info after the issue id.
    3. Fix the card width; add a horizontal scrollbar to the board.

  - Changes:

    - `TaskCard.tsx`:

      - Removed the "assignee @xxx" whole block from `meta-row` (the `assigneeNames` computation removed too).

      - "Unassigned" stays in `meta-row` (the row above the date), now based on `task.ownership === "notassignee"` (consistent with the `.unassigned` left border), no longer reliant on splitting `assignees`.

      - `meta-row` comment updated ("@me / unassigned / linked branch; assignee no longer shown").

    - `styles.css`:

      - `.board` changed from `display: grid` (`repeat(auto-fill, minmax(248px, 1fr))`) to `display: flex; flex-direction: row; overflow-x: auto; overflow-y: hidden; min-height: 0;` — columns beyond the window width scroll horizontally.

      - `.column` fixed at `flex: 0 0 320px; width: 320px;` — column width (and thus card width) now constant (~300px readable), no longer squeezed or stretched.

      - `.card` comment updated (width follows the column width).

  - Note on #1: in source, "unassigned" has been on the row above the date (`meta-row`) since v0.3.10, but the screenshot showed it stuck after the issue id — meaning the running `.app` frontend was a stale build without the v0.3.10 card rework. This release rebuilt a new `.app` via `npm run tauri build`; the source was already correct and the runtime is now corrected too.

  - Verification: `npm run build` (`tsc --noEmit && vite build`) passes; `npm run tauri build` produces `TaskBoard.app` and `TaskBoard_0.1.0_aarch64.dmg` in one go (this time the dmg also succeeded; the sandbox didn't block).

- **v0.3.14 (2026-09-04) — Card reverse-adjustments: restore assignee + branch into detail + horizontal scroll up to the app + fix sync-button hover**

  - Background (4 user feedback items, with screenshots): some of v0.3.13's card changes need to be reverted, plus fix the "Sync now" button whose text disappears on hover.

    1. Restore the "assignee @xxx" display on the row above the date (card `meta-row`).
    2. Cards no longer show the branch; the branch **shows only in the card detail (DetailPanel)**.
    3. Undo the `.board` horizontal scroll; instead add a horizontal scrollbar to the **whole `.app`** (when board columns exceed the window width, the whole window scrolls horizontally; topbar/toolbar `position: sticky; left:0` stay visible).
    4. Hovering the "Sync now" button turns it white with white text → invisible text; fix it.

  - Changes:

    - `TaskCard.tsx`:

      - Restored `const assigneeNames = task.assignees ? task.assignees.split(",").filter(Boolean) : [];`.

      - `meta-row` re-renders the whole "assignee" block (`assignee-info` with label + multiple `assignee-name` `@xxx`); unassigned still based on `ownership === "notassignee"`.

      - Removed the `🌿 branch` (`branch-tag`) render from `meta-row` — the branch no longer appears on the card.

    - `DetailPanel.tsx`: added a row `🌿 分支：{task.branch}` below "GitHub" block's "assignee / unassigned" (only when `task.branch` exists), so removing the branch from the card doesn't lose the info.

    - `styles.css`:

      - `.app` gets `overflow-x: auto` (horizontal scroll moved up to the whole window).

      - `.board` drops `overflow-x: auto; overflow-y: hidden;`, keeps `display:flex; flex-direction:row` + `min-height:0` (a column container; column width still fixed at 320px).

      - `.topbar` / `.toolbar` get `position: sticky; left: 0; z-index: 5;` so search/sync/settings stay visible when the window scrolls horizontally.

      - Added `.btn.primary:hover:not(:disabled)` (`background:#0858d6; border-color:#0858d6; color:#fff`) — its specificity (0,4,1) exceeds `.btn:hover:not(:disabled)` (0,3,1), keeping the accent background + white text, eliminating white-on-white.

  - Verification: `npm run build` (`tsc --noEmit && vite build`) passes; `npm run tauri build` compiles and produces `.app`; the `.dmg` was blocked by the sandbox `/Volumes` mount failure, so packaged via `hdiutil create -srcfolder` reading the folder directly, producing `TaskBoard_0.1.0_aarch64.dmg` (4.2MB).

- **v0.3.15 (2026-09-04) — Fully replace the gh CLI with a GitHub PAT + visual polish (card colors / "mine" background)**

  - Background: user feedback "using the gh command feels off — after switching the gh account nothing is fetched; suggest using GitHub login to fetch task info". Building on the two gh legacies this session uncovered, the gh subprocess path is formally removed; card visuals are polished in the same release.

  - **Architecture change (PAT replaces gh)**:

    1. Removed all gh subprocess code in `github.rs` (`resolve_gh` + `run_gh` / `run_gh_once_timed` / `current_login` / `run_gh_graphql`, ~250 lines); added `GitHubClient { pat, login, http }` using `reqwest` blocking + `rustls-tls` (no native-tls dependency, clean cross-platform builds) to call GitHub REST/GraphQL directly. Dropped the 800ms call interval and the 4s stage cooldowns; the client now actively parses `X-RateLimit-Remaining` / `X-RateLimit-Reset` / `Retry-After` (a fixed 1s interval still between Search calls, matching the 30 req/min cap).
    2. `db.rs` default settings add `pat_token` + `last_sync_error`; `meta` is a kv table, new fields written on first startup by `DEFAULT_SETTINGS`.
    3. `sync.rs` reworked: builds `GitHubClient` from `pat_token` (auto-probing login via `GET /user` on construction and caching it); an empty PAT errors with "not configured", which `lib.rs` uses to skip the sync and write the error hint. `sync.rs` no longer touches `gh_path` / probes the gh path / the current gh login user.
    4. `commands.rs` adds three Tauri commands `save_pat` / `test_pat` / `clear_pat` (auto-detect the account when constructing the client, writing back to `meta.login` for display); `Settings` gains `hasPat` / `lastSyncError`.
    5. `lib.rs`: `run_sync` checks the PAT before starting; if missing, sets `last_sync_error` and skips; on success clears the field; frontend `App.tsx` renders `lastSyncError` as a red banner.
    6. `SettingsPanel.tsx`: PAT input (password type) + current account display + three buttons "Save PAT / Test connection / Clear". After saving, clears the input (to deter shoulder-surfing / screenshots). `gh_path` kept as a read-only compat field.

  - **Visual polish (released together)**:

    1. **Project Status colors top-right of the card**: added `gh-status-todo` (neutral gray) / `doing` (light blue) / `processed` (light purple) / `done` (light green) / `canceled` (light red), replacing the uniformly gray background. Match logic by keyword (kept in `TaskCard.tsx`, emoji and wording variants compatible).
    2. **"Mine" loses the pink background**: `.card.mine` drops `background:#fff6f6`, keeping only the 4px red left border; avoids confusion with warmer tags like "@me" (orange), "new comment" (green), "💬 new comment".

  - **Root-cause review (resolved)**:

    - Trigger event: the CI artifact's first sync had all 5 Search sources return 422 → `meta`'s `last_sync_error` read "Validation Failed".

    - Direct cause: `gh auth switch` switched to `ShawnLiuSZ` (an early GitHub **listed user** type), and the Search API rejects all searches for listed users (HTTP 422).

    - Deeper cause: the probe path used a subprocess `gh` + environment probing, which can't be decoupled from `gh`'s internal account switching; other legacies included the 60s pipe-buffer deadlock and the `gh api graphql -F` temp-file issues.

    - Direct fix: changed the DB `meta.login` back to `liushizhao2025` to restore the board instantly; this release cures it at the architecture level.

  - **Files changed**: `Cargo.toml` (+ `reqwest`), `github.rs` (full rewrite), `db.rs` (+2 settings), `sync.rs` (+49 lines, `fetch_*` de-gh params), `commands.rs` (+3 commands + PAT types), `lib.rs` (PAT check + new command registration), `mcp.rs` (version 0.3.11 → 0.3.15), `SettingsPanel.tsx` (PAT block +3 buttons), `TaskCard.tsx` (status class-name mapping), `App.tsx` (banner uses `lastSyncError`), `styles.css` (5 colors + remove pink background), `types.ts` / `api.ts` (PAT types & methods).

  - **Out of scope this release** (logged to backlog): fine-grained PAT onboarding, system-keyring storage, OAuth, device-code flow, multi-account switching (→ scheduled separately for v0.3.16).

  - Verification: `cargo check` 0 errors / 2 warnings (dead_code suppressed as a known pattern via `#[allow(dead_code)]`, with comments); `npm run build` passes; `npm run tauri build` produces a new `.app`.