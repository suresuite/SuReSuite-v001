// ai-agents.md §25 Q0, §10 entry 38(f): Gemini 2.5 Flash and DeepSeek are
// hidden because their provider accounts are unfunded. The server refuses
// them (providers.ts HIDDEN_MODEL_IDS) and the client picker omits them
// (src/components/chat/ModelPicker.tsx CHAT_MODELS). Two authors of one list,
// so this test compares them: restoring a model in one place and not the
// other fails here, not in production.
import { assert, assertEquals } from "./harness/asserts.ts";
import { DEFAULT_MODEL_ID, HIDDEN_MODEL_IDS, isHiddenModelId, isKnownModelId, MODEL_REGISTRY } from "../providers.ts";

const PICKER = new URL("../../../../src/components/chat/ModelPicker.tsx", import.meta.url);

function pickerIds(source: string): string[] {
  const block = source.match(/export const CHAT_MODELS = \[([\s\S]*?)\] as const;/);
  assert(block, "CHAT_MODELS literal not found in ModelPicker.tsx");
  return [...block[1].matchAll(/id:\s*"([^"]+)"/g)].map((m) => m[1]);
}

Deno.test("hidden models stay in the registry (history, eval and matrix still name them) but are not served", () => {
  for (const id of HIDDEN_MODEL_IDS) {
    assert(MODEL_REGISTRY[id], `${id} is hidden but not in MODEL_REGISTRY`);
    assert(isKnownModelId(id));
    assert(isHiddenModelId(id));
  }
  assert(!isHiddenModelId(null));
  assert(!isHiddenModelId(DEFAULT_MODEL_ID), "the default model must never be hidden");
});

Deno.test("the client picker offers exactly the registry minus the hidden set", async () => {
  const ids = pickerIds(await Deno.readTextFile(PICKER));
  const served = Object.keys(MODEL_REGISTRY).filter((id) => !HIDDEN_MODEL_IDS.has(id)).sort();
  assertEquals([...ids].sort(), served);
});
