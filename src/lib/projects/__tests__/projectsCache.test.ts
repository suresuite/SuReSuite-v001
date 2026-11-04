import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
vi.mock("@/integrations/supabase/client", () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a) } }));

import { PROJECTS_TTL_MS, invalidateProjectsCache, listProjectsCached } from "../projectsCache";

const U = { id: "u1", email: "A@x.y" };
let t = 0;
const now = () => t;

beforeEach(() => {
  rpc.mockReset();
  rpc.mockResolvedValue({ data: [{ id: "p1" }], error: null });
  invalidateProjectsCache();
  t = 1_000;
});

describe("listProjectsCached", () => {
  it("answers a repeat from memory inside the TTL, and asks again after it", async () => {
    await listProjectsCached(U, { now });
    t += PROJECTS_TTL_MS - 1;
    await listProjectsCached(U, { now });
    expect(rpc).toHaveBeenCalledTimes(1);
    t += 2;
    await listProjectsCached(U, { now });
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it("sends the caller exactly as the inline calls did", async () => {
    await listProjectsCached(U, { now });
    expect(rpc).toHaveBeenCalledWith("list_projects", { p_user_id: "u1", p_user_email: "A@x.y" });
  });

  it("joins a call already in flight", async () => {
    await Promise.all([listProjectsCached(U, { now }), listProjectsCached(U, { now }), listProjectsCached(U, { now })]);
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("force reads again; invalidate drops the copy", async () => {
    await listProjectsCached(U, { now });
    await listProjectsCached(U, { now, force: true });
    expect(rpc).toHaveBeenCalledTimes(2);
    invalidateProjectsCache();
    await listProjectsCached(U, { now });
    expect(rpc).toHaveBeenCalledTimes(3);
  });

  it("never serves one person's list to another", async () => {
    await listProjectsCached(U, { now });
    await listProjectsCached({ id: "u2", email: "b@x.y" }, { now });
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it("does not cache a failure, and throws it", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: new Error("boom") });
    await expect(listProjectsCached(U, { now })).rejects.toThrow("boom");
    await expect(listProjectsCached(U, { now })).resolves.toEqual([{ id: "p1" }]);
    expect(rpc).toHaveBeenCalledTimes(2);
  });
});
