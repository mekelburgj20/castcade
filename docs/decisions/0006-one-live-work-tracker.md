# ADR 0006 — One live work tracker per repo: `WORK.md`, lanes, claims, a board

**Status:** Accepted (2026-10-21)
**Owner rulings:** 2026-10-21, "a single tracking file and an associated tracking artifact"; items addressable
by ID ("let's work on item B13.4"); organised so several agents can take a section each without colliding,
or be orchestrated. Applies to Castcade and ArcAid alike (ArcAid records it as its ADR 0028).

## Context

ArcAid tracked work in four places that no single routine maintained: `ROADMAP.md` (611 lines, deep
backlog), `SPRINT_STATUS.md` (1,130 lines; 331 commits; "resume point" paragraphs of 1,500+ characters each),
`LAUNCH.md` (a hand-ordered index, rebuilt 2026-09-07 and never touched by `/update-docs` or `/release-docs`,
stale within six weeks) and plan docs under `docs/`. `/update-docs` audited drift across eleven files;
`/release-docs` rolled the sprint "arc" markers. Reading state at session start cost tens of thousands of
tokens; writing it cost a long paragraph per session, so it drifted (on 2026-10-21 `SPRINT_STATUS` ended
at v2.164.0 while `main` was at v2.166.1). Castcade had the same disease in miniature: `CLAUDE.md`'s
"Current state" section was a 1,900-word narrative that every agent loaded and nobody could address by item.

Nothing in either repo let an agent say "this item is mine" in a way another agent would see.

## Decision

### 1. One file: `WORK.md`

The only live tracker in a repo is `WORK.md` at its root. It holds a `## Now` block (at most 12 bullets)
and sections of one-line items. History lives in `CHANGELOG.md` and `git log -- WORK.md`; detail lives
where it always did (design docs, ADRs, spec sections) and items point at it with `spec:`. The former
trackers are frozen as archives with a note at the top, never appended to again.

### 2. A grammar, checked in CI

`- **ID** \`status qualifier\` Title — detail · key: value`. IDs are section letters plus a number, dotted
for sub-items, never reused and never renumbered. Eight statuses: `idea`, `ready`, `claimed`, `blocked`,
`review`, `done`, `parked`, and `dropped` (added 2026-10-21 after the first audit: will not be done, with the
ruling or reason as qualifier; the line and number stay). `tools/work-board.mjs --check` fails the build on duplicate IDs, unknown
statuses, dangling `needs:` and claims without `owner`/`since`. The full grammar is
`.claude/commands/work.md`.

### 3. Sections are lanes; claims are commits

Each section names the paths it owns (`Lane:`). An agent claims an item by committing the one-line
status change to `main` immediately (`work: claim B3.2`), and edits only lines of items it has claimed
plus items it appends. Claims older than seven days without activity may be released by anyone. An
orchestrating agent claims a parent item and gives each worktree subagent one sub-item scoped to the
lane; subagents never edit `WORK.md`.

### 4. A board, generated from the file

`tools/work-board.mjs` renders `WORK.md` to a self-contained HTML page, published as a claude.ai
artifact whose URL is written on the `Board:` line of `WORK.md` so every session republishes to the same
link. The page embeds the parser and re-reads `WORK.md` from `raw.githubusercontent.com` on load, so
for a public repo it is live without a republish. The file is the source of truth; the board is a view.

### 5. Three commands replace five

`/work [ID]` (start a session or claim an item), `/wrap` (end a session: statuses, new items, Now,
diff-scoped drift check, board, commit) and `/release-docs <version>` (CHANGELOG, flips to `done`, bump,
tag). `/update-docs` is retired; its doc inventory became the drift table in `/wrap`, scoped to the
session's diff instead of the whole repo.

## Consequences

### Easier
- Session start is `npm run work:summary`: one screen, not two long files.
- "Let's work on B13.4" is an exact address; the board's ID button copies that sentence.
- Parallel agents on different sections need no coordination; agents on one section coordinate
  through claims that are visible in `git log` and on the board.
- Drift checks are proportional to the session's diff.

### Harder
- Discipline: a narrative that used to be dumped into `SPRINT_STATUS` now has to be split into items,
  a commit message and a 12-line Now block. `/wrap` enforces this; agents will be tempted to add notes.
- `WORK.md` can conflict when two agents append to the same section at once. Resolution is trivial
  (keep both, renumber the later one) but it is a conflict.
- The board depends on the claude.ai artifact staying published and the repo staying public for the
  live refresh; the embedded snapshot is the fallback.

### Locked out
- Reintroducing a second live list (a `LAUNCH.md`, a `tmp/` bug list, a "Current state" paragraph in
  `CLAUDE.md`). Standing facts go in `CLAUDE.md`; open work goes in `WORK.md`; nothing else is live.

## Alternatives rejected

- **GitHub Issues + Projects.** The standard answer, and still the fallback if the file outgrows a page.
  Rejected now because the item list must travel with the code (a claim and the commit that found a
  follow-up land together), the owner reads the tracker in the editor, agents in worktrees work from
  files, and `gh` auth on the owner's machine is unreliable (the stale `GITHUB_TOKEN` problem).
- **YAML or JSON tracker with a generated Markdown view.** More machine-friendly, less human-editable;
  the owner and agents edit the file by hand far more often than tools read it.
- **Keep ROADMAP + SPRINT_STATUS and improve the commands.** The problem was not the commands but the
  number of places; any routine that must touch four files will skip one.
- **The artifact's database as the source of truth.** Puts the tracker outside git, invisible to
  worktree agents and to `git log`, and dependent on one hosted page.
