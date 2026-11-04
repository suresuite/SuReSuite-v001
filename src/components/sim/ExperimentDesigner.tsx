import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Beaker, Play, Trash2, Plus } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useGlobalProject } from "@/hooks/useGlobalProject";
import { useScenarios, type Scenario } from "@/hooks/useScenarios";
import { useRecoveryPlaybooks } from "@/hooks/useRecoveryPlaybooks";
import { useExperiments } from "@/hooks/useExperiments";
import { fullFactorial, latinHypercube, type Factor } from "@/lib/sim/doe";
import {
  PLAYBOOK_FACTOR_KEY,
  materializeDesignRow,
  scenarioNameForRow,
} from "@/lib/sim/playbookFactor";
import { ExperimentResultsPanel } from "./lazyCharts";

type DesignType = "factorial" | "lhs";
type NumericFactorKey = "replications" | "horizon_days" | "warmup_days";

interface NumericFactorDraft {
  key: NumericFactorKey;
  levels: string; // CSV
}

const NUMERIC_FACTOR_LABELS: Record<NumericFactorKey, string> = {
  replications: "Replications",
  horizon_days: "Horizon (days)",
  warmup_days: "Warm-up (days)",
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sb = supabase as any;

export function ExperimentDesigner() {
  const { globalSelectedProjectId: projectId } = useGlobalProject();
  const { scenarios } = useScenarios(projectId);
  const { playbooks } = useRecoveryPlaybooks(projectId);
  const { experiments, create: createExperiment } = useExperiments(projectId);

  const [baseScenarioId, setBaseScenarioId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [design, setDesign] = useState<DesignType>("factorial");
  const [lhsN, setLhsN] = useState(8);
  const [selectedPlaybooks, setSelectedPlaybooks] = useState<Set<string>>(new Set());
  const [numericFactors, setNumericFactors] = useState<NumericFactorDraft[]>([]);
  const [running, setRunning] = useState(false);
  const [activeExperimentId, setActiveExperimentId] = useState<string | null>(null);

  useEffect(() => {
    if (!baseScenarioId && scenarios.length > 0) setBaseScenarioId(scenarios[0].id);
  }, [scenarios, baseScenarioId]);

  const playbookLookup = useMemo(() => new Map(playbooks.map((p) => [p.id, p])), [playbooks]);
  const baseScenario = scenarios.find((s) => s.id === baseScenarioId) ?? null;

  const factors: Factor[] = useMemo(() => {
    const out: Factor[] = [];
    if (selectedPlaybooks.size > 0) {
      out.push({
        key: PLAYBOOK_FACTOR_KEY,
        label: "Recovery playbook",
        levels: Array.from(selectedPlaybooks),
      });
    }
    for (const nf of numericFactors) {
      const levels = nf.levels
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => Number(s))
        .filter((n) => !Number.isNaN(n));
      if (levels.length > 0) {
        out.push({ key: nf.key, label: NUMERIC_FACTOR_LABELS[nf.key], levels });
      }
    }
    return out;
  }, [selectedPlaybooks, numericFactors]);

  const designRows = useMemo(() => {
    if (factors.length === 0) return [];
    return design === "factorial" ? fullFactorial(factors) : latinHypercube(factors, lhsN);
  }, [factors, design, lhsN]);

  const togglePlaybook = (id: string) => {
    setSelectedPlaybooks((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const addNumericFactor = (key: NumericFactorKey) => {
    if (numericFactors.find((f) => f.key === key)) return;
    setNumericFactors((p) => [...p, { key, levels: "" }]);
  };
  const updateNumeric = (key: NumericFactorKey, levels: string) =>
    setNumericFactors((p) => p.map((f) => (f.key === key ? { ...f, levels } : f)));
  const removeNumeric = (key: NumericFactorKey) =>
    setNumericFactors((p) => p.filter((f) => f.key !== key));

  const handleRun = async () => {
    if (!projectId || !baseScenario) {
      toast.error("Select a base scenario first.");
      return;
    }
    if (designRows.length === 0) {
      toast.error("Add at least one factor with levels.");
      return;
    }
    setRunning(true);
    try {
      // 1) Clone scenarios for every design row.
      const { id: _id, created_at: _c, updated_at: _u, ...basePayload } = baseScenario;
      const expName = name.trim() || `Experiment ${experiments.length + 1}`;
      const inserted: Array<{ id: string }> = [];
      for (const row of designRows) {
        const patch = materializeDesignRow(
          basePayload as unknown as Record<string, unknown>,
          row,
          playbookLookup,
        );
        const scenName = scenarioNameForRow(`${expName}`, row, playbookLookup);
        const { data, error } = await sb
          .from("scenarios")
          .insert({ ...patch, name: scenName })
          .select("id")
          .single();
        if (error) throw error;
        inserted.push(data as { id: string });
      }

      // 2) Persist the experiment.
      const exp = await createExperiment({
        name: expName,
        design_type: design,
        factors,
        scenario_ids: inserted.map((s) => s.id),
        status: "running",
      });

      // 3) Kick off a run per scenario.
      for (const s of inserted) {
        const { error } = await supabase.functions.invoke("sim-command", {
          body: {
            project_id: projectId,
            scenario_id: s.id,
            kind: "experiment.run",
            payload: { experiment_id: exp.id },
            client_ts: Date.now(),
          },
        });
        if (error) throw error;
      }

      toast.success(`Queued ${inserted.length} runs for "${expName}"`);
      setActiveExperimentId(exp.id);
      setName("");
    } catch (e) {
      toast.error(`Failed: ${(e as Error).message}`);
    } finally {
      setRunning(false);
    }
  };

  const activeExperiment = experiments.find((e) => e.id === activeExperimentId) ?? experiments[0] ?? null;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Beaker className="h-4 w-4 text-primary" />
            Experiment designer (DOE)
          </CardTitle>
          <CardDescription className="text-xs">
            Sweep recovery playbooks and numeric parameters across one base scenario. Each design row clones the
            scenario, applies the factor levels, and queues a simulation run.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">Experiment name</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Playbook bake-off"
                className="h-8 text-xs"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Base scenario</Label>
              <Select value={baseScenarioId ?? undefined} onValueChange={setBaseScenarioId}>
                <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Pick scenario" /></SelectTrigger>
                <SelectContent>
                  {scenarios.map((s) => (
                    <SelectItem key={s.id} value={s.id} className="text-xs">{s.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Design</Label>
              <div className="flex gap-2">
                <Select value={design} onValueChange={(v) => setDesign(v as DesignType)}>
                  <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="factorial" className="text-xs">Full factorial</SelectItem>
                    <SelectItem value="lhs" className="text-xs">Latin hypercube</SelectItem>
                  </SelectContent>
                </Select>
                {design === "lhs" && (
                  <Input
                    type="number"
                    min={2}
                    max={64}
                    value={lhsN}
                    onChange={(e) => setLhsN(Math.max(2, Number(e.target.value) || 2))}
                    className="h-8 text-xs w-16"
                  />
                )}
              </div>
            </div>
          </div>

          <Separator />

          <div>
            <Label className="text-xs mb-2 block">Recovery playbook levels</Label>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-1.5">
              {playbooks.map((p) => (
                <label
                  key={p.id}
                  className={
                    "flex items-center gap-2 text-xs border px-2 py-1.5 rounded-sm cursor-pointer transition-colors " +
                    (selectedPlaybooks.has(p.id)
                      ? "border-primary bg-primary/10"
                      : "border-border hover:border-foreground/40")
                  }
                >
                  <Checkbox
                    checked={selectedPlaybooks.has(p.id)}
                    onCheckedChange={() => togglePlaybook(p.id)}
                  />
                  <span className="min-w-0 flex-1 truncate">{p.name}</span>
                  {p.is_system && (
                    <Badge variant="outline" className="text-[9px] px-1 py-0">sys</Badge>
                  )}
                </label>
              ))}
            </div>
            {playbooks.length === 0 && (
              <p className="text-[11px] text-muted-foreground">
                No playbooks yet — save one from the Disruptions &amp; Recovery pane.
              </p>
            )}
          </div>

          <Separator />

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-xs">Numeric factors</Label>
              <Select onValueChange={(v) => addNumericFactor(v as NumericFactorKey)}>
                <SelectTrigger className="h-7 w-[160px] text-xs">
                  <span className="flex items-center gap-1"><Plus className="h-3 w-3" /> Add factor</span>
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(NUMERIC_FACTOR_LABELS) as NumericFactorKey[])
                    .filter((k) => !numericFactors.find((f) => f.key === k))
                    .map((k) => (
                      <SelectItem key={k} value={k} className="text-xs">{NUMERIC_FACTOR_LABELS[k]}</SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            {numericFactors.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">No numeric factors. Optional.</p>
            ) : (
              <div className="space-y-1.5">
                {numericFactors.map((nf) => (
                  <div key={nf.key} className="flex items-center gap-2">
                    <span className="text-xs w-32">{NUMERIC_FACTOR_LABELS[nf.key]}</span>
                    <Input
                      value={nf.levels}
                      onChange={(e) => updateNumeric(nf.key, e.target.value)}
                      placeholder="e.g. 10, 20, 30"
                      className="h-7 text-xs flex-1"
                    />
                    <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => removeNumeric(nf.key)}>
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <Separator />

          <div className="flex items-center justify-between gap-3">
            <div className="text-xs text-muted-foreground">
              Design generates{" "}
              <span className="font-mono text-foreground">{designRows.length}</span> scenario run{designRows.length === 1 ? "" : "s"}.
            </div>
            <Button size="sm" className="gap-2" disabled={running || designRows.length === 0} onClick={handleRun}>
              <Play className="h-3 w-3" />
              {running ? "Queuing…" : "Generate & run"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {experiments.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm">Experiment results</CardTitle>
              <Select
                value={activeExperiment?.id ?? undefined}
                onValueChange={setActiveExperimentId}
              >
                <SelectTrigger className="h-7 w-[260px] text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {experiments.map((e) => (
                    <SelectItem key={e.id} value={e.id} className="text-xs">
                      {e.name} · {e.scenario_ids.length} runs
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </CardHeader>
          <CardContent>
            {activeExperiment && (
              <ExperimentResultsPanel
                experiment={activeExperiment}
                playbooks={playbooks}
                primaryKpi={baseScenario?.primary_kpi ?? "fill_rate"}
              />
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
