// The disruption a follow-up refers to (§26 M2/M5): "how do I mitigate it?"
// names no supplier — its subject is the last disruption the user asked
// about. Read from the CURRENT message first, then earlier user messages
// (newest first). The user's own words only; never an assistant turn.

import { parseWhatIf, type WhatIfAsk } from "../whatIf.ts";
import { previousUserMessages, type SkillInput } from "./common.ts";

export function disruptionSubject(input: SkillInput): { ask: WhatIfAsk; from: "message" | "history"; text: string } | null {
  const here = parseWhatIf(input.utterance, { requireQuestion: false });
  if (here) return { ask: here, from: "message", text: input.utterance };
  for (const m of previousUserMessages(input.history)) {
    const prior = parseWhatIf(m, { requireQuestion: false });
    if (prior) return { ask: prior, from: "history", text: m };
  }
  return null;
}
