// Persona tool surface — Phase H1 (ai-agents.md §19.3, §24.3 H1).
//
// §19.3's exposure law: the four new relation/detail reads PLUS the six
// existing Layer B reads (get_policy_config, get_policy_catalog,
// get_data_completeness, get_validation_status, get_run_results, and
// get_project_memory when M2 is on) join the persona `toolDeclarations`
// behind COVERAGE_TOOLS_ENABLED. §24.1 homes the append in tools.ts; it
// lives in this sibling module because tools.ts cannot import the Layer B
// modules without an ESM init cycle (they import registerToolHandler FROM
// tools.ts) — the vvTools.ts module-layout precedent (§10 Q21a/Q22): same
// contract, testable home, no behavior change. Flag off ⇒ the UNCHANGED
// `toolDeclarations` array (the same object), so persona provider requests
// stay byte-identical to pre-H1 (pinned by the golden-transcript suite).
//
// Least privilege is preserved: everything here is a read; the draft_* tools
// never join the persona surface; Layer B agents keep their curated subsets
// (§3.2 bridge 2) — this module is consumed only by index.ts persona turns.

import {
  coverageToolDeclarations,
  coverageToolsEnabled,
  toolDeclarations,
  type ToolDeclaration,
} from "./tools.ts";
import { getDataCompletenessDeclaration } from "./draftTools.ts";
import { getPolicyCatalogDeclaration, getPolicyConfigDeclaration } from "./configuratorTools.ts";
import { getRunResultsDeclaration, getValidationStatusDeclaration } from "./vvTools.ts";
import { getProjectMemoryDeclaration, memoryEnabled } from "./memory.ts";
import { networkToolDeclarations } from "./networkTools.ts";

/** The complete persona read surface for this deployment's flag state. */
export function personaToolDeclarations(): ReadonlyArray<ToolDeclaration> {
  if (!coverageToolsEnabled()) return toolDeclarations;
  return [
    ...toolDeclarations,
    // §19.3 rows 1–4: the new relation/detail tools (registered in tools.ts).
    ...coverageToolDeclarations,
    // §19.3 rows 5–8: the EXISTING Layer B reads, exposed — never duplicated.
    getPolicyConfigDeclaration,
    getPolicyCatalogDeclaration,
    getDataCompletenessDeclaration,
    getValidationStatusDeclaration,
    getRunResultsDeclaration,
    // §28 A.1: the stored network analyses (critical nodes, centralities,
    // their freshness, counts) — reads of the analysis store, never computed.
    ...networkToolDeclarations,
    // §14.4: project memory joins every surface when M2 is on.
    ...(memoryEnabled() ? [getProjectMemoryDeclaration] : []),
  ];
}
