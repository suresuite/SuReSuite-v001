// Read a paged RPC to the end, several pages at a time.
//
// The deep-tier reads asked for 1000 rows, waited, asked for the next 1000, and so on,
// so a project with N thousand rows paid N round trips in a row. The database offers no
// row count to plan from, so this reads the first page alone (most projects end there),
// and only when it comes back full asks for the next `concurrency` pages together.
//
// RULES IT KEEPS
//   - Same rows, same order as the sequential loop: pages are joined by offset, and the
//     read stops at the first short or empty page. Pages fetched beyond that point (at
//     most `concurrency - 1`) are discarded — the price of not knowing the total.
//   - Paging by OFFSET is only sound over a total order; `get_supply_chain_data_multi_tier`
//     orders by (bom_depth, created_at, id).
//   - The first page that errors ends the read and the error is RETURNED with no rows:
//     a partial graph must not pass for a whole one.
//   - `maxPages` is a ceiling on pages ASKED for, as in the loops it replaces; hitting it
//     is reported (`capped`) so a caller can say the read was cut short.
export interface PageResult<T> {
  data: T[] | null;
  error: unknown | null;
}

export interface PagedReadResult<T> {
  rows: T[];
  error: unknown | null;
  /** The read stopped at `maxPages` with every page full: more rows may exist. */
  capped: boolean;
}

export async function readAllPages<T>(
  readPage: (offset: number, limit: number) => PromiseLike<PageResult<T>>,
  opts: { pageSize?: number; maxPages?: number; concurrency?: number } = {},
): Promise<PagedReadResult<T>> {
  const pageSize = opts.pageSize ?? 1000;
  const maxPages = opts.maxPages ?? 50;
  const concurrency = Math.max(1, opts.concurrency ?? 4);

  const rows: T[] = [];
  let next = 0; // index of the next page to ask for
  let first = true;

  while (next < maxPages) {
    // The first page goes alone: a project that fits in one never asks for more.
    const count = first ? 1 : Math.min(concurrency, maxPages - next);
    first = false;
    const batch = await Promise.all(
      Array.from({ length: count }, (_, i) =>
        Promise.resolve(readPage((next + i) * pageSize, pageSize)),
      ),
    );
    for (const page of batch) {
      if (page.error) return { rows: [], error: page.error, capped: false };
      const got = page.data ?? [];
      rows.push(...got);
      if (got.length < pageSize) return { rows, error: null, capped: false };
    }
    next += count;
  }
  return { rows, error: null, capped: true };
}
