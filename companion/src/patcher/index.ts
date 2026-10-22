/**
 * Public surface of the patcher module (Import a table, ADR 0004): script text handling, the §4
 * classifier, the recipe-A renderer, the manifest, and the folder import (plan / apply / stale
 * guard / remove-all). All I/O goes through a `WitnessFs`; nothing here ever modifies a `.vpx`.
 */
export { decodeScript, encodeScript, splitScript, joinScript, stripComment, vbStringLiteral, type ScriptLines, type Newline } from './script-text.js';
export { classifyScript, classifyLines, describeClass, type ScriptClass, type ClassifyResult, type ScriptFacts, type ScorbitAnchor, type OriginalSub } from './classify.js';
export {
  renderRecipeA,
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
