# The Arcaid Witness kit (verbatim, never edit)

Copied on 2026-11-25 from the Arcaid repository (`github.com/mekelburgj20/ArcAid`, public),
`admin-ui/public/aw-theme/`, at commit `df7340d8e` (the kit's last change, 2026-11-15):

- `aw-theme.css`: the designer's kit (tokens `--aw-*`, the fonts, `.aw-panel`, `.aw-label`, `.aw-chip`, `.aw-brand`, ...).
- `aw-theme-ext.css`: Arcaid's extension of the kit (the red problem colour, `--aw-red`).
- `fonts/`: Audiowide, Chakra Petch and Orbitron as woff2, each under the SIL Open Font License 1.1
  (`LICENSE-*.txt` beside them).

**Verbatim, never edit.** A newer kit is copied over these files whole, with this README's date and commit
updated. Castcade's own layer is `../aw-castcade.css` (the equivalent of Arcaid's `aw-web.css`): Castcade's
scale, the arcade-carpet ground, the window shell and Castcade's parts. `../app.css` imports the kit, then
the layer.

`aw-theme.css`'s `.aw-screen` rule names the Arcaid Witness background picture. That picture belongs to
Arcaid's three Witness pages and is not copied here: Castcade never uses `.aw-screen` (its ground is the
carpet, `../carpet/`), and `vite.config.ts` leaves that one URL unresolved on purpose.
