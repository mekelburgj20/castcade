# ADR 0014 — Castcade wears the Arcaid look

**Status:** Accepted (2026-11-25); built as WORK E14 (PR #144), unverified in the real window and in a headset
**Owner rulings:** 2026-11-25: "I want Castcade to get the full Arcaid style UI/UX applied to it." After the phase 1
pictures: "The look is great. Let's get this implemented." Then: "Looks good to me. Do this in 0.2.51."
**Builds on:** ADR 0003 (Castcade is the desktop Arcaid Witness). **Source of the style:** ArcAid's style guide as
shipped (`ArcAid/.claude/rules/admin-ui.md`, sections "Themes", "Style guide (G21, v2.261.0)" and "Toasts";
`ArcAid/docs/style-guide-plan.md`; ArcAid ADR 0042).

## Context

Castcade's window had its own plain dark style, green and amber status colours, 10.5 to 11.6 px labels and no shared
parts. Arcaid has one look for its personal pages (the shipped Account Settings, G20): the designer's Arcaid Witness
kit (`admin-ui/public/aw-theme/`, shared with the cabinet app) on the arcade carpet, with rules for colour, type size,
focus, loading and empty states.

## Decision

1. Castcade wears Arcaid's **fixed dark "Arcaid look"** on every surface: the window and all its tabs, the Witness
   edition, the headset panel, the scoreboard card and the in-game menu. One skin; Castcade has no themes.
2. The kit, its OFL fonts and the carpet tiles are **verbatim copies** (`companion/renderer/src/aw-theme/`,
   `carpet/`, each README names the Arcaid commit; never edited). Castcade's own layer is
   `renderer/src/aw-castcade.css`; its parts are in `renderer/src/parts/`; the headset pages carry the kit inline
   (`src/media/aw-kit.ts`). Fonts are self-hosted (the app runs offline).
3. Arcaid's rules apply: cyan = fine, pink = attention (and your own ball), red = problem, no green or yellow; no colour
   literal outside the tokens; no functional text under 12 px; a visible focus ring; loading as placeholders in the
   content's shape; empty states that say what to do; toasts and menus never in a library's default look; never the
   Arcaid Witness picture.
4. Pictures of every state, before and after, are drawn by the story harness (`node renderer/story/shoot.mjs`) for the
   owner before a restyle merges.

## Consequences

### Easier
One look across Arcaid, the cabinet Witness and Castcade; Arcaid's rule list answers most style questions.

### Harder
A kit update in Arcaid is copied by hand; the headset pages carry about 100 KB of inlined kit; legibility in a headset
is still to be seen.

### Locked out
Castcade-only colours or fonts; a library's default component look.

## Alternatives rejected

- **Room themes in Castcade:** Arcaid's personal pages use one fixed look; Castcade has no rooms to theme.
- **Importing Arcaid's code:** the repos share no code (ADR 0003); Castcade mirrors the parts' geometry instead.
