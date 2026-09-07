# Changelog

> Per-version release notes and fix records for TaskBoard. For the current version and a project overview, see [README](../README.md).

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
    - The repository name is now a clickable link that opens `https://github.com/ShawnLiuSZ/task-dashborad` in the system browser
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