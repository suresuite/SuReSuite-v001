// The assistant's platform knowledge (ai-agents.md §26 WP M.4) — GENERATED.
//
// "What is TTR?", "what does P-P.1 do?", "how do I add a scenario?" were
// answered from the model's general training: the manual, the engine
// reference and the policy registry were not retrievable from the chat. This
// renders every live /docs page the way the docs index does (rendered text,
// never typed), splits it at its `Section` headings, adds the engine's KPI
// definitions and the policy catalog from the registry export, and writes ONE
// committed artifact the edge function searches. Committed so the check has
// something to fail against (the `contract:generate -- --check` shape).
//
//   npm run knowledge:generate   rewrite supabase/functions/project-ai-chat/knowledge.generated.json

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router-dom/server";
import { DOC_BODIES } from "../bodies";
import { ALL_PAGES } from "../registry";
import registry from "@/lib/policies/registry.generated.json";

const OUT = "supabase/functions/project-ai-chat/knowledge.generated.json";
const MAX_TEXT = 1400;

const decode = (s: string) =>
  s.replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&nbsp;/g, " ");
const text = (html: string) =>
  decode(html.replace(/<svg[\s\S]*?<\/svg>/g, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
const clip = (s: string) => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT - 1)}…` : s);

export interface KnowledgeEntry {
  id: string;
  source: "docs" | "engine" | "policy";
  title: string;
  /** Where a user reads it: an app route, or the repository path. */
  ref: string;
  text: string;
}

function build(): KnowledgeEntry[] {
  const out: KnowledgeEntry[] = [];
  for (const page of ALL_PAGES) {
    const Body = DOC_BODIES[page.slug];
    if (page.status !== "live" || !Body) continue;
    const html = renderToStaticMarkup(
      createElement(StaticRouter, { location: `/docs/${page.slug}` }, createElement(Body)),
    );
    const parts = html.split(/(?=<h2 id=")/);
    const intro = text(parts[0] ?? "");
    if (intro) out.push({ id: `docs/${page.slug}`, source: "docs", title: page.title, ref: `/docs/${page.slug}`, text: clip(intro) });
    for (const part of parts.slice(1)) {
      const m = part.match(/^<h2 id="([^"]+)"[^>]*>([\s\S]*?)<\/h2>/);
      if (!m) continue;
      const body = text(part.slice(m[0].length));
      if (!body) continue;
      out.push({
        id: `docs/${page.slug}#${m[1]}`,
        source: "docs",
        title: `${page.title} — ${text(m[2])}`,
        ref: `/docs/${page.slug}#${m[1]}`,
        text: clip(body),
      });
    }
  }
  const reg = registry as unknown as {
    kpis: Array<{ name: string; symbol?: string; unit?: string; definition: string }>;
    policies: Array<{ id: string; catalog_ref?: string; summary?: string; stage?: string; status?: string }>;
  };
  for (const k of reg.kpis ?? []) {
    out.push({
      id: `engine/kpi/${k.name}`,
      source: "engine",
      title: `KPI ${k.name}${k.symbol ? ` (${k.symbol})` : ""}`,
      ref: "scsim/docs/reference/kpis.md",
      text: clip(`${k.name}${k.unit ? ` [${k.unit}]` : ""}: ${k.definition}`),
    });
  }
  for (const p of reg.policies ?? []) {
    if (!p.summary) continue;
    out.push({
      id: `policy/${p.id}`,
      source: "policy",
      title: `Policy ${p.catalog_ref ?? ""} ${p.id}`.replace(/\s+/g, " ").trim(),
      ref: "/policies",
      text: clip(`${p.catalog_ref ?? p.id} (${p.stage ?? "?"} stage, ${p.status ?? "?"}): ${p.summary}`),
    });
  }
  // The engine's prose reference (architecture, extending, KPIs), by heading.
  for (const file of readdirSync("scsim/docs").filter((f) => f.endsWith(".md") && !/changelog|roadmap/i.test(f))) {
    const md = readFileSync(`scsim/docs/${file}`, "utf8");
    for (const sec of md.split(/\n(?=## )/)) {
      const head = sec.match(/^##\s+(.+)/);
      if (!head) continue;
      const body = sec.slice(head[0].length).replace(/```[\s\S]*?```/g, " ").replace(/[#*`|>-]+/g, " ").replace(/\s+/g, " ").trim();
      if (body.length < 80) continue;
      const slug = head[1].toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      out.push({ id: `engine/${file}#${slug}`, source: "engine", title: `Engine — ${head[1].trim()}`, ref: `scsim/docs/${file}`, text: clip(body) });
    }
  }
  return out;
}

const serialise = (entries: KnowledgeEntry[]) => `${JSON.stringify({ _generated_by: "src/components/docs/__tests__/platformKnowledge.test.tsx — do not edit; npm run knowledge:generate", entries }, null, 1)}\n`;

describe("the assistant's platform knowledge (§26 WP M.4)", () => {
  const entries = build();

  it("matches the committed artifact — run `npm run knowledge:generate` if this fails", () => {
    if (process.env.KNOWLEDGE_WRITE) writeFileSync(OUT, serialise(entries));
    expect(readFileSync(OUT, "utf8")).toBe(serialise(entries));
  });

  it("covers every live docs page, every KPI and every implemented policy with a summary", () => {
    const live = ALL_PAGES.filter((p) => p.status === "live" && DOC_BODIES[p.slug]).map((p) => p.slug);
    for (const slug of live) expect(entries.some((e) => e.ref.startsWith(`/docs/${slug}`)), slug).toBe(true);
    const reg = registry as unknown as { kpis: Array<{ name: string }> };
    for (const k of reg.kpis) expect(entries.some((e) => e.id === `engine/kpi/${k.name}`), k.name).toBe(true);
  });

  it("never repeats an id — the id is the citation", () => {
    const ids = entries.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
