import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
vi.mock("@/integrations/supabase/client", () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a) } }));

import { fetchProjectLanes } from "../projectLanes";

const U = { id: "u1", email: "a@x.y" };
const DS = { inbound: [{ id: 1 }], outbound: [{ id: 2 }], bom_level: "single", bom: [{ id: 3 }] };

beforeEach(() => {
  rpc.mockReset();
  rpc.mockImplementation(async () => {
    await new Promise((r) => setTimeout(r, 5));
    return { data: DS, error: null };
  });
});

describe("fetchProjectLanes — six hooks, one request", () => {
  it("callers mounting together share a single get_project_datasets call", async () => {
    const got = await Promise.all([1, 2, 3, 4, 5, 6].map(() => fetchProjectLanes("p1", U)));
    expect(rpc).toHaveBeenCalledTimes(1);
    for (const l of got) expect(l.inbound).toEqual([{ id: 1 }]);
  });

  it("each caller gets its own arrays, so one cannot reorder another's", async () => {
    const [a, b] = await Promise.all([fetchProjectLanes("p1", U), fetchProjectLanes("p1", U)]);
    expect(a.inbound).not.toBe(b.inbound);
    a.inbound.push({ id: 99 });
    expect(b.inbound).toHaveLength(1);
  });

  it("a later call reads again, and fresh never joins a read that predates a write", async () => {
    await fetchProjectLanes("p1", U);
    await fetchProjectLanes("p1", U);
    expect(rpc).toHaveBeenCalledTimes(2);
    rpc.mockClear();
    const running = fetchProjectLanes("p1", U);
    const afterWrite = fetchProjectLanes("p1", U, { fresh: true });
    await Promise.all([running, afterWrite]);
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it("another project or another person never shares", async () => {
    await Promise.all([
      fetchProjectLanes("p1", U),
      fetchProjectLanes("p2", U),
      fetchProjectLanes("p1", { id: "u2", email: "b@x.y" }),
    ]);
    expect(rpc).toHaveBeenCalledTimes(3);
  });
});
