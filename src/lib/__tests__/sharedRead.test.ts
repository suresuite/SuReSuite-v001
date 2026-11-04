import { describe, expect, it, vi } from "vitest";
import { shareRead } from "../sharedRead";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("shareRead", () => {
  it("callers asking while a read runs share one request", async () => {
    const d = deferred<number>();
    const read = vi.fn(() => d.promise);
    const all = Promise.all([shareRead("a", read), shareRead("a", read), shareRead("a", read)]);
    d.resolve(7);
    expect(await all).toEqual([7, 7, 7]);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("remembers nothing once the read has settled", async () => {
    const read = vi.fn(async () => 1);
    await shareRead("b", read);
    await shareRead("b", read);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("different keys never share", async () => {
    const read = vi.fn(async () => 1);
    await Promise.all([shareRead("c1", read), shareRead("c2", read)]);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("fresh starts a new read, which later callers then join", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const r1 = shareRead("d", () => first.promise);
    const r2 = shareRead("d", () => second.promise, true); // after a write
    const r3 = shareRead("d", () => { throw new Error("must join r2"); });
    second.resolve("post-write");
    first.resolve("pre-write");
    expect(await r1).toBe("pre-write");
    expect(await r2).toBe("post-write");
    expect(await r3).toBe("post-write");
  });

  it("a failure reaches every sharer and does not stick", async () => {
    const d = deferred<number>();
    const a = shareRead("e", () => d.promise);
    const b = shareRead("e", () => d.promise);
    d.reject(new Error("boom"));
    await expect(a).rejects.toThrow("boom");
    await expect(b).rejects.toThrow("boom");
    await expect(shareRead("e", async () => 5)).resolves.toBe(5);
  });
});
