import { useEffect, useState } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useCapabilities } from "@/hooks/useCapabilities";
import { supabase } from "@/integrations/supabase/client";
import {
  modelMatrixEnabled,
  summarizeModelMatrix,
  type ModelCapabilityRow,
} from "@/lib/modelMatrix";

// The models a user can PICK. Gemini 2.5 Flash and DeepSeek are hidden
// (ai-agents.md §25 Q0, §10 entry 38(f)): their provider accounts are out of
// quota / balance, so every turn on them failed with a provider error. They
// stay in the server MODEL_REGISTRY (history, eval, matrix) and are refused
// there with a clear message (providers.ts HIDDEN_MODEL_IDS). A preference
// saved for a hidden model falls back to the default via getStoredModel().
// To restore one: fund its account, pass the Q4 live eval, add it back here
// and remove it from HIDDEN_MODEL_IDS in the same change.
export const CHAT_MODELS = [
  { id: "gpt-5", label: "GPT-5" },
  { id: "gpt-5-mini", label: "GPT-5 mini" },
] as const;

// Labels for every model a past turn may name, hidden ones included, so an
// old thread still says "Gemini 2.5 Flash" rather than a raw id.
const MODEL_LABELS: Record<string, string> = {
  "gemini-2.5-flash": "Gemini 2.5 Flash",
  "deepseek-chat": "DeepSeek",
  ...Object.fromEntries(CHAT_MODELS.map((m) => [m.id, m.label])),
};

// Mirrors providers.ts DEFAULT_MODEL_ID — keep the two in sync.
export const DEFAULT_MODEL_ID = "gpt-5";

export function getStoredModel(): string {
  if (typeof window === "undefined") return DEFAULT_MODEL_ID;
  const v = window.localStorage.getItem("projectChat.model");
  return v && CHAT_MODELS.some((m) => m.id === v) ? v : DEFAULT_MODEL_ID;
}

export function setStoredModel(id: string) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem("projectChat.model", id);
}

export function getModelLabel(id: string): string {
  return MODEL_LABELS[id] ?? id;
}

/** H4 (ai-agents.md §23.3): the per-model capability rows from
 * get_model_capability_matrix(). Flag off, RPC missing, or an empty matrix
 * all yield [] — the picker renders exactly as it did before H4. */
function useModelMatrix(): ModelCapabilityRow[] {
  const [rows, setRows] = useState<ModelCapabilityRow[]>([]);
  useEffect(() => {
    if (!modelMatrixEnabled()) return;
    let cancelled = false;
    (async () => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data, error } = await (supabase as any).rpc("get_model_capability_matrix");
        if (!cancelled && !error && Array.isArray(data)) setRows(data as ModelCapabilityRow[]);
      } catch {
        /* quality metadata only — the picker works without it */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return rows;
}

interface Props {
  value: string;
  onChange: (id: string) => void;
  className?: string;
}

export function ModelPicker({ value, onChange, className }: Props) {
  const { isModelAllowed } = useCapabilities();
  const matrix = useModelMatrix();
  // Only surface models this user is permitted to call. Keep the current value
  // visible even if disallowed, so the trigger never renders blank (the send
  // path blocks a disallowed model with a clear reason). The capability hints
  // below NEVER hide a model (§23.3 — the allowlist owns that); they inform
  // the choice.
  const visible = CHAT_MODELS.filter((m) => isModelAllowed(m.id).ok || m.id === value);
  const options = visible.length > 0 ? visible : CHAT_MODELS;
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger
        className={`h-8 min-h-11 w-auto gap-1 md:min-h-0 rounded-md border-border bg-transparent px-2 text-[12px] font-medium text-muted-foreground shadow-none hover:bg-muted hover:text-foreground focus:ring-0 ${className ?? ""}`}
      >
        {/* Explicit children so the trigger shows the label only — the item
            rows below may carry a second hint line (§23.3). */}
        <SelectValue>{getModelLabel(value)}</SelectValue>
      </SelectTrigger>
      <SelectContent align="end" className="z-[110] min-w-[200px]">
        {options.map((m) => {
          const hint = summarizeModelMatrix(matrix, m.id);
          return (
            <SelectItem key={m.id} value={m.id} className="text-[13px]">
              {m.label}
              {hint && (
                <span className="mt-0.5 block text-[11px] font-normal leading-tight text-muted-foreground">
                  {hint.summary}
                  {hint.stale && <span className="ml-1 text-amber-600">· matrix stale</span>}
                </span>
              )}
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}
