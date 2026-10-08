// Read retries are bounded and never replay edits, confirmations or imports.
export async function fetchReadWithRetry(path, options = {}, { fetchImpl = fetch, pause = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const canRetry = (options.method || 'GET').toUpperCase() === 'GET';
  for (let attempt = 0; ; attempt++) {
    options.signal?.throwIfAborted();
    let response;
    try { response = await fetchImpl(path, options); }
    catch (error) {
      if (!canRetry || attempt >= 2 || error.name === 'AbortError' || options.signal?.aborted) throw error;
    }
    if (response && (!canRetry || attempt >= 2 || ![502,503,504].includes(response.status))) return response;
    await response?.body?.cancel();
    await waitForRetry(pause, attempt === 0 ? 400 : 1200, options.signal);
  }
}

// Navigation cancels reads only. Saving an edit keeps its own request lifecycle.
export function createReadScope(api) {
  const controller = new AbortController();
  return {
    cancel: () => controller.abort(),
    api(path, options = {}) {
      if ((options.method || 'GET').toUpperCase() !== 'GET') return api(path, options);
      controller.signal.throwIfAborted();
      const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
      return api(path, { ...options, signal });
    },
  };
}

async function waitForRetry(pause, milliseconds, signal) {
  signal?.throwIfAborted();
  if (!signal) return pause(milliseconds);
  let onAbort;
  try {
    await Promise.race([
      pause(milliseconds),
      new Promise((_, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
    signal.throwIfAborted();
  } finally { signal.removeEventListener('abort', onAbort); }
}

// One visible page is enough to start working. Totals still describe the full
// filtered result; when saving empties the last page, move to the last valid page.
export async function loadRecordPage(api, path, filters, { page = 0, pageSize = 100, isCurrent = () => true } = {}) {
  const params = new URLSearchParams(filters);
  const read = async index => {
    params.set('limit', String(pageSize)); params.set('offset', String(index * pageSize));
    return api(`${path}?${params}`);
  };
  if (!isCurrent()) return null;
  let data = await read(page);
  if (!isCurrent()) return null;
  const lastPage = Math.max(0, Math.ceil(data.total / pageSize) - 1);
  if (page > lastPage) {
    data = await read(lastPage);
    if (!isCurrent()) return null;
  }
  return data;
}

// Keep API requests bounded while presenting one complete, filtered list.
export async function loadAllRecords(api, path, filters, isCurrent = () => true) {
  const params = new URLSearchParams(filters), items = [];
  params.set('limit', '500');
  let page;
  do {
    if (!isCurrent()) return null;
    params.set('offset', String(items.length));
    page = await api(`${path}?${params}`);
    if (!isCurrent()) return null;
    if (page.hasMore && !page.items?.length) throw new Error('Não foi possível carregar todos os pedidos. Tente novamente.');
    items.push(...(page.items || []));
  } while (page.hasMore);
  return { ...page, items, offset: 0, limit: items.length, hasMore: false };
}

// Quantities remain usable if the optional demand calculation is delayed or
// unavailable. Both stages discard late responses after navigating or changing stores.
export async function loadInventoryRecords(api, filters, { isCurrent = () => true, onStock = () => {} } = {}) {
  const params = new URLSearchParams(filters);
  params.delete('forecast');
  const stock = await loadAllRecords(api, '/api/inventory', params, isCurrent);
  if (!stock || !isCurrent()) return null;
  onStock({ ...stock, forecastState: 'loading' });
  params.set('forecast', 'true');
  try {
    const data = await loadAllRecords(api, '/api/inventory', params, isCurrent);
    return data && isCurrent() ? { ...data, forecastState: 'ready' } : null;
  } catch (error) {
    if (!isCurrent()) return null;
    if ([401, 403].includes(error.status)) throw error;
    return { ...stock, forecastState: 'failed' };
  }
}
export { inventoryQuantities } from './inventory-quantities.js';
