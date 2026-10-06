export const DAY = 86_400_000;
export const dayStart = time => Math.floor((time - 3 * 3_600_000) / DAY) * DAY + 3 * 3_600_000;
export const day = time => new Date(time - 3 * 3_600_000).toISOString().slice(0, 10);
export function covers(windows, start, end) {
  if (start >= end) return false;
  let cursor = start;
  for (const range of windows) {
    if (range[1] <= cursor) continue;
    if (range[0] > cursor) return false;
    cursor = Math.max(cursor, range[1]);
    if (cursor >= end) return true;
  }
  return false;
}
export function orderHistoryWindows(coverage, storeId) {
  const complete = coverage.filter(row => row.storeId === storeId && row.source === 'orders' && row.status === 'api-pages-complete');
  const ranges = basis => complete.filter(row => row.dateBasis === basis).map(row => [Date.parse(row.from),Date.parse(row.to)])
    .filter(([from,to]) => Number.isFinite(from) && Number.isFinite(to) && from < to).sort((a,b) => a[0]-b[0]);
  const windows = ranges('created');
  if (windows.length) {
    const baseline = Math.max(...windows.map(range => range[1]));
    let tail = baseline;
    // Updates extend a complete baseline; they cannot establish older missing history.
    for (const [from,to] of ranges('updated')) if (from <= tail) tail = Math.max(tail,to);
    if (tail > baseline) windows.push([baseline,tail]);
  }
  return windows;
}
