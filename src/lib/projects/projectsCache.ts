// One `list_projects` read per user per half-minute, shared by every page.
//
// Before this, each of the three network lenses, Policies, the Lab, Project
// Intelligence and the chat bubble issued its own `list_projects` call on mount, so
// moving between pages repeated the same round trip. This module answers a repeat
// from memory and joins a call already in flight.
//
// WHAT IT IS NOT. It is not the source of truth and it is not a store: it holds the
// RPC's answer for `TTL_MS`, keyed by the caller, and forgets it on `invalidate`.
//   - A failed read is never cached; the error reaches the caller's own catch.
//   - The pages that CHANGE projects (/project-manager, /admin/projects) read with
//     `force` and invalidate when they unmount, so the next page sees their writes.
//   - A change made in another tab is seen after at most `TTL_MS`.
// The key includes the user id and email, so a different sign-in never sees another
// person's list.
import { supabase } from "@/integrations/supabase/client";

export const PROJECTS_TTL_MS = 30_000;

export interface ProjectsCaller {
  id: string;
  email?: string | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;
interface Entry {
  key: string;
  at: number;
  data?: Row[];
  pending?: Promise<Row[]>;
}

let entry: Entry | null = null;

const keyOf = (u: ProjectsCaller) => `${u.id}|${(u.email ?? "").toLowerCase()}`;

export function invalidateProjectsCache(): void {
  entry = null;
}

/** The caller's projects. `force` skips a fresh answer (and replaces it). Throws the
 *  RPC's error, as the inline calls it replaces did. */
export async function listProjectsCached(
  user: ProjectsCaller,
  opts: { force?: boolean; now?: () => number } = {},
): Promise<Row[]> {
  const now = opts.now ?? Date.now;
  const key = keyOf(user);
  const e = entry;
  if (e && e.key === key && !opts.force) {
    // Join a read already in flight; a forced read must not (it may predate a write).
    if (e.pending) return e.pending;
    if (e.data && now() - e.at < PROJECTS_TTL_MS) return e.data;
  }
  const mine: Entry = { key, at: now() };
  mine.pending = (async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabase as any).rpc("list_projects", {
      p_user_id: user.id,
      p_user_email: user.email ?? null,
    });
    if (error) throw error;
    return (data as Row[]) ?? [];
  })();
  entry = mine;
  try {
    mine.data = await mine.pending;
    mine.at = now();
    return mine.data;
  } catch (err) {
    if (entry === mine) entry = null; // never cache a failure
    throw err;
  } finally {
    mine.pending = undefined;
  }
}
