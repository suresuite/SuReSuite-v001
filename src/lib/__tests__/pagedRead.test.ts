import { describe, expect, it, vi } from "vitest";
import { readAllPages } from "../pagedRead";

/** A fake RPC over `total` rows 0..total-1, in order, that records every call. */
function source(total: number, opts: { failAt?: number } = {}) {
  const calls: number[] = [];
  let inFlight = 0;
  let peak = 0;
  const read = vi.fn(async (offset: number, limit: number) => {
    calls.push(offset);
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 2));
    inFlight--;
    if (opts.failAt !== undefined && offset === opts.failAt) return { data: null, error: new Error("boom") };
    const n = Math.max(0, Math.min(limit, total - offset));
    return { data: Array.from({ length: n }, (_, i) => offset + i), error: null };
  });
  return { read, calls, peak: () => peak };
}

describe("readAllPages", () => {
  it("returns every row in order, whatever the total", async () => {
    for (const total of [0, 1, 999, 1000, 1001, 2500, 4000, 4001, 9999]) {
      const s = source(total);
      const { rows, error, capped } = await readAllPages(s.read, { pageSize: 1000 });
      expect(error).toBeNull();
      expect(capped).toBe(false);
      expect(rows).toEqual(Array.from({ length: total }, (_, i) => i));
    }
  });

  it("a project that fits in one page asks once", async () => {
    const s = source(400);
    await readAllPages(s.read);
    expect(s.read).toHaveBeenCalledTimes(1);
  });

  it("reads the later pages together, not one after another", async () => {
    const s = source(9000);
    await readAllPages(s.read, { concurrency: 4 });
    expect(s.peak()).toBe(4);
    // 9 full pages + the empty one that ends it = 10 needed; the last batch may
    // overshoot by fewer than `concurrency` pages
    expect(s.read.mock.calls.length).toBeLessThanOrEqual(10 + 3);
  });

  it("never asks for more than concurrency − 1 pages past the end", async () => {
    const s = source(1500); // pages 0 and 1 exist; page 1 is short
    await readAllPages(s.read, { concurrency: 4 });
    expect(s.read.mock.calls.length).toBeLessThanOrEqual(1 + 4);
  });

  it("the first error ends the read with no rows — a partial graph is not returned", async () => {
    const s = source(9000, { failAt: 3000 });
    const { rows, error } = await readAllPages(s.read);
    expect(error).toBeInstanceOf(Error);
    expect(rows).toEqual([]);
  });

  it("stops at maxPages and says so", async () => {
    const s = source(100000);
    const { rows, capped } = await readAllPages(s.read, { maxPages: 6, concurrency: 4 });
    expect(capped).toBe(true);
    expect(rows).toHaveLength(6000);
    expect(s.read.mock.calls.length).toBe(6);
  });

  it("is identical to a sequential read", async () => {
    const seq: number[] = [];
    const s = source(3456);
    for (let off = 0; ; off += 1000) {
      const { data } = await s.read(off, 1000);
      seq.push(...(data ?? []));
      if ((data ?? []).length < 1000) break;
    }
    const par = await readAllPages(source(3456).read);
    expect(par.rows).toEqual(seq);
  });
});
