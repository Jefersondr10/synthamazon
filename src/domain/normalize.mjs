// Only allowlisted business fields leave this module. No raw descriptions,
// buyer/recipient/address/payment data, credentials or complete contexts are returned.
const SAFE_STORE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function invalidSnapshot() {
  return Object.assign(new Error('A resposta da fonte não pôde ser normalizada.'), { code: 'INVALID_SNAPSHOT' });
}

function exactJson(rawBody) {
  if (typeof rawBody !== 'string') throw invalidSnapshot();
  try {
    // Node 24 exposes the original token in the reviver, even when the Number
    // passed to it was rounded. Existing JSON strings are returned unchanged.
    return JSON.parse(rawBody, (_key, value, context) => {
      if (typeof value !== 'number') return value;
      if (typeof context?.source !== 'string') throw invalidSnapshot();
      return context.source;
    });
  } catch {
    // Syntax errors can quote source text. Never expose the original exception.
    throw invalidSnapshot();
  }
}

function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function text(value) { return typeof value === 'string' && value.length > 0 ? value : null; }
function warning(warnings, code, path) { warnings.push({ code, path }); }

function list(value, warnings, path) {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value;
  warning(warnings, 'INVALID_LIST', path);
  return [];
}

function recordList(value) {
  if (!Array.isArray(value) || value.some(item => !object(item))) throw invalidSnapshot();
  return value;
}

function requiredId(value) {
  if (!text(value)) throw invalidSnapshot();
  return value;
}

function instant(value, warnings, path) {
  if (!text(value)) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (match) {
    const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    const timestamp = Date.parse(value);
    if (month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1] && hour < 24 && minute < 60 && second < 60 && Number.isFinite(timestamp)) {
      return new Date(timestamp).toISOString();
    }
  }
  warning(warnings, 'INVALID_DATE', path);
  return null;
}

function context({ storeId, observedAt } = {}) {
  const warnings = [];
  const observed = instant(observedAt, warnings, 'observedAt');
  if (typeof storeId !== 'string' || !SAFE_STORE.test(storeId) || !observed || warnings.length) throw invalidSnapshot();
  return { storeId, observedAt: observed };
}

function scaledInteger(value, places) {
  if (typeof value !== 'string' || value.length > 1024) return { error: 'INVALID_AMOUNT' };
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(value);
  if (!match) return { error: 'INVALID_AMOUNT' };
  const exponent = Number(match[4] ?? 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 512) return { error: 'INVALID_AMOUNT' };
  const fraction = match[3] ?? '';
  const coefficient = BigInt(match[2] + fraction);
  const power = places + exponent - fraction.length;
  let result;
  if (power >= 0) result = coefficient * 10n ** BigInt(power);
  else {
    const divisor = 10n ** BigInt(-power);
    if (coefficient % divisor !== 0n) return { error: 'SUBCENT_AMOUNT' };
    result = coefficient / divisor;
  }
  return { value: match[1] ? -result : result };
}

function money(value, warnings, path) {
  if (!object(value)) {
    warning(warnings, 'MISSING_MONEY', path);
    return { cents: null, currency: null };
  }
  let currency = text(value.currencyCode);
  if (!currency) warning(warnings, 'MISSING_CURRENCY', `${path}.currencyCode`);
  else if (!/^[A-Z]{3}$/.test(currency)) {
    warning(warnings, 'INVALID_CURRENCY', `${path}.currencyCode`);
    currency = null;
  }
  const amount = value.currencyAmount ?? value.amount;
  const result = scaledInteger(amount, 2);
  if (result.error) warning(warnings, amount === undefined || amount === null ? 'MISSING_AMOUNT' : result.error, `${path}.amount`);
  return { cents: result.error ? null : result.value.toString(), currency };
}

function quantity(value, warnings, path) {
  if (value === undefined || value === null || value === '') {
    warning(warnings, 'MISSING_QUANTITY', path);
    return null;
  }
  const result = scaledInteger(value, 0);
  if (result.error || result.value < 0n || result.value > BigInt(Number.MAX_SAFE_INTEGER)) {
    warning(warnings, 'INVALID_QUANTITY', path);
    return null;
  }
  return Number(result.value);
}

function breakdowns(value, warnings, path, orderFormat = false, depth = 0) {
  if (depth > 40) throw invalidSnapshot();
  return list(value, warnings, path).map((entry, index) => {
    if (!object(entry)) throw invalidSnapshot();
    const entryPath = `${path}[${index}]`;
    const amount = money(orderFormat ? entry.subtotal : entry.breakdownAmount, warnings, entryPath);
    return {
      kind: text(orderFormat ? entry.type : entry.breakdownType),
      amountCents: amount.cents,
      currency: amount.currency,
      children: breakdowns(entry.breakdowns, warnings, `${entryPath}.children`, orderFormat, depth + 1),
    };
  });
}

function identifiers(value, warnings, path, item = false) {
  const name = item ? 'itemRelatedIdentifierName' : 'relatedIdentifierName';
  const key = item ? 'itemRelatedIdentifierValue' : 'relatedIdentifierValue';
  return list(value, warnings, path).flatMap(entry => {
    if (!object(entry) || !text(entry[name]) || !text(entry[key])) {
      warning(warnings, 'INVALID_IDENTIFIER', path);
      return [];
    }
    if (item && !['ORDER_ADJUSTMENT_ITEM_ID', 'TRANSACTION_ID', 'ORDER_ITEM_ID'].includes(entry[name])) {
      warning(warnings, 'UNSUPPORTED_IDENTIFIER', path);
      return [];
    }
    return [{ type: entry[name], value: entry[key] }];
  });
}

function stringList(value, warnings, path) {
  return list(value, warnings, path).flatMap(entry => {
    if (text(entry)) return [entry];
    warning(warnings, 'INVALID_TEXT', path);
    return [];
  });
}

function uniqueField(contexts, key, warnings, path) {
  const values = [...new Set(contexts.map(entry => entry[key]).filter(value => value !== null))];
  if (values.length > 1) {
    warning(warnings, 'AMBIGUOUS_PRODUCT_CONTEXT', `${path}.${key}`);
    return null;
  }
  return values[0] ?? null;
}

function fulfilledByQuery(options) {
  const value = options?.fulfilledByQuery;
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length !== 1 || !['AMAZON', 'MERCHANT'].includes(value[0])) throw invalidSnapshot();
  return value[0];
}

function fulfillmentStatus(order, options, warnings) {
  const query = options?.fulfillmentStatusesQuery;
  if (query !== undefined && (!Array.isArray(query) || query.length !== 1 || query[0] !== 'CANCELLED')) throw invalidSnapshot();
  const field = text(order.fulfillment?.fulfillmentStatus);
  if (field && query && field !== query[0]) {
    warning(warnings, 'CONFLICTING_STATUS_FILTER', 'fulfillment.fulfillmentStatus');
    return { status: null };
  }
  const status = field ?? query?.[0] ?? null;
  return { status, ...(status ? { statusEvidence: { source: field ? 'api-field' : 'api-filter', status, observedAt: options.observedAt } } : {}) };
}

function fulfillment(order, programs, query, warnings) {
  const raw = order.fulfillment?.fulfilledBy;
  const hasField = raw !== undefined && raw !== null && raw !== '';
  const validField = ['AMAZON', 'MERCHANT'].includes(raw);
  const invalidField = hasField && !validField;
  const filterConflict = validField && query !== undefined && raw !== query;
  const candidate = validField ? raw : query ?? null;
  const dba = programs.includes('DELIVERY_BY_AMAZON');
  const programConflict = candidate === 'AMAZON' && dba;
  if (invalidField) warning(warnings, 'INVALID_FULFILLMENT', 'fulfillment.fulfilledBy');
  if (filterConflict) warning(warnings, 'CONFLICTING_FULFILLMENT_FILTER', 'fulfillment.fulfilledBy');
  if (programConflict) warning(warnings, 'CONFLICTING_FULFILLMENT', 'programs');
  if (invalidField || filterConflict || programConflict) return { fulfilledBy: null, fulfillmentMode: 'unknown' };
  return {
    fulfilledBy: candidate,
    fulfillmentMode: dba ? 'DBA' : candidate === 'AMAZON' ? 'FBA' : candidate === 'MERCHANT' ? 'MFN' : 'unknown',
    ...(candidate ? { fulfillmentEvidence: { source: validField ? 'api-field' : 'api-filter', fulfilledBy: candidate } } : {}),
  };
}

/** Orders 2026-01-01. Amounts are string cents; missing financial data stays null. */
export function normalizeOrders(rawBody, options) {
  const common = context(options);
  const query = fulfilledByQuery(options);
  const raw = exactJson(rawBody);
  const individual = options?.envelope === 'individual';
  if (options?.envelope !== undefined && !individual) throw invalidSnapshot();
  if (individual && (!object(raw?.order) || raw.orders !== undefined
    || !/^[A-Za-z0-9-]{1,80}$/.test(options.expectedOrderId ?? '')
    || raw.order.orderId !== options.expectedOrderId)) throw invalidSnapshot();
  return recordList(individual ? [raw.order] : raw?.orders).map(order => {
    const warnings = [];
    const total = money(order.proceeds?.grandTotal, warnings, 'proceeds.grandTotal');
    const programs = stringList(order.programs, warnings, 'programs');
    const logistics = fulfillment(order, programs, query, warnings);
    const items = recordList(order.orderItems).map((item, index) => {
      const p = `items[${index}]`;
      const unitPrice = money(item.product?.price?.unitPrice, warnings, `${p}.unitPrice`);
      const proceeds = money(item.proceeds?.proceedsTotal, warnings, `${p}.proceeds`);
      return {
        orderItemId: requiredId(item.orderItemId),
        sku: text(item.product?.sellerSku), asin: text(item.product?.asin), title: text(item.product?.title),
        quantityOrdered: quantity(item.quantityOrdered, warnings, `${p}.quantityOrdered`),
        unitPriceCents: unitPrice.cents, unitPriceCurrency: unitPrice.currency,
        proceedsCents: proceeds.cents, proceedsCurrency: proceeds.currency,
        breakdowns: breakdowns(item.proceeds?.breakdowns, warnings, `${p}.breakdowns`, true),
      };
    });
    const packages = list(order.packages, warnings, 'packages').map((entry, index) => {
      if (!object(entry)) throw invalidSnapshot();
      const p = `packages[${index}]`;
      return {
        packageReferenceId: text(entry.packageReferenceId),
        trackingNumber: text(entry.trackingNumber), carrier: text(entry.carrier), shippingService: text(entry.shippingService),
        status: text(entry.packageStatus?.status), detailedStatus: text(entry.packageStatus?.detailedStatus),
        shippedAt: instant(entry.shipTime, warnings, `${p}.shipTime`), createdAt: instant(entry.createdTime, warnings, `${p}.createdTime`),
        items: list(entry.packageItems, warnings, `${p}.items`).map((item, itemIndex) => ({
          orderItemId: text(item?.orderItemId), quantity: quantity(item?.quantity, warnings, `${p}.items[${itemIndex}].quantity`),
        })),
      };
    });
    return {
      ...common, orderId: requiredId(order.orderId),
      createdAt: instant(order.createdTime, warnings, 'createdTime'), updatedAt: instant(order.lastUpdatedTime, warnings, 'lastUpdatedTime'),
      marketplaceId: text(order.salesChannel?.marketplaceId), programs, ...fulfillmentStatus(order, options, warnings),
      ...logistics,
      grandTotalCents: total.cents, currency: total.currency,
      breakdowns: breakdowns(order.proceeds?.breakdowns, warnings, 'proceeds.breakdowns', true),
      items, packages, warnings,
    };
  });
}

/** Finances 2024-06-19. Totals remain original net totals, never sums of all tree levels. */
export function normalizeTransactions(rawBody, options) {
  const common = context(options);
  const raw = exactJson(rawBody);
  // TransactionsPayload.transactions is optional; the payload object is still
  // required here so a missing/error envelope never becomes an invented zero.
  if (!object(raw) || !object(raw.payload)) throw invalidSnapshot();
  return recordList(raw.payload.transactions === undefined ? [] : raw.payload.transactions).map(transaction => {
    const warnings = [];
    const total = money(transaction.totalAmount, warnings, 'totalAmount');
    const related = identifiers(transaction.relatedIdentifiers, warnings, 'relatedIdentifiers');
    const ids = type => [...new Set(related.filter(entry => entry.type === type).map(entry => entry.value))];
    const items = list(transaction.items, warnings, 'items').map((item, index) => {
      if (!object(item)) throw invalidSnapshot();
      const p = `items[${index}]`;
      const itemTotal = money(item.totalAmount, warnings, `${p}.totalAmount`);
      const contexts = list(item.contexts, warnings, `${p}.contexts`).filter(entry => object(entry) && entry.contextType === 'ProductContext').map((entry, index) => ({
        asin: text(entry.asin), sku: text(entry.sku),
        quantityShipped: quantity(entry.quantityShipped, warnings, `${p}.contexts[${index}].quantityShipped`),
        fulfillmentNetwork: text(entry.fulfillmentNetwork),
      }));
      return {
        totalCents: itemTotal.cents, currency: itemTotal.currency,
        relatedIdentifiers: identifiers(item.relatedIdentifiers, warnings, `${p}.relatedIdentifiers`, true),
        asin: uniqueField(contexts, 'asin', warnings, p), sku: uniqueField(contexts, 'sku', warnings, p),
        quantityShipped: uniqueField(contexts, 'quantityShipped', warnings, p), fulfillmentNetwork: uniqueField(contexts, 'fulfillmentNetwork', warnings, p),
        contexts, breakdowns: breakdowns(item.breakdowns, warnings, `${p}.breakdowns`),
      };
    });
    return {
      ...common, transactionId: requiredId(transaction.transactionId), type: text(transaction.transactionType), status: text(transaction.transactionStatus),
      postedAt: instant(transaction.postedDate, warnings, 'postedDate'),
      marketplaceId: text(transaction.marketplaceDetails?.marketplaceId) ?? text(transaction.sellingPartnerMetadata?.marketplaceId),
      orderIds: ids('ORDER_ID'), settlementIds: ids('SETTLEMENT_ID'), groupIds: ids('FINANCIAL_EVENT_GROUP_ID'),
      deferredTransactionIds: ids('DEFERRED_TRANSACTION_ID'), releaseTransactionIds: ids('RELEASE_TRANSACTION_ID'),
      totalCents: total.cents, currency: total.currency,
      // This classifies the fact; totalCents is still net and is not gross sales.
      countsAsSales: transaction.transactionType === 'Shipment',
      breakdowns: breakdowns(transaction.breakdowns, warnings, 'breakdowns'), items, warnings,
    };
  });
}

/** Finances v0: whitelist only balance fields; bank and transfer details are omitted. */
export function normalizeFinancialEventGroups(rawBody, options) {
  const common = context(options), raw = exactJson(rawBody);
  if (!object(raw?.payload)) throw invalidSnapshot();
  return recordList(raw.payload.FinancialEventGroupList ?? []).map(group => {
    const warnings = [];
    const total = money({ currencyCode: group.OriginalTotal?.CurrencyCode, currencyAmount: group.OriginalTotal?.CurrencyAmount }, warnings, 'OriginalTotal');
    return { ...common, groupId: requiredId(group.FinancialEventGroupId), status: requiredId(group.ProcessingStatus),
      totalCents: total.cents, currency: total.currency,
      startedAt: instant(group.FinancialEventGroupStart, warnings, 'FinancialEventGroupStart'), warnings };
  });
}

/** FBA Inventory v1: original totals and potentially overlapping categories stay separate. */
export function normalizeInventory(rawBody, options) {
  const common = context(options);
  const raw = exactJson(rawBody);
  return recordList(raw?.payload?.inventorySummaries).map(item => {
    const warnings = [];
    if (!text(item.sellerSku) && !text(item.asin)) throw invalidSnapshot();
    const details = object(item.inventoryDetails) ? item.inventoryDetails : {};
    const group = (name, keys) => Object.fromEntries(keys.map(key => [key, quantity(details[name]?.[key], warnings, `inventoryDetails.${name}.${key}`)]));
    return {
      ...common, sellerSku: text(item.sellerSku), asin: text(item.asin), fnSku: text(item.fnSku), title: text(item.productName), condition: text(item.condition),
      updatedAt: instant(item.lastUpdatedTime, warnings, 'lastUpdatedTime'),
      totalQuantity: quantity(item.totalQuantity, warnings, 'totalQuantity'),
      stores: stringList(item.stores, warnings, 'stores'),
      inventoryDetails: {
        ...Object.fromEntries(['fulfillableQuantity', 'inboundWorkingQuantity', 'inboundShippedQuantity', 'inboundReceivingQuantity'].map(key => [key, quantity(details[key], warnings, `inventoryDetails.${key}`)])),
        reservedQuantity: group('reservedQuantity', ['totalReservedQuantity', 'pendingCustomerOrderQuantity', 'pendingTransshipmentQuantity', 'fcProcessingQuantity']),
        researchingQuantity: {
          ...group('researchingQuantity', ['totalResearchingQuantity']),
          researchingQuantityBreakdown: list(details.researchingQuantity?.researchingQuantityBreakdown, warnings, 'inventoryDetails.researchingQuantity.researchingQuantityBreakdown').map((entry, index) => ({
            name: text(entry?.name), quantity: quantity(entry?.quantity, warnings, `inventoryDetails.researchingQuantity.researchingQuantityBreakdown[${index}].quantity`),
          })),
        },
        unfulfillableQuantity: group('unfulfillableQuantity', ['totalUnfulfillableQuantity', 'customerDamagedQuantity', 'warehouseDamagedQuantity', 'distributorDamagedQuantity', 'carrierDamagedQuantity', 'defectiveQuantity', 'expiredQuantity']),
        futureSupplyQuantity: group('futureSupplyQuantity', ['reservedFutureSupplyQuantity', 'futureSupplyBuyableQuantity']),
      },
      warnings,
    };
  });
}
