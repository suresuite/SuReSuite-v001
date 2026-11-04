import { useMemo, useRef, useState } from "react";
import { ProjectRightRefused } from "@/lib/auth/projectRights";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "sonner";
import { LAYER, tint } from "@/components/intelligence/piUi";
import { StagePolicyTable } from "./StagePolicyTable";
import { MobileStagePolicyList } from "./MobileStagePolicyList";
import { MobileGroup, MobileNote, MobilePanel, MobileRow } from "@/components/mobile";
import { LegacySettingNotice, ProjectRuleBar } from "./ProjectRuleBar";
import { PresetDiffBanner } from "./PresetDiffBanner";
import { LaneTruncationNotice } from "@/components/policies/LaneTruncationNotice";
import { RunValidateStage } from "./RunValidateStage";
import { getStage, type StageKey } from "@/lib/policies/stages";
import type { StageRowsQuery } from "@/hooks/useStageGuards";
import type { OverrideRow } from "@/lib/policies/resolve";
import type { FulfillmentStrategy, PolicyBundle, PolicyFamily } from "@/lib/policies/schemas";
import type { ProjectContext } from "@/lib/policies/resolvePreset";
import {
  CUSTOMER_RULE,
  FG_BUFFER_RULE,
  customerRuleFields,
  legacyFgBufferNote,
  legacyFgBufferShown,
  type RuleField,
} from "@/lib/policies/projectRules";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useProjectRights } from "@/hooks/useProjectRights";
// `excel.ts` and `xlsx` load on the first export/import (see handleExport).
const loadExcel = () => import("@/lib/policies/excel");

/** A project rule's fields as read-only phone rows. */
function ruleRows(fields: RuleField[], value: Record<string, unknown>) {
  return fields
    .filter((f) => !f.when || f.when(value))
    .map((f) => {
      const v = value[f.field];
      const shown =
        typeof v === "boolean"
          ? v ? "Yes" : "No"
          : v === undefined || v === null || v === ""
            ? "—"
            : `${f.optionLabel ? f.optionLabel(String(v)) : String(v)}${f.unit ? ` ${f.unit}` : ""}`;
      return <MobileRow key={f.field} chevron={false} label={f.label} value={shown} />;
    });
}

interface Props {
  projectId: string | null | undefined;
  stageKey: StageKey;
  defaults: PolicyBundle;
  overrides: OverrideRow[];
  ctx: ProjectContext | null;
  hasData: boolean;
  fulfillmentStrategy: FulfillmentStrategy;
  activePreset: string | null;
  presetAppliedAt: Date | null;
  saveDefault: <F extends PolicyFamily>(family: F, value: PolicyBundle[F]) => Promise<void>;
  bulkUpsertOverrides: (rows: OverrideRow[]) => Promise<void>;
  deleteOverride?: (scope: "node" | "edge", targetKey: string, family: PolicyFamily) => Promise<void>;
  clearActivePreset: () => Promise<void>;
  saveSnapshot: (label?: string, notes?: string, opts?: { quiet?: boolean }) => Promise<string | null>;
  /** Policy-version context for the Run & Validate credibility card (§9.5). */
  selectedVersionId: string | null;
  policyDirty: boolean;
  /** Lines per setup stage, loaded once at the page level for the step track —
   *  the grid and stage 4's verification read them instead of refetching. */
  rowsByStage: Record<Exclude<StageKey, "run_validate">, StageRowsQuery>;
  /** §23 WP 13.4 — how many grid lines hold unsaved drafts (the page guards leaving). */
  onDraftsChange?: (lines: number) => void;
}

export function FocusedStage({
  projectId,
  stageKey,
  defaults,
  overrides,
  ctx,
  hasData,
  fulfillmentStrategy,
  activePreset,
  presetAppliedAt,
  saveDefault,
  bulkUpsertOverrides,
  deleteOverride,
  clearActivePreset,
  saveSnapshot,
  selectedVersionId,
  policyDirty,
  rowsByStage,
  onDraftsChange,
}: Props) {
  const stage = getStage(stageKey);
  const isMobile = useIsMobile();
  // D230 — "Export" and "Edit Policies" on this project, as /profile lists them.
  const rights = useProjectRights(projectId);
  const canExport = rights.can("export");
  const canImport = rights.can("data_edit_policies");
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const stageOverrides = useMemo(
    () => overrides.filter((o) => stage.families.includes(o.family)),
    [overrides, stage],
  );

  const showBanner =
    activePreset != null &&
    !bannerDismissed &&
    activePreset.startsWith(`${stageKey}:`);

  const handleExport = async () => {
    if (!canExport) {
      toast.error(rights.refusal("export") ?? "Export isn't enabled for you on this project.");
      return;
    }
    const { exportStageWorkbook, downloadWorkbook } = await loadExcel();
    const wb = exportStageWorkbook(stage.title, stage.families, defaults, stageOverrides);
    const ts = new Date().toISOString().slice(0, 10);
    downloadWorkbook(wb, `policies-${stage.key}-${ts}.xlsx`);
    toast.success("Exported workbook");
  };

  const handleImportFile = async (file: File) => {
    try {
      const buf = await file.arrayBuffer();
      const [XLSX, { importStageWorkbook }] = await Promise.all([import("xlsx"), loadExcel()]);
      const wb = XLSX.read(buf, { type: "array" });
      const result = importStageWorkbook(wb, stage.families, defaults);
      if (result.errors.length) {
        toast.error(`Import had ${result.errors.length} error(s) — see console`);
        console.error("Excel import errors:", result.errors);
      }
      for (const f of stage.families) {
        const v = (result.defaultsPatch as Record<string, unknown>)[f];
        if (v) await saveDefault(f, v as PolicyBundle[typeof f]);
      }
      if (result.overrides.length) {
        await bulkUpsertOverrides(result.overrides);
      }
      toast.success(
        `Imported: ${Object.keys(result.defaultsPatch).length} default(s), ${result.overrides.length} override(s)`,
      );
    } catch (err) {
      // D230 — a refusal was already said by usePolicies.
      if (err instanceof ProjectRightRefused) return;
      console.error(err);
      toast.error("Failed to read workbook");
    }
  };

  const showNoData = !hasData && (!ctx || (ctx.supplier_count === 0 && ctx.customer_count === 0));

  if (stageKey === "run_validate") {
    return (
      <RunValidateStage
        projectId={projectId}
        plantName={ctx?.plant_name}
        defaults={defaults}
        overrides={overrides}
        fulfillmentStrategy={fulfillmentStrategy}
        saveSnapshot={saveSnapshot}
        selectedVersionId={selectedVersionId}
        policyDirty={policyDirty}
        supplierRows={rowsByStage.supplier.rows}
        plantRows={rowsByStage.plant.rows}
        customerRows={rowsByStage.customer.rows}
      />
    );
  }

  // The stage's project-level settings, one line above its grid
  // (`projectRules.ts`): the Customer stage's allocation rule, with 2+
  // customers only. The Plant stage has no project control — only a
  // notice for an FG buffer an older version saved, while it still acts.
  const ruleBar = ({ fgBufferRows, customerCount }: { fgBufferRows: number; customerCount: number }) => {
    if (stageKey === "customer") {
      const fields = customerRuleFields(customerCount);
      if (fields.length === 0) return null;
      return (
        <ProjectRuleBar
          family="fulfillment"
          title={CUSTOMER_RULE.title}
          hint={CUSTOMER_RULE.hint}
          fields={fields}
          value={defaults.fulfillment}
          onSave={(v) => saveDefault("fulfillment", v)}
          readOnly={!canImport}
        />
      );
    }
    // No FG buffer control (owner decision, WP 14.8): how much FG to keep is
    // the row's S. A buffer an older version saved is still read, so it shows
    // here, where it acts, until it is removed.
    const inv = defaults.inventory as unknown as Record<string, unknown>;
    if (stageKey === "plant" && legacyFgBufferShown(inv, fgBufferRows)) {
      return (
        <LegacySettingNotice
          title={FG_BUFFER_RULE.title}
          note={legacyFgBufferNote(inv, fgBufferRows)}
          actionLabel="Remove buffer"
          readOnly={!canImport}
          onAction={async () => {
            await saveDefault("inventory", { ...defaults.inventory, fg_safety_stock: "none" });
            toast.success("FG safety buffer removed");
          }}
        />
      );
    }
    return null;
  };

  const tableLeftActions = (
    <>
      <input
        ref={fileRef}
        type="file"
        accept=".xlsx,.xls"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) handleImportFile(f);
          e.target.value = "";
        }}
      />

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="h-[26px] px-2.5 text-[11.5px]">
            Excel ▾
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={handleExport} disabled={!canExport} className="text-[12px]">
            Export
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => fileRef.current?.click()} disabled={!canImport} className="text-[12px]">
            Import
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

    </>
  );

  const noDataBanner = showNoData && (
    <div
      className="flex items-center gap-2 rounded-sm border px-2.5 py-1.5 font-mono text-[11px]"
      style={{ borderColor: tint(LAYER.brand, 0.4), color: LAYER.brand }}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: LAYER.brand }} />
      no supply-chain data — upload and combine datasets in Data Manager
    </div>
  );

  // Below `md` the same sentence is the skin's amber consequence line (§13.6):
  // one frame, one voice, and the only fill the skin allows at that size. The
  // desktop banner above is untouched and only the mobile branch swaps.
  const noDataNote = showNoData && (
    <MobileNote>
      No supply-chain data — upload and combine datasets in Data Manager.
    </MobileNote>
  );

  // Mobile: check/verify, not configure (spec — see MobileStagePolicyList's own
  // header comment). No filter/sort/bulk-edit toolbar, no preset-applied
  // banner (the banner exists to explain a bulk
  // change that can't happen from here), and the Customer rules render as a
  // plain read-only summary instead of the desktop's one-line form.
  if (isMobile) {
    return (
      <div className="flex flex-col gap-[var(--m-gap)]">
        {noDataNote}
        <LaneTruncationNotice truncated={rowsByStage[stageKey].truncated} />
        <MobileStagePolicyList
          projectId={projectId}
          stageKey={stageKey}
          defaults={defaults}
          overrides={overrides}
          fulfillmentStrategy={fulfillmentStrategy}
          stageRows={rowsByStage[stageKey]}
        />
        {stageKey === "customer" && (
          <MobileGroup label="Project-wide">
            <MobilePanel label={CUSTOMER_RULE.title} counter="project-wide">
              {ruleRows(CUSTOMER_RULE.fields, defaults.fulfillment as Record<string, unknown>)}
            </MobilePanel>
          </MobileGroup>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {noDataBanner}
      <LaneTruncationNotice truncated={rowsByStage[stageKey].truncated} />

      {showBanner && (
        <PresetDiffBanner
          presetName={activePreset!.replace(/^[^:]+:/, "")}
          appliedAt={presetAppliedAt}
          changeCount={stageOverrides.length}
          onRevert={() => {
            clearActivePreset();
            setBannerDismissed(true);
          }}
          onDismiss={() => setBannerDismissed(true)}
        />
      )}

      <StagePolicyTable
        projectId={projectId}
        plantName={ctx?.plant_name}
        stageKey={stageKey}
        defaults={defaults}
        overrides={overrides}
        fulfillmentStrategy={fulfillmentStrategy}
        bulkUpsertOverrides={bulkUpsertOverrides}
        deleteOverride={deleteOverride}
        saveSnapshot={saveSnapshot}
        leftActions={tableLeftActions}
        stageRows={rowsByStage[stageKey]}
        onDraftsChange={onDraftsChange}
        ruleBar={ruleBar}
      />
    </div>
  );
}
