import { describe, expect, it } from "vitest";
import {
  DEMO_HOME,
  DEMO_PATHS,
  demoConfigured,
  demoGuestUser,
  demoIdentity,
  demoPathAllowed,
  demoSessionMode,
  endDemoSession,
  isDemoSession,
  startDemoSession,
} from "../demoSession";

const ID = "55ba1d37-7b64-41f4-a288-187099ea75ec";
const ENV = { VITE_DEMO_GUEST_ID: ID, VITE_DEMO_GUEST_EMAIL: "SuperUser3+demo-guest@suresuite.com" };

function memoryStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

describe("demoIdentity — off unless both values are present and well formed", () => {
  it("reads the account, lower-casing the email the way the database stores it", () => {
    expect(demoIdentity(ENV)).toEqual({ id: ID, email: "superuser3+demo-guest@suresuite.com" });
  });

  it.each([
    ["no id", { VITE_DEMO_GUEST_EMAIL: "a@b.c" }],
    ["no email", { VITE_DEMO_GUEST_ID: ID }],
    ["id is not a uuid", { VITE_DEMO_GUEST_ID: "123", VITE_DEMO_GUEST_EMAIL: "a@b.c" }],
    ["email has no @", { VITE_DEMO_GUEST_ID: ID, VITE_DEMO_GUEST_EMAIL: "guest" }],
    ["both blank", { VITE_DEMO_GUEST_ID: " ", VITE_DEMO_GUEST_EMAIL: " " }],
    ["nothing", {}],
  ])("is not configured when %s", (_why, env) => {
    expect(demoIdentity(env)).toBeNull();
    expect(demoConfigured(env)).toBe(false);
  });
});

describe("the session flag", () => {
  it("starts, reads back and ends", () => {
    const s = memoryStorage();
    expect(isDemoSession(ENV, s)).toBe(false);
    startDemoSession("visitor", s);
    expect(isDemoSession(ENV, s)).toBe(true);
    endDemoSession(s);
    expect(isDemoSession(ENV, s)).toBe(false);
  });

  it("records whether it is a visitor's demo or a signed-in person's preview", () => {
    const s = memoryStorage();
    expect(demoSessionMode(ENV, s)).toBeNull();
    startDemoSession("visitor", s);
    expect(demoSessionMode(ENV, s)).toBe("visitor");
    startDemoSession("preview", s);
    expect(demoSessionMode(ENV, s)).toBe("preview");
    expect(isDemoSession(ENV, s)).toBe(true);
    endDemoSession(s);
    expect(demoSessionMode(ENV, s)).toBeNull();
  });

  it("ignores a flag value it does not know", () => {
    const s = memoryStorage();
    s.setItem("suresuite_demo_session", "maybe");
    expect(demoSessionMode(ENV, s)).toBeNull();
  });

  it("is never on when the demo is not configured, whatever storage says", () => {
    const s = memoryStorage();
    startDemoSession('visitor', s);
    expect(isDemoSession({}, s)).toBe(false);
  });

  it("survives storage that throws, and with no storage at all", () => {
    const broken = {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
      removeItem: () => { throw new Error("blocked"); },
    };
    expect(isDemoSession(ENV, broken)).toBe(false);
    expect(() => startDemoSession('visitor', broken)).not.toThrow();
    expect(() => endDemoSession(broken)).not.toThrow();
    expect(isDemoSession(ENV, null)).toBe(false);
  });
});

describe("the route allow-list", () => {
  it("admits exactly the six demo pages", () => {
    for (const p of DEMO_PATHS) expect(demoPathAllowed(p)).toBe(true);
    expect(DEMO_PATHS).toHaveLength(6);
    expect(DEMO_PATHS).toEqual(expect.arrayContaining(["/policies", "/simulation-lab", "/developer"]));
    expect(demoPathAllowed(DEMO_HOME)).toBe(true);
  });

  it("tolerates a trailing slash and nothing else", () => {
    expect(demoPathAllowed("/network/firm-level/")).toBe(true);
    for (const p of [
      "/", "/project-manager", "/admin", "/admin/users", "/profile", "/project-intelligence",
      "/network/interactive-space", "/network/firm-level/x", "/network", "/policies/x", "/developer/keys",
    ]) {
      expect(demoPathAllowed(p), p).toBe(false);
    }
  });
});

describe("the synthetic user", () => {
  it("is an ordinary `user` account that has nothing to change", () => {
    const u = demoGuestUser({ id: ID, email: "g@x.y" });
    expect(u).toMatchObject({ id: ID, email: "g@x.y", role: "user", force_password_change: false });
  });
});
