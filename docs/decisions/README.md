# Architecture Decision Records

Decisions that shape Castcade and are not derivable from the code. One file per decision, numbered,
never deleted: a superseded ADR gets a `**Superseded by:**` line and stays in the index.

## Index

| # | Title | Status | Date |
|---|---|---|---|
| 0001 | [Script hook, not a plugin, on VPX 10.8.0](0001-script-hook-not-plugin-on-vpx-10-8-0.md) | Accepted | 2026-10-17 |
| 0002 | [A Castcade match is a Throwdown play mode](0002-castcade-match-is-a-throwdown-play-mode.md) | Accepted | 2026-10-17 |
| 0003 | [One desktop app: Castcade uses Arcaid Witness](0003-one-desktop-app-castcade-uses-arcaid-witness.md) | Accepted | 2026-10-17 |
| 0004 | [Per-table import is primary; the shared core.vbs patch is a setup-time opt-in](0004-per-table-import-is-primary-shared-core-patch-is-opt-in.md) | Accepted | 2026-10-17 |
| 0005 | [Two integrity modes on a tournament: Open play and Sanctioned play](0005-open-and-sanctioned-play.md) | Accepted (names provisional) | 2026-10-18 |
| 0006 | [One live work tracker per repo: `WORK.md`, lanes, claims, a board](0006-one-live-work-tracker.md) | Accepted | 2026-10-21 |
| 0007 | [Functionality before ease of setup](0007-functionality-before-ease-of-setup.md) | Accepted | 2026-10-27 |
| 0008 | [A sanctioned VPX build for Sanctioned play; Castcade stays for everything else](0008-sanctioned-vpx-build.md) | Accepted (mechanism open) | 2026-10-30 |

**Next free number: 0009.**

## Convention

Castcade follows the style of ArcAid's recent ADRs (0016 onward in `C:\code\repos\ArcAid\docs\decisions\`),
not the older front-matter template:

```markdown
# ADR NNNN — Title

**Status:** Accepted (YYYY-MM-DD)
**Owner rulings:** the dated ruling(s) this records, one line
**Builds on / Amends / Supersedes:** other ADRs, when relevant

## Context
Why a decision was needed. Facts, with file paths and line numbers where they exist.

## Decision
What was decided. Use numbered `###` subsections when the decision has parts.

## Consequences
### Easier
### Harder
### Locked out

## Alternatives rejected
Each alternative and the reason it lost, so it is not re-proposed.
```

Rules:

- Record a decision when it is made, in the same session, while the reasoning is fresh.
- Cite sources. ArcAid paths are written as `ArcAid/...` relative to `C:\code\repos\`. ArcAid's own
  ADRs are cited by number (ArcAid ADR 0018, etc.) so the two series are never confused.
- Mark anything not verified in a running system as "unverified".
- A decision the owner has explicitly made is not reopened without asking; an ADR that records one
  says so in its `**Owner rulings:**` line.
