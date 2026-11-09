import { describe, expect, it } from "vitest";
import { rowWindow, scrollTopFor } from "../rowWindow";

const flat = (n: number, h = 30) => Array.from({ length: n }, () => h);

describe("rowWindow", () => {
  it("mounts only the viewport and a margin of a long list", () => {
    const w = rowWindow(flat(10_000), 0, 600, 12);
    expect(w.first).toBe(0);
    expect(w.last).toBe(20 + 1 + 12); // 600 / 30 rows in view, plus the margin
    expect(w.before).toBe(0);
    expect(w.after).toBe((10_000 - w.last) * 30);
  });
  it("follows the scroll position", () => {
    const w = rowWindow(flat(10_000), 30 * 5000, 600, 12);
    expect(w.at).toBe(5000);
    expect(w.first).toBe(4988);
    expect(w.before).toBe(4988 * 30);
    expect(w.before + (w.last - w.first) * 30 + w.after).toBe(10_000 * 30); // the scroll height never changes
  });
  it("keeps the total height when rows differ in height", () => {
    const h = Array.from({ length: 500 }, (_, i) => (i % 7 === 0 ? 120 : 30));
    const total = h.reduce((a, b) => a + b, 0);
    for (const top of [0, 900, 7000, 14_000]) {
      const w = rowWindow(h, top, 700);
      const mounted = h.slice(w.first, w.last).reduce((a, b) => a + b, 0);
      expect(w.before + mounted + w.after).toBe(total);
      // the row at the top edge is mounted
      expect(w.first).toBeLessThanOrEqual(w.at);
      expect(w.last).toBeGreaterThan(w.at);
    }
  });
  it("copes with a scroll past the end, an empty list and a short one", () => {
    expect(rowWindow([], 0, 600)).toEqual({ first: 0, last: 0, before: 0, after: 0, at: 0 });
    const end = rowWindow(flat(100), 1e9, 600);
    expect(end.last).toBe(100);
    expect(end.after).toBe(0);
    const short = rowWindow(flat(5), 0, 600);
    expect([short.first, short.last, short.before, short.after]).toEqual([0, 5, 0, 0]);
  });
});

describe("scrollTopFor", () => {
  it("centres a row, and never goes above the top", () => {
    expect(scrollTopFor(flat(1000), 500, 600)).toBe(500 * 30 - 300 + 15);
    expect(scrollTopFor(flat(1000), 2, 600)).toBe(0);
  });
});
