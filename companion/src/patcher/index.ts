/**
 * Public surface of the patcher module (Import a table, ADR 0004): script text handling, the §4
 * classifier, the recipe renderers (A for VPM tables, B/C/D for originals), the manifest, and the folder import (plan / apply / stale
 * guard / remove-all). All I/O goes through a `WitnessFs`; nothing here ever modifies a `.vpx`.
 */
export { decodeScript, encodeScript, splitScript, joinScript, stripComment, vbStringLiteral, looksUtf16, describeScriptText, type ScriptLines, type Newline } from './script-text.js';
export { classifyScript, classifyLines, describeClass, type ScriptClass, type ClassifyResult, type ScriptFacts, type ScorbitAnchor, type OriginalSub } from './classify.js';
export {
  renderRecipeA,
  unpatchRecipeA,
  unpatchSidecar,
  recipeVersionFor,
  isRecipe,
  RECIPE_VERSIONS,
  type Recipe,
  block0,
  wrappers,
  formatLocalStamp,
  isOurSidecar,
  parseSidecarMarker,
  LIB_VERSION,
  RECIPE_VERSION,
  GUARD_MTIME_TOLERANCE_SEC,
  SIDECAR_MARKER,
  STUB,
  type RenderOptions,
  type Rendered,
  type SidecarMarker,
} from './render.js';
export { renderSidecar, renderRecipeB, renderRecipeC, renderRecipeD, recipeFor, callArgs, SCORE_SERVER_METHODS } from './render-originals.js';
export { ANCHOR_OVERRIDES, findOverride, overrideById, checkOverride, type AnchorOverride, type AnchorPlace, type AnchorRole } from './anchor-overrides.js';
export { lintSidecar, checkGameJournal, blockBalance, type JournalCheck, type JournalCheckOptions } from './validate.js';
export { isManifest, readManifest, writeManifest, type Manifest, type ManifestVerification } from './manifest.js';
export { tableIdFor, sidecarPathFor, stalePathFor, manifestPathFor, vpxPathForSidecar, joinPath, basenameOf, dirnameOf, isVpxName } from './paths.js';
export {
  planImport,
  applyImport,
  installLibrary,
  libraryVersionOf,
  checkSidecar,
  disableSidecar,
  removeAllSidecars,
  listVpxFiles,
  countActions,
  type PlanAction,
  type PlanItem,
  type ImportPlan,
  type PlanOptions,
  type ApplyOptions,
  type ApplyResult,
  type SidecarCheck,
} from './import.js';
