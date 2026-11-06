// What an edge function actually said when it refused.
//
// `supabase.functions.invoke` turns every non-2xx response into an error whose message is the
// fixed sentence "Edge Function returned a non-2xx status code", and keeps the real response
// on `error.context`. The upload paths showed only that sentence, so a person staring at it
// could not tell a file the server rejected (400, with a reason) from a server that fell
// over (500) or a function that is not deployed (404). This reads the response so the
// reason reaches the screen, with the HTTP status beside it.
export async function edgeErrorMessage(error: unknown, fallback: string): Promise<string> {
  const ctx = (error as { context?: unknown } | null)?.context as Response | undefined;
  if (ctx && typeof ctx.text === "function") {
    try {
      const text = await (typeof ctx.clone === "function" ? ctx.clone() : ctx).text();
      let reason = "";
      try {
        const body = JSON.parse(text) as {
          error?: unknown;
          message?: unknown;
          findings?: Array<{ message?: string; level?: string }>;
        };
        const findings = (body.findings ?? [])
          .filter((f) => !f.level || f.level === "error")
          .map((f) => f.message)
          .filter(Boolean)
          .slice(0, 5)
          .join("\n");
        reason = String(body.error ?? body.message ?? findings ?? "");
        if (!reason) reason = findings;
      } catch {
        reason = text.slice(0, 300);
      }
      const status = typeof ctx.status === "number" ? ` (HTTP ${ctx.status})` : "";
      if (reason.trim()) return `${reason.trim()}${status}`;
      if (status) return `${fallback}${status}`;
    } catch {
      /* the body could not be read: fall through to the plain message */
    }
  }
  const m = error instanceof Error ? error.message : "";
  return m || fallback;
}
