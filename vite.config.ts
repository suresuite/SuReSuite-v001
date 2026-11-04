import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { execSync } from "child_process";

// Build-provenance marker shown in the UI so "is the new code live?" is
// answerable at a glance. Prefer Vercel's commit SHA env var, else git.
function buildSha(): string {
  const env = process.env.VERCEL_GIT_COMMIT_SHA || process.env.GITHUB_SHA;
  if (env) return env.slice(0, 7);
  try {
    return execSync("git rev-parse --short HEAD").toString().trim();
  } catch {
    return "dev";
  }
}

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  define: {
    __BUILD_SHA__: JSON.stringify(buildSha()),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString().slice(0, 16).replace("T", " ")),
  },
  // The simulation engine runs in a module Web Worker (src/lib/sim/engine.worker.ts)
  // that dynamically imports Pyodide's ESM build — so the worker bundle must be ESM.
  worker: {
    format: "es",
  },
  server: {
    host: "127.0.0.1",
    port: 8080,
  },
  plugins: [react()],
  // Production builds drop console.log/debug calls (134 in src/, 54 in the map
  // components, some inside per-node loops). warn and error are kept: those are
  // diagnostics a user can send us. `vite dev` is untouched.
  esbuild: {
    pure: mode === "production" ? ["console.log", "console.debug"] : [],
  },
  build: {
    // scripts/audit-bundle-size.mjs reads this to walk the real import graph,
    // so it can tell "a lazy chunk got bigger" (fine) from "a lazy chunk became
    // reachable from the entry" (a regression). Filenames alone can't.
    manifest: true,
  },
  // NO manualChunks here, deliberately. Routes and the two WebGL components are
  // lazy (src/App.tsx, Landing, GettingStarted, Firm/ProductLevelNetwork), and
  // Rollup's default chunking follows the real import graph — a module reached
  // only through a dynamic import lands in a chunk fetched only when that
  // import runs.
  //
  // Hand-grouping vendors fights that. Object-form `manualChunks` was tried and
  // reverted: naming `three` and `recharts` there put both chunks into the
  // ENTRY's static imports even though nothing eager imports either, adding
  // ~374 kB gzip to first paint — the exact regression this work exists to
  // remove. If vendor grouping is ever wanted for cache stability, verify with
  // `node scripts/audit-bundle-size.mjs` that the initial graph did not grow.
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  envPrefix: ["VITE_", "SUPABASE_"],
}));
