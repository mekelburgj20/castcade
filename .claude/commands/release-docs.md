Release sweep. `/release-docs <version>`, for example `/release-docs 0.2.11`. Mechanical; run after the
code is on `main` and `npm run check` is green, never for an unfinished arc.

## Steps

1. **Confirm the release is real.** `git log --oneline v<previous>..HEAD` must show the commits being
   documented. If `companion/package.json` already carries `<version>`, the sweep already ran; stop and
   ask whether to amend.
2. **CHANGELOG entry.** `git log --format='%h %B' v<previous>..HEAD`; read the bodies. Group by theme
   (two to four `###` subsections), lead each bullet with the user-visible behaviour, end it with the
   files or modules. Add a "Wire / journal" line whenever a score parameter, a protocol message or the
   journal format changed, with the fixture that covers it. Place the entry right under the
   `## [Unreleased]` heading as `## [<version>] — <date>`.
3. **Flip items.** In `WORK.md`, every item the release finishes becomes `` `done <version>` `` on one
   line (title only). Items it partly finishes keep their status and get a sub-item for the rest.
   Refresh `## Now`'s version line.
4. **Bump** `companion/package.json` `version` (nothing else). The root `package.json` version is not
   the product version; leave it.
5. **Check and commit.** `npm run check` (includes `work:check`). One commit:
   `release: v<version> — <one-line summary>`; then `git tag v<version>` and push the tag with the
   commit. `release.yml` builds the installer from the tag.
6. **Board.** `npm run work:board` and republish to the `Board:` URL in `WORK.md` (same as `/wrap` step 5).

## Does not

- Decide the version number (the owner's call).
- Audit docs for drift (`/wrap` does that at the end of every session).
- Run the tester kit or any field gate; those are items with a `gate:` field.
