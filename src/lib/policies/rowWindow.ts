// Which rows of a long, variable-height list are worth mounting.
//
// The BOM tree on the Supplier stage can open thousands of rows, each a table row of a dozen
// or more cells. Mounting all of them is what made the grid slow on a large project; only the
// rows in (or near) the scroll viewport need to exist, with spacer rows keeping the scroll
// height. Pure, so the arithmetic is tested without a DOM.

export interface RowWindow {
  /** First row to mount. */
  first: number;
  /** One past the last row to mount. */
  last: number;
  /** Height of the rows before `first`, for the top spacer. */
  before: number;
  /** Height of the rows from `last` on, for the bottom spacer. */
  after: number;
  /** Row index at the top edge of the viewport. */
  at: number;
}

/**
 * @param heights  each row's height (an estimate is fine; it only skews the spacers)
 * @param top      scrollTop of the scroll container
 * @param viewH    its visible height
 * @param overscan rows kept mounted beyond each edge
 */
export function rowWindow(heights: ArrayLike<number>, top: number, viewH: number, overscan = 12): RowWindow {
  const n = heights.length;
  if (n === 0) return { first: 0, last: 0, before: 0, after: 0, at: 0 };
  // prefix[i] = the top edge of row i; prefix[n] = the whole height
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + heights[i];
  // the first row whose bottom edge is below `y`
  const rowAt = (y: number) => {
    let lo = 0, hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (prefix[mid + 1] <= y) lo = mid + 1; else hi = mid;
    }
    return lo;
  };
  const at = rowAt(Math.max(0, top));
  const bottom = rowAt(Math.max(0, top) + Math.max(0, viewH));
  const first = Math.max(0, at - overscan);
  const last = Math.min(n, bottom + 1 + overscan);
  return { first, last, before: prefix[first], after: prefix[n] - prefix[last], at };
}

/** The scrollTop that puts row `index` in the middle of a viewport `viewH` tall. */
export function scrollTopFor(heights: ArrayLike<number>, index: number, viewH: number): number {
  let y = 0;
  for (let i = 0; i < Math.min(index, heights.length); i++) y += heights[i];
  return Math.max(0, y - viewH / 2 + (heights[index] ?? 0) / 2);
}
