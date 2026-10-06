// Contracts: amzn/selling-partner-api-models, Orders 2026-01-01,
// Finances 2024-06-19 and fbaInventory v1 (checked 2026-09-24).
import { RETURN_REPORT_TYPES, downloadReturnReportDocument } from './return-reports.mjs';
export const AMAZON_BR_MARKETPLACE_ID = 'A2Q3Y263D00KWC';
const SP_API_ORIGIN = 'https://sellingpartnerapi-na.amazon.com';
const LWA_URL = 'https://api.amazon.com/auth/o2/token';
const DAY_MS = 86_400_000;
const SAFE_DATASETS = ['PROCEEDS', 'EXPENSE', 'PROMOTION', 'CANCELLATION', 'PACKAGES', 'FULFILLMENT'];
const DEFAULT_DATASETS = ['PROCEEDS', 'EXPENSE', 'PROMOTION', 'PACKAGES', 'FULFILLMENT'];
const ORDER_STATUSES = ['PENDING_AVAILABILITY', 'PENDING', 'UNSHIPPED', 'PARTIALLY_SHIPPED', 'SHIPPED', 'CANCELLED', 'UNFULFILLABLE'];

export class AmazonApiError extends Error {
  constructor(code, operation, { status, requestId, retryAfterMs } = {}) {
    super(`Amazon: ${operation} falhou (${code}${status ? `, HTTP ${status}` : ''}).`);
    this.name = 'AmazonApiError';
    this.code = code;
    this.operation = operation;
    if (status !== undefined) this.status = status;
    if (requestId !== undefined) this.requestId = requestId;
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
  }
}

function invalid(operation) { throw new AmazonApiError('INVALID_PARAMETERS', operation); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function allowedParams(value, keys, operation) {
  if (!object(value) || Object.keys(value).some(key => !keys.includes(key))) invalid(operation);
  return { ...value };
}
function string(value, operation) {
  if (typeof value !== 'string' || !value.trim() || value.length > 16_384) invalid(operation);
  return value;
}
function list(value, operation, { allowed, max = 50 } = {}) {
  if (!Array.isArray(value) || value.length < 1 || value.length > max) invalid(operation);
  for (const item of value) {
    string(item, operation);
    if (item.includes(',') || (allowed && !allowed.includes(item))) invalid(operation);
  }
  return [...value];
}
function timestamp(value, operation) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) invalid(operation);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) invalid(operation);
  return parsed;
}
function token(value, operation) {
  if (value === undefined || value === null || value === '') return undefined;
  return string(value, operation);
}
function envelopeError(operation) { throw new AmazonApiError('INVALID_RESPONSE', operation); }

// Prevent unexpected customer data from reaching the collector's raw snapshots.
// BUYER/RECIPIENT/TAX/PAYMENT are never requested. FULFILLMENT operational
// fields are available to common roles; gift messages still require a restricted
// role and are defensively rejected here if unexpectedly returned.
// https://developer-docs.amazon/sp-api/docs/access-orders-pii
function rejectRestrictedOrderData(value, operation) {
  const forbidden = new Set(['buyer', 'recipient', 'tax', 'payment', 'giftMessage', 'customization', 'buyerCustomizedInfo']);
  const pending = [value];
  while (pending.length) {
    const current = pending.pop();
    if (current === null || typeof current !== 'object') continue;
    for (const [key, child] of Object.entries(current)) {
      if (forbidden.has(key) && child !== undefined && child !== null) {
        throw new AmazonApiError('UNEXPECTED_RESTRICTED_DATA', operation);
      }
      if (child !== null && typeof child === 'object') pending.push(child);
    }
  }
}

/** NA read client plus generation of two allowlisted operational reports.
 * Generators yield one normalized page plus its exact rawBody.
 * No automatic refresh on HTTP 401/403, no pagination restart, no financial sums.
 * A generator that reaches maxPages with a cursor throws PAGINATION_LIMIT.
 */
export class AmazonClient {
  #credentials;
  #fetch;
  #sleep;
  #now;
  #timeoutMs;
  #maxAttempts;
  #maxPages;
  #maxRetryDelayMs;
  #minRetryDelayMs;
  #accessToken;
  #expiresAt = 0;
  #tokenPromise;

  constructor({ clientId, clientSecret, refreshToken, fetchImpl = globalThis.fetch,
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now,
    timeoutMs = 30_000, maxAttempts = 4, maxPages = 1_000, maxRetryDelayMs = 60_000, minRetryDelayMs = 1_000 } = {}) {
    if ([clientId, clientSecret, refreshToken].some(value => typeof value !== 'string' || !value.trim())) {
      throw new AmazonApiError('MISSING_CREDENTIALS', 'configure');
    }
    if (typeof fetchImpl !== 'function' || typeof sleep !== 'function' || typeof now !== 'function') invalid('configure');
    for (const [value, min, max] of [[timeoutMs, 1, 120_000], [maxAttempts, 1, 8], [maxPages, 1, 10_000], [maxRetryDelayMs, 0, 300_000], [minRetryDelayMs, 1, 300_000]]) {
      if (!Number.isInteger(value) || value < min || value > max) invalid('configure');
    }
    this.#credentials = { clientId, clientSecret, refreshToken };
    this.#fetch = fetchImpl;
    this.#sleep = sleep;
    this.#now = now;
    this.#timeoutMs = timeoutMs;
    this.#maxAttempts = maxAttempts;
    this.#maxPages = maxPages;
    this.#maxRetryDelayMs = maxRetryDelayMs;
    this.#minRetryDelayMs = minRetryDelayMs;
  }

  async #exchange(url, options, operation) {
    for (let attempt = 0; attempt < this.#maxAttempts; attempt++) {
      const controller = new AbortController();
      let timeout;
      let result;
      try {
        result = await Promise.race([
          (async () => {
            const response = await this.#fetch(url, { ...options, redirect: 'error', signal: controller.signal });
            const requestId = response.headers.get('x-amzn-requestid') || undefined;
            // Error bodies may include submitted secrets; never read or expose them.
            if (!response.ok) {
              await response.body?.cancel?.();
              return { status: response.status, requestId, retryAfter: response.headers.get('retry-after') };
            }
            return { status: response.status, requestId, rawBody: await response.text() };
          })(),
          new Promise((_, reject) => {
            timeout = setTimeout(() => {
              controller.abort();
              reject(new AmazonApiError('TIMEOUT', operation));
            }, this.#timeoutMs);
          }),
        ]);
      } catch (error) {
        if (error instanceof AmazonApiError) throw error;
        throw new AmazonApiError(controller.signal.aborted ? 'TIMEOUT' : 'NETWORK_ERROR', operation);
      } finally {
        clearTimeout(timeout);
      }
      if (result.status >= 200 && result.status < 300) {
        let body;
        try { body = JSON.parse(result.rawBody); } catch { envelopeError(operation); }
        if (!object(body)) envelopeError(operation);
        return { body, rawBody: result.rawBody, requestId: result.requestId };
      }
      const retryable = result.status === 429 || (result.status >= 500 && result.status <= 599);
      let delay = Math.max(this.#minRetryDelayMs, 1_000 * (2 ** attempt));
      if (result.retryAfter) {
        const numeric = /^\d+(?:\.\d+)?$/.test(result.retryAfter.trim()) ? Number(result.retryAfter) * 1_000 : NaN;
        const date = Date.parse(result.retryAfter);
        const serverDelay = Number.isFinite(numeric) ? numeric : (Number.isFinite(date) ? Math.max(0, date - this.#now()) : 0);
        delay = Math.max(delay, serverDelay);
      }
      if (!retryable || attempt + 1 === this.#maxAttempts || delay > this.#maxRetryDelayMs) {
        throw new AmazonApiError(result.status === 429 ? 'RATE_LIMITED' : 'HTTP_ERROR', operation, {
          status: result.status, requestId: result.requestId, ...(retryable ? { retryAfterMs: delay } : {}),
        });
      }
      await this.#sleep(delay);
    }
    throw new AmazonApiError('RETRY_LIMIT', operation);
  }

  async #getAccessToken() {
    if (this.#accessToken && this.#now() < this.#expiresAt) return this.#accessToken;
    if (this.#tokenPromise) return this.#tokenPromise;
    this.#tokenPromise = (async () => {
      const { clientId, clientSecret, refreshToken } = this.#credentials;
      const { body } = await this.#exchange(LWA_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret }).toString(),
      }, 'lwaToken');
      const lifetimeMs = Number(body.expires_in) * 1_000;
      if (typeof body.access_token !== 'string' || !body.access_token || !Number.isFinite(lifetimeMs) || lifetimeMs <= 0) envelopeError('lwaToken');
      this.#accessToken = body.access_token;
      // Short-lived tokens keep at least 90% of their lifetime; normal tokens use 60s skew.
      this.#expiresAt = this.#now() + lifetimeMs - Math.min(60_000, lifetimeMs * 0.1);
      return this.#accessToken;
    })();
    try { return await this.#tokenPromise; } finally { this.#tokenPromise = undefined; }
  }

  async #get(path, params, operation) {
    const url = new URL(path, SP_API_ORIGIN);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, Array.isArray(value) ? value.join(',') : String(value));
    }
    const accessToken = await this.#getAccessToken();
    const result = await this.#exchange(url.toString(), {
      method: 'GET', headers: {
        'x-amz-access-token': accessToken,
        'x-amz-date': new Date(this.#now()).toISOString().replace(/[:-]|\.\d{3}/g, ''),
        'user-agent': 'SynthAmazon/0.1 (Language=Node.js)',
        accept: 'application/json',
      },
    }, operation);
    if (Array.isArray(result.body.errors) && result.body.errors.length) envelopeError(operation);
    return result;
  }

  async *#pages(path, params, operation, tokenParam, decode) {
    const seen = new Set();
    if (params[tokenParam]) seen.add(params[tokenParam]);
    for (let pageNumber = 1; pageNumber <= this.#maxPages; pageNumber++) {
      const { body, rawBody, requestId } = await this.#get(path, params, operation);
      const page = decode(body);
      const nextToken = token(page.nextToken, operation);
      yield { ...page, nextToken, rawBody, requestId };
      if (!nextToken) return;
      if (seen.has(nextToken)) throw new AmazonApiError('PAGINATION_CYCLE', operation);
      if (pageNumber === this.#maxPages) throw new AmazonApiError('PAGINATION_LIMIT', operation);
      seen.add(nextToken);
      params = { ...params, [tokenParam]: nextToken };
    }
  }

  async *searchOrders(parameters = {}) {
    const op = 'searchOrders';
    const params = allowedParams(parameters, ['createdAfter', 'createdBefore', 'lastUpdatedAfter', 'lastUpdatedBefore', 'fulfillmentStatuses', 'marketplaceIds', 'fulfilledBy', 'maxResultsPerPage', 'paginationToken', 'includedData'], op);
    const hasCreated = params.createdAfter !== undefined;
    if (hasCreated === (params.lastUpdatedAfter !== undefined)) invalid(op);
    if ((hasCreated && params.lastUpdatedBefore !== undefined) || (!hasCreated && params.createdBefore !== undefined)) invalid(op);
    const afterKey = hasCreated ? 'createdAfter' : 'lastUpdatedAfter';
    const beforeKey = hasCreated ? 'createdBefore' : 'lastUpdatedBefore';
    const after = timestamp(params[afterKey], op);
    // Freeze an omitted upper boundary so pagination cannot chase a moving time window.
    params[beforeKey] ??= new Date(this.#now() - 120_000).toISOString();
    const before = timestamp(params[beforeKey], op);
    if (after > before || before > this.#now() - 120_000) invalid(op);
    params.marketplaceIds = list(params.marketplaceIds ?? [AMAZON_BR_MARKETPLACE_ID], op);
    params.includedData = list(params.includedData ?? DEFAULT_DATASETS, op, { allowed: SAFE_DATASETS });
    if (params.fulfilledBy !== undefined) params.fulfilledBy = list(params.fulfilledBy, op, { allowed: ['AMAZON', 'MERCHANT'] });
    if (params.fulfillmentStatuses !== undefined) params.fulfillmentStatuses = list(params.fulfillmentStatuses, op, { allowed: ORDER_STATUSES });
    params.maxResultsPerPage ??= 100;
    if (!Number.isInteger(params.maxResultsPerPage) || params.maxResultsPerPage < 1 || params.maxResultsPerPage > 100) invalid(op);
    params.paginationToken = token(params.paginationToken, op);
    yield* this.#pages('/orders/2026-01-01/orders', params, op, 'paginationToken', body => {
      if (!Array.isArray(body.orders)) envelopeError(op);
      rejectRestrictedOrderData(body, op);
      return { orders: body.orders, nextToken: body.pagination?.nextToken,
        ...(body.createdBefore ? { createdBefore: body.createdBefore } : {}),
        ...(body.lastUpdatedBefore ? { lastUpdatedBefore: body.lastUpdatedBefore } : {}) };
    });
  }

  async *listFinancialEventGroups() {
    const op = 'listFinancialEventGroups';
    const before = this.#now() - 300_000;
    const params = { MaxResultsPerPage: 100,
      FinancialEventGroupStartedAfter: new Date(before - 180 * DAY_MS).toISOString(),
      FinancialEventGroupStartedBefore: new Date(before).toISOString() };
    yield* this.#pages('/finances/v0/financialEventGroups', params, op, 'NextToken', body => {
      if (!object(body.payload) || (body.payload.FinancialEventGroupList !== undefined && !Array.isArray(body.payload.FinancialEventGroupList))) envelopeError(op);
      return { groups: body.payload.FinancialEventGroupList ?? [], nextToken: body.payload.NextToken };
    });
  }

  async *listFinancialEventsByOrderId(orderId) {
    const op = 'listFinancialEventsByOrderId';
    if (typeof orderId !== 'string' || !/^\d{3}-\d{7}-\d{7}$/.test(orderId)) invalid(op);
    yield* this.#pages(`/finances/v0/orders/${orderId}/financialEvents`, { MaxResultsPerPage: 100 }, op, 'NextToken', body => {
      if (!object(body.payload) || !object(body.payload.FinancialEvents)) envelopeError(op);
      const events = body.payload.FinancialEvents.SAFETReimbursementEventList ?? [];
      if (!Array.isArray(events)) envelopeError(op);
      // The requested order is the association: SAFE-T events do not contain an
      // order ID in the published schema. Never match claims by amount or date.
      return { orderId, safeTEvents: events, nextToken: body.payload.NextToken };
    });
  }

  async getOrder(orderId, parameters = {}) {
    const op = 'getOrder';
    string(orderId, op);
    if (!/^[A-Za-z0-9-]{1,80}$/.test(orderId)) invalid(op);
    const params = allowedParams(parameters, ['includedData'], op);
    params.includedData = list(params.includedData ?? ['PACKAGES'], op, { allowed: ['PACKAGES', 'FULFILLMENT'] });
    const { body, rawBody, requestId } = await this.#get(`/orders/2026-01-01/orders/${encodeURIComponent(orderId)}`, params, op);
    if (!object(body.order)) envelopeError(op);
    rejectRestrictedOrderData(body, op);
    return { order: body.order, rawBody, requestId };
  }

  async createReturnReport(parameters = {}) {
    const op = 'createReturnReport';
    const params = allowedParams(parameters, ['reportType', 'dataStartTime', 'dataEndTime', 'marketplaceIds'], op);
    if (!RETURN_REPORT_TYPES.includes(params.reportType)) invalid(op);
    const start = timestamp(params.dataStartTime, op), end = timestamp(params.dataEndTime, op);
    for (const value of [params.dataStartTime, params.dataEndTime]) {
      const [year, month, day] = value.slice(0, 10).split('-').map(Number);
      if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) invalid(op);
    }
    if (start >= end || end > this.#now() || (params.reportType === RETURN_REPORT_TYPES[0] && end - start > 60 * DAY_MS)) invalid(op);
    params.marketplaceIds = list(params.marketplaceIds ?? [AMAZON_BR_MARKETPLACE_ID], op, { max: 1, allowed: [AMAZON_BR_MARKETPLACE_ID] });
    const accessToken = await this.#getAccessToken();
    const { body, requestId } = await this.#exchange(`${SP_API_ORIGIN}/reports/2021-06-30/reports`, {
      method: 'POST', headers: { 'x-amz-access-token': accessToken, 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(params),
    }, op);
    if (typeof body.reportId !== 'string' || !body.reportId || body.errors?.length) envelopeError(op);
    return { reportId: body.reportId, requestId };
  }

  async getReport(reportId) {
    const op = 'getReport'; string(reportId, op);
    if (!/^[A-Za-z0-9._:-]{1,500}$/.test(reportId)) invalid(op);
    const { body, requestId } = await this.#get(`/reports/2021-06-30/reports/${encodeURIComponent(reportId)}`, {}, op);
    if (body.reportId !== reportId || !RETURN_REPORT_TYPES.includes(body.reportType)
      || !['IN_QUEUE', 'IN_PROGRESS', 'DONE', 'CANCELLED', 'FATAL'].includes(body.processingStatus)) envelopeError(op);
    return { reportId: body.reportId, reportType: body.reportType, processingStatus: body.processingStatus, requestId,
      ...Object.fromEntries(['reportDocumentId', 'dataStartTime', 'dataEndTime'].filter(key => typeof body[key] === 'string').map(key => [key, body[key]])) };
  }

  async getReportDocument(reportDocumentId) {
    const op = 'getReportDocument'; string(reportDocumentId, op);
    if (!/^[A-Za-z0-9._:-]{1,500}$/.test(reportDocumentId)) invalid(op);
    const { body, requestId } = await this.#get(`/reports/2021-06-30/documents/${encodeURIComponent(reportDocumentId)}`, {}, op);
    if (body.reportDocumentId !== reportDocumentId || typeof body.url !== 'string' || body.compressionAlgorithm !== undefined && body.compressionAlgorithm !== 'GZIP') envelopeError(op);
    // Presigned URL is ephemeral: callers must never persist or log this object.
    return { reportDocumentId, url: body.url, ...(body.compressionAlgorithm ? { compressionAlgorithm: body.compressionAlgorithm } : {}), requestId };
  }

  async downloadReturnReportDocument(document) {
    return downloadReturnReportDocument(document, { fetchImpl: this.#fetch, timeoutMs: this.#timeoutMs });
  }

  async *listTransactions(parameters = {}) {
    const op = 'listTransactions';
    const params = allowedParams(parameters, ['postedAfter', 'postedBefore', 'marketplaceId', 'transactionStatus', 'relatedIdentifierName', 'relatedIdentifierValue', 'nextToken'], op);
    const hasIdentifier = params.relatedIdentifierName !== undefined;
    if (hasIdentifier !== (params.relatedIdentifierValue !== undefined)) invalid(op);
    if (hasIdentifier) {
      if (!['FINANCIAL_EVENT_GROUP_ID', 'ORDER_ID'].includes(params.relatedIdentifierName)) invalid(op);
      string(params.relatedIdentifierValue, op);
    }
    if (params.postedAfter === undefined && !hasIdentifier) invalid(op);
    if (params.postedAfter !== undefined) {
      const after = timestamp(params.postedAfter, op);
      params.postedBefore ??= new Date(this.#now() - 120_001).toISOString();
      const before = timestamp(params.postedBefore, op);
      if (after >= before || before >= this.#now() - 120_000 || before - after > 180 * DAY_MS) invalid(op);
    } else if (params.postedBefore !== undefined && timestamp(params.postedBefore, op) >= this.#now() - 120_000) invalid(op);
    params.marketplaceId = string(params.marketplaceId ?? AMAZON_BR_MARKETPLACE_ID, op);
    if (params.transactionStatus !== undefined && !['DEFERRED', 'RELEASED', 'DEFERRED_RELEASED'].includes(params.transactionStatus)) invalid(op);
    params.nextToken = token(params.nextToken, op);
    yield* this.#pages('/finances/2024-06-19/transactions', params, op, 'nextToken', body => {
      if (!object(body.payload)) envelopeError(op);
      // Transactions is optional in the official schema, including empty pages.
      if (body.payload.transactions !== undefined && !Array.isArray(body.payload.transactions)) envelopeError(op);
      return { transactions: body.payload.transactions ?? [], nextToken: body.payload.nextToken };
    });
  }

  async *getInventorySummaries(parameters = {}) {
    const op = 'getInventorySummaries';
    const params = allowedParams(parameters, ['details', 'granularityType', 'granularityId', 'marketplaceIds', 'startDateTime', 'sellerSkus', 'sellerSku', 'nextToken'], op);
    params.marketplaceIds = list(params.marketplaceIds ?? [AMAZON_BR_MARKETPLACE_ID], op, { max: 1 });
    params.granularityType ??= 'Marketplace';
    params.granularityId ??= params.marketplaceIds[0];
    if (params.granularityType !== 'Marketplace' || params.granularityId !== params.marketplaceIds[0]) invalid(op);
    params.details ??= true;
    if (typeof params.details !== 'boolean') invalid(op);
    if (params.startDateTime !== undefined) {
      const earliest = new Date(this.#now());
      earliest.setUTCMonth(earliest.getUTCMonth() - 18);
      const start = timestamp(params.startDateTime, op);
      if (start < earliest.getTime() || start > this.#now()) invalid(op);
    }
    if (params.sellerSkus !== undefined) params.sellerSkus = list(params.sellerSkus, op);
    if (params.sellerSku !== undefined) string(params.sellerSku, op);
    if ((params.startDateTime !== undefined && (params.sellerSkus !== undefined || params.sellerSku !== undefined)) || (params.sellerSkus !== undefined && params.sellerSku !== undefined)) invalid(op);
    params.nextToken = token(params.nextToken, op);
    yield* this.#pages('/fba/inventory/v1/summaries', params, op, 'nextToken', body => {
      if (!object(body.payload) || !object(body.payload.granularity) || !Array.isArray(body.payload.inventorySummaries)) envelopeError(op);
      return { inventorySummaries: body.payload.inventorySummaries, granularity: body.payload.granularity, nextToken: body.pagination?.nextToken };
    });
  }
}
