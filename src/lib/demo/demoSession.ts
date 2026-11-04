// The demo session: how a visitor with no account opens the demo pages.
//
// The app authenticates against `approved_users`, and every read the pages make NAMES
// a user (`list_projects(p_user_id, …)`, `get_network_nodes(…)`). So an anonymous demo
// is not a page without sign-in; it is a session whose user is a dedicated, read-only
// demo account, in an organization that holds only the demo project.
//
// WHAT THIS MODULE IS AND IS NOT. It is the client's side of that arrangement: who the
// demo user is, whether a session is on, which pages it may open. It is NOT a security
// boundary, and nothing below pretends to be. The account's id ships in the bundle, so
// anyone may call the database as it; what stops that doing harm is the account itself
// — a role with no write capability, a Viewer on the one demo project, an organization
// with nothing else in it (scripts/demo_project/README.md). The route allow-list here
// keeps an honest visitor on the demo pages; the database keeps a dishonest one out.
//
// OFF UNLESS CONFIGURED. `VITE_DEMO_GUEST_ID` and `VITE_DEMO_GUEST_EMAIL` name the
// account (both identifiers, neither secret). With either missing or malformed there is
// no demo: `/demo` says so and nothing else changes.

/** The only pages a demo session may open. Every one is READ-ONLY for the demo account:
 *  the three network lenses, the policies and the lab (it is a Viewer on the one demo
 *  project, so saving, creating and running are refused), and the Developer API page
 *  without its API keys. */
export const DEMO_PATHS = [
  "/network/product-level",
  "/network/process-level",
  "/network/firm-level",
  "/policies",
  "/simulation-lab",
  "/developer",
] as const;

export const DEMO_HOME = DEMO_PATHS[0];

const FLAG = "suresuite_demo_session";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface DemoIdentity {
  id: string;
  email: string;
}

/** The configured demo account, or null when the demo is not set up. */
export function demoIdentity(
  env: Record<string, string | undefined> = import.meta.env,
): DemoIdentity | null {
  const id = (env.VITE_DEMO_GUEST_ID ?? "").trim();
  const email = (env.VITE_DEMO_GUEST_EMAIL ?? "").trim().toLowerCase();
  if (!UUID.test(id) || !email.includes("@")) return null;
  return { id: id.toLowerCase(), email };
}

export function demoConfigured(env?: Record<string, string | undefined>): boolean {
  return demoIdentity(env) !== null;
}

// sessionStorage, not localStorage: a demo ends with its tab and never outlives into a
// later real sign-in on the same browser. Every access is guarded — storage can throw
// (private windows, blocked site data) and a demo that cannot persist is simply off.
export function isDemoSession(
  env?: Record<string, string | undefined>,
  storage: Pick<Storage, "getItem"> | null = safeStorage(),
): boolean {
  if (!demoConfigured(env)) return false;
  try {
    return storage?.getItem(FLAG) === "1";
  } catch {
    return false;
  }
}

export function startDemoSession(storage: Pick<Storage, "setItem"> | null = safeStorage()): void {
  try {
    storage?.setItem(FLAG, "1");
  } catch {
    /* nothing to persist to: the demo stays off */
  }
}

export function endDemoSession(storage: Pick<Storage, "removeItem"> | null = safeStorage()): void {
  try {
    storage?.removeItem(FLAG);
  } catch {
    /* already gone */
  }
}

/** Is this route one a demo session may open? */
export function demoPathAllowed(pathname: string): boolean {
  return (DEMO_PATHS as readonly string[]).includes(pathname.replace(/\/+$/, "") || "/");
}

/** The synthetic account the pages see as `useAuth().user` during a demo. Never stored. */
export function demoGuestUser(id: DemoIdentity) {
  return {
    id: id.id,
    name: "Demo guest",
    email: id.email,
    role: "user",
    organization: "",
    is_active: true,
    force_password_change: false,
  };
}

function safeStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}
