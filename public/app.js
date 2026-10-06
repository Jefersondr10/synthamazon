'use strict';
const storeSelectionReady = import('/store-selection.js');
let parseStoreSelection, isMultipleStores, matchesStoreSelection, restoreStoreSelection, selectedCollectionTimes;
const layoutReady = import('/layout.js');
const selectMenusReady = import('/select-menus.js');
async function loadScreenModule(url) {
  try { return await import(url); }
  catch {
    // A failed module URL can remain cached by the browser. A fragment gives
    // one fresh attempt without changing the server's asset allowlist.
    try { return await import(`${url}#retry-${Date.now()}`); }
    catch { throw new Error('Não foi possível abrir esta tela. Confira a conexão e tente atualizar o painel.'); }
  }
}
let selectMenus;
const listDataReady = import('/list-data.js');
const inventoryPlanningReady = import('/inventory-planning.js');
let inventoryPlanning, inventoryPreferences;
let productSalesModule, productSalesState, productSalesData, productSalesCleanup;
let salesAlertsModule, salesAlertsCleanup;
let productLinksSettingsModule, productLinksSettingsCleanup;
const productLinksListState = {query:'',mode:'ALL',linkStatus:'all',limit:50,offset:0,storeId:null};
const salesAlertsState = {status:'new',mode:'all',type:'all',query:'',limit:24,offset:0,loading:false};
let loadAllRecords, loadInventoryRecords, fetchReadWithRetry, inventoryQuantities;
let layout;
function prepareTables(root) { layout?.prepareTables(root); applyCopiedOrderHighlight(root); }
function refundFormSteps(form) { layout?.refundFormSteps(form); }

const $ = (selector, root = document) => root.querySelector(selector);
const iconPaths = {
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  logout: '<path d="M9 4H4v16h5M9 12h12m-4-4 4 4-4 4"/>',
  bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/>',
  chart: '<path d="M4 4v16h16M8 15V9m5 6V5m5 10v-3"/>',
  copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
  settings: '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  dashboard: '<rect x="3" y="3" width="7" height="7" rx="1.3"/><rect x="14" y="3" width="7" height="7" rx="1.3"/><rect x="3" y="14" width="7" height="7" rx="1.3"/><rect x="14" y="14" width="7" height="7" rx="1.3"/>',
  orders: '<path d="M7 4h10l3 4v12H4V8l3-4Z"/><path d="M4 8h16M9 12h6M9 16h4"/>',
  store: '<path d="M4 10v11h16V10M3 6l2-3h14l2 3v4a3 3 0 0 1-4 0 3 3 0 0 1-5 0 3 3 0 0 1-5 0 3 3 0 0 1-4 0V6ZM3 6h18M9 21v-7h6v7"/>',
  inventory: '<path d="m12 3 9 5v9l-9 5-9-5V8l9-5Zm0 9v10M3 8l9 4 9-4M8 5l9 5"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4m10-4v4M3 11h18M8 15h2m4 0h2"/>',
  refresh: '<path d="M20 8a8 8 0 0 0-14-3L3 8m0-5v5h5M4 16a8 8 0 0 0 14 3l3-3m0 5v-5h-5"/>',
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  arrowLeft: '<path d="M19 12H5m5-5-5 5 5 5"/>',
  money: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="12" cy="12" r="3"/><path d="M6 12h.01M18 12h.01"/>',
  refund: '<path d="M4 10h10a5 5 0 0 1 0 10h-3M8 6l-4 4 4 4"/>',
  transfer: '<path d="M4 7h15l-4-4m4 4-4 4M20 17H5l4-4m-4 4 4 4"/>',
  search: '<circle cx="10" cy="10" r="6.5"/><path d="m15 15 5.5 5.5"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.4 1.4m11.2 11.2L19 19M5 19l1.4-1.4M17.6 6.4 19 5"/>',
  moon: '<path d="M20.7 13a9 9 0 0 1-9.7-9.7A9 9 0 1 0 20.7 13Z"/>',
};
function icon(name) { return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${iconPaths[name] || iconPaths.info}</svg>`; }
document.querySelectorAll('[data-icon]').forEach(el => { el.innerHTML = icon(el.dataset.icon); });
function applyTheme(theme, save = false) {
  const dark = theme === 'dark';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  const toggle = $('#theme-toggle');
  const label = dark ? 'Tema claro' : 'Tema escuro';
  toggle.innerHTML = `${icon(dark ? 'sun' : 'moon')}<span class="theme-label">${label}</span>`;
  toggle.setAttribute('aria-label', `Ativar ${label.toLowerCase()}`);
  toggle.setAttribute('aria-pressed', String(dark));
  toggle.title = `Ativar ${label.toLowerCase()}`;
  if (save) {
    try { localStorage.setItem('synthamazon-theme', dark ? 'dark' : 'light'); } catch {}
    document.cookie = `synthamazon_theme=${dark ? 'dark' : 'light'}; Path=/; Max-Age=31536000; SameSite=Strict`;
  }
}
let savedTheme = document.cookie.split(';').map(value => value.trim()).find(value => value.startsWith('synthamazon_theme='))?.split('=')[1];
if (!['dark', 'light'].includes(savedTheme)) { try { savedTheme = localStorage.getItem('synthamazon-theme'); } catch {} }
applyTheme(savedTheme);
$('#theme-toggle').addEventListener('click', () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark', true));
function escape(value) { return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])); }
const number = value => value === null || value === undefined ? '—' : new Intl.NumberFormat('pt-BR').format(value);
const counted = (value, singular, plural) => `${number(value)} ${value === 1 ? singular : plural}`;
function inventoryAsinLink(asin, fallback = 'ASIN não informado') {
  const value = typeof asin === 'string' ? asin.trim().toUpperCase() : '';
  if (!/^[A-Z0-9]{10}$/.test(value)) return escape(value || fallback);
  return `<a class="amazon-asin-link" href="https://www.amazon.com.br/dp/${encodeURIComponent(value)}" target="_blank" rel="noopener noreferrer" title="Abrir anúncio na Amazon (nova aba)" aria-label="ASIN ${escape(value)}: abrir anúncio na Amazon em nova aba">${escape(value)} <span aria-hidden="true">↗</span></a>`;
}
function money(cents, currency) {
  if (cents === null || cents === undefined || !/^-?\d+$/.test(String(cents))) return 'Não informado';
  const value = BigInt(cents), abs = value < 0n ? -value : value;
  const prefix = currency === 'BRL' ? 'R$' : currency || 'Moeda não informada';
  return `${value < 0n ? '−' : ''}${prefix} ${new Intl.NumberFormat('pt-BR').format(abs / 100n)},${String(abs % 100n).padStart(2, '0')}`;
}
function amount(cents, currency, extra = '') { return `<span class="amount ${String(cents).startsWith('-') ? 'negative' : ''} ${extra}">${escape(money(cents, currency))}</span>`; }
const dateFormat = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric' });
const timeFormat = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
function date(value, withTime = false) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const parsed = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? value.split('-').reverse().join('/') : 'Não informado';
  }
  if (!value || Number.isNaN(Date.parse(value))) return 'Não informado';
  return (withTime ? timeFormat : dateFormat).format(new Date(value));
}
function localDay(value) { if (!value || Number.isNaN(Date.parse(value))) return ''; const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(value)); return ['year', 'month', 'day'].map(type => p.find(x => x.type === type).value).join('-'); }
function addDays(day, days) { const d = new Date(`${day}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); }
const state = { safeTStatus: 'all', safeTStatusLabels: {}, view: 'dashboard', storeId: '', from: '', to: '', query: '', mode: 'all', orderNet: 'all', orderStatus: 'all', orderStatusLabel: '', orderStatusLabels: {}, stock: 'all', returnStatus: 'all', customerRefund: 'all', caseStatus: 'all', caseStatusLabel: '', reviewStatus: 'all', reviewStatusLabel: '', caseType: 'all', caseTypeLabel: '', caseReimbursement: 'all', refundBulkMode: false, page: 0, pageSize: 20, version: 0, bootstrap: null, csrf: '', data: null, inventoryData: null };
let refundManagementModule, refundManagementState, refundManagementCleanup, returnedManagementModule;
const refundManagementHelpers = { escape, icon, money, date, number, colorBadge, orderDisplayStatusMarkup, returnedOrderMetadata, orderTrackingMarkup, applyReviewColors, copyOrderNumber, openOrder, openFinancialCase, openRelatedReturns, openCustomerReturnGroup, openReturnedToSeller, showMessage, storeName, prepareTables, refundFormSteps };
const titles = {
  dashboard: 'Visão geral',
  orders: 'Pedidos',
  'product-sales': 'Vendas por produto',
  'sales-alerts': 'Alertas de vendas',
  'refund-management': 'Gerenciar reembolsos',
  charges: 'Cobranças',
  'customer-returns': 'Gerenciar Devoluções',
  returns: 'Devolvido ao vendedor',
  inventory: 'Estoque FBA',
  settings: 'Configurações',
};
const txLabels = { Shipment: 'Vendas · líquido dos lançamentos', Refund: 'Reembolsos', ServiceFee: 'Cobranças de serviços', StorageBillingFee: 'Armazenamento', AdvertisingFee: 'Publicidade', ProductAdsPayment: 'Publicidade', FBAInventoryReimbursement: 'Restituição de estoque FBA', Adjustment: 'Ajustes e restituições', Transfer: 'Movimentos de repasse' };
const canonicalView = view => ['refunds', 'safe-t'].includes(view) ? 'refund-management' : view;
const financialTypeLabel = (type, kind) => kind === 'charges' && type === 'Refund' ? 'Reembolso sem pedido' : txLabels[type] || type || 'Não informado';
const reviewStatusLabels = { pending: 'Novo', in_review: 'Em análise', request_safe_t: 'Solicitar SAFE-T', waiting_amazon: 'Aguardando Amazon', resolved: 'Resolvido' };
const reviewColors = { neutral: 'Neutro', blue: 'Azul', amber: 'Amarelo', good: 'Verde', red: 'Vermelho' };
const reviewColorHex = { neutral: '#64748b', blue: '#2563eb', amber: '#d97706', good: '#15803d', red: '#dc2626' };
const validReviewHex = color => typeof color === 'string' && color.length === 7 && /^#[0-9a-f]{6}$/i.test(color);
function colorBadge(label, color) {
  return validReviewHex(color)
    ? `<span class="badge custom-color" data-status-color="${color.toLowerCase()}">${escape(label)}</span>`
    : badge(label, Object.hasOwn(reviewColors, color) ? color : 'neutral');
}
function applyReviewColor(element, color) {
  element.className = `badge ${validReviewHex(color) ? 'custom-color' : Object.hasOwn(reviewColors, color) ? color : 'neutral'}`;
  if (!validReviewHex(color)) { element.style.removeProperty('background-color'); element.style.removeProperty('color'); element.style.removeProperty('--status-color'); return; }
  element.style.setProperty('--status-color', color);
  if (document.documentElement.dataset.design) {
    element.style.backgroundColor = 'color-mix(in srgb, var(--status-color) 14%, var(--surface))';
    element.style.color = 'color-mix(in srgb, var(--status-color) 40%, var(--ink))';
    return;
  }
  const linear = [1, 3, 5].map(offset => {
    const value = parseInt(color.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const luminance = linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
  element.style.backgroundColor = color;
  element.style.color = luminance > 0.179 ? '#000000' : '#ffffff';
}
function applyReviewColors(root = document) {
  root.querySelectorAll('[data-status-color]').forEach(element => applyReviewColor(element, element.dataset.statusColor));
}
let reviewSettings = { items: [], menus: [] };
function rememberReviewSettings(value) {
  const items = Array.isArray(value) ? value : value?.items;
  if (Array.isArray(items)) reviewSettings.items = items;
  if (Array.isArray(value?.menus)) reviewSettings.menus = value.menus;
  return reviewSettings;
}
async function refreshReviewSettings() { return rememberReviewSettings(await api('/api/settings/statuses')); }
function reviewDefinition(code) { return reviewSettings.items.find(item => item.code === code); }
function reviewChoices(menu, current) {
  const options = reviewSettings.items.filter(item => item.active === true && !item.automatic && !item.readOnly && item.menus?.includes(menu));
  if (current?.status && !options.some(item => item.code === current.status)) options.push({ ...(reviewDefinition(current.status) || {}), code: current.status, label: current.label || reviewLabel(current.status, menu), preserved: true });
  return options;
}
function reviewChoiceValid(menu, code, current) { return typeof code === 'string' && (code === current?.status || reviewChoices(menu).some(item => item.code === code)); }
function reviewOptionsMarkup(menu, current) {
  return `${current?.status ? '' : '<option value="" selected>Escolha o status</option>'}${reviewChoices(menu, current).map(item => `<option value="${escape(item.code)}" ${current?.status === item.code ? 'selected' : ''}>${escape(item.label || item.code)}${item.preserved ? ' (status atual preservado)' : ''}</option>`).join('')}`;
}
const reimbursementLabels = { identified: 'Com ressarcimento', unidentified: 'Sem ressarcimento identificado', safe_t: 'SAFE-T', easy_ship: 'Easy Ship' };
const statusLabels = { RELEASED: 'Liberado', DEFERRED: 'Diferido', DEFERRED_RELEASED: 'Diferido liberado', IN_TRANSIT: 'Em trânsito', DELIVERED: 'Entregue', PICKED_UP: 'Coleta realizada', RETURNING_TO_SELLER: 'Devolvendo ao vendedor', RETURNED_TO_SELLER: 'Devolvido ao vendedor', UNDELIVERABLE: 'Não entregue', PENDING: 'Pendente', SHIPPED: 'Enviado', CANCELED: 'Cancelado', CANCELLED: 'Cancelado', UNSHIPPED: 'Não enviado', PARTIALLY_SHIPPED: 'Enviado parcialmente' };
const componentLabels = { Expenses: 'Despesas', Base: 'Base', AmazonForAllFee: 'Tarifa Amazon For All', Sales: 'Vendas', ProductCharges: 'Cobranças do produto', Principal: 'Valor do produto', Tax: 'Imposto', Shipping: 'Frete', ShippingTax: 'Imposto sobre frete', GiftWrap: 'Embalagem para presente', AmazonFees: 'Taxas Amazon', StorageBillingFee: 'Tarifa de armazenamento', AdvertisingFee: 'Publicidade', Commission: 'Comissão', ShippingChargeback: 'Desconto de frete', FBAFees: 'Taxas FBA', FBAPerUnitFulfillmentFee: 'Tarifa logística FBA', RefundCommission: 'Comissão de reembolso', Promotions: 'Promoções', PromotionalRebates: 'Descontos promocionais', Other: 'Outros', Total: 'Total', SAFETReimbursement: 'Restituição SAFE-T', ProductTax: 'Imposto do produto', MarketplaceFacilitatorTax: 'Impostos do marketplace', ShippingHB: 'Frete' };

async function api(path, options = {}) {
  const response = await fetchReadWithRetry(path, { credentials: 'same-origin', ...options });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      if (location.protocol === 'https:') {
        if (response.status === 401) location.assign('/oauth2/sign_in');
        throw Object.assign(new Error('Acesso não autorizado. Entre novamente com a conta autorizada.'), { status: response.status });
      }
      throw Object.assign(new Error('A sessão local expirou. Abra novamente o endereço fornecido ao iniciar o sistema.'), { status: response.status });
    }
    if (path.startsWith('/api/refund-management') || path === '/api/returns/manage') {
      const result = await response.json().catch(() => ({}));
      const code = typeof result.error?.code === 'string' ? result.error.code : 'REFUND_MANAGEMENT_ERROR';
      const message = typeof result.error?.message === 'string' ? result.error.message : 'Não foi possível atualizar o acompanhamento. Recarregue os dados e tente novamente.';
      throw Object.assign(new Error(message), { code, status: response.status });
    }
    if (response.status === 409 && ['/api/reviews', '/api/reviews/bulk', '/api/local-reviews', '/api/sales-alerts'].includes(path)) throw Object.assign(new Error('Este acompanhamento foi alterado em outra sessão. Atualize o painel antes de salvar novamente.'), { code: 'REVIEW_CONFLICT' });
    if (response.status === 409 && path === '/api/settings/statuses') {
      const result = await response.json().catch(() => ({}));
      const duplicate = result.error?.code === 'DUPLICATE_STATUS';
      throw Object.assign(new Error(duplicate ? 'Já existe um status com esse nome. Escolha outro nome.' : 'Este status foi alterado em outra sessão. Recarregue antes de salvar.'), { code: duplicate ? 'DUPLICATE_STATUS' : 'STATUS_CONFLICT' });
    }
    if (response.status === 400 && path === '/api/settings/statuses') throw Object.assign(new Error('Confira o nome, a cor e os menus selecionados.'), { code: 'INVALID_STATUS' });
    if (response.status === 404 && path === '/api/reviews/bulk') throw Object.assign(new Error('Um dos casos não está mais disponível.'), { code: 'BULK_NOT_FOUND' });
    throw new Error('Não foi possível carregar os dados. Tente recarregar esta página.');
  }
  return response.json();
}
function params(extra = {}) { const p = new URLSearchParams(); Object.entries({ storeId: state.storeId, from: state.from, to: state.to, ...extra }).forEach(([key, value]) => { if (value !== '' && value !== null && value !== undefined) p.set(key, value); }); return p; }
function showMessage(text, kind = '') { $('#message').innerHTML = text ? `<div class="notice ${escape(kind)}">${icon('info')}<span>${escape(text)}</span></div>` : ''; }
function empty(title, text) { return `<div class="empty-state">${icon('search')}<h2>${escape(title)}</h2><p>${escape(text)}</p></div>`; }
function badge(value, type = 'neutral') { return `<span class="badge ${type}">${escape(value)}</span>`; }
function orderStatusBadge(status) {
  const value = typeof status === 'string' ? status.trim() : '';
  if (!value) return badge('Não informado');
  const key = value.toUpperCase();
  const labels = { PENDING: 'Pagamento pendente', PENDING_AVAILABILITY: 'Pagamento pendente (pré-venda)', UNSHIPPED: 'Não enviado', PARTIALLY_SHIPPED: 'Enviado parcialmente', SHIPPED: 'Enviado', CANCELED: 'Cancelado', CANCELLED: 'Cancelado', UNFULFILLABLE: 'Não atendível' };
  const type = key === 'CANCELED' || key === 'CANCELLED' ? 'red' : key === 'PENDING' || key === 'PENDING_AVAILABILITY' ? 'amber' : key === 'SHIPPED' || key === 'PARTIALLY_SHIPPED' ? 'blue' : 'neutral';
  return badge(labels[key] || value, type);
}
function orderDisplayStatusMarkup(order) {
  const status = order.displayStatus;
  if (!status || typeof status.label !== 'string' || !status.label.trim()) return orderStatusBadge(order.status);
  const tone = ['neutral', 'good', 'amber', 'blue', 'red'].includes(status.tone) ? status.tone : 'neutral';
  const symbol = tone === 'good' ? 'check' : ['RETURNED_TO_SELLER', 'RETURNING_TO_SELLER', 'REJECTED_BY_BUYER'].includes(status.code) ? 'refund' : tone === 'red' ? 'close' : tone === 'amber' ? 'clock' : 'orders';
  return `<span class="order-display-status"><span class="status-card ${tone}" data-order-status="${escape(status.code)}"><span class="status-symbol">${icon(symbol)}</span><span class="status-label">${escape(status.label)}</span></span>${status.partial || status.code === 'MULTIPLE_PACKAGE_STATUSES' ? `<small>${escape(status.description || 'Parte dos pacotes do pedido')}</small>` : status.description ? `<span class="sr-only">${escape(status.description)}</span>` : ''}</span>`;
}
function filterCodes(value) {
  const codes = String(value || '').split(',').map(code => code.trim()).filter(Boolean);
  if (codes.some(code => code.toLowerCase() === 'all')) return [];
  return codes.filter((code, index) => codes.findIndex(other => other.toLowerCase() === code.toLowerCase()) === index);
}
function multiFilterMarkup(id, label, options, selected, knownLabels = {}, unit = 'casos') {
  const codes = filterCodes(selected), selectedKeys = new Set(codes.map(code => code.toLowerCase()));
  const rows = [], seen = new Set();
  for (const option of options || []) {
    if (typeof option.code !== 'string' || !option.code || option.code.toLowerCase() === 'all' || seen.has(option.code.toLowerCase())) continue;
    seen.add(option.code.toLowerCase()); rows.push(option);
  }
  for (const code of codes) if (!seen.has(code.toLowerCase())) rows.push({ code, label: knownLabels[code.toLowerCase()] || knownLabels[code] || code, count: 0 });
  return `<label><span class="sr-only">${escape(label)}</span><select id="${id}" aria-label="${escape(label)}" data-filter-multiple="true" data-count-unit="${escape(unit)}" multiple><option value="all" ${codes.length ? '' : 'selected'}>Todos</option>${rows.map(option => `<option value="${escape(option.code)}" data-label="${escape(option.label || option.code)}" ${selectedKeys.has(option.code.toLowerCase()) ? 'selected' : ''}>${escape(option.label || option.code)} (${number(option.count ?? 0)})</option>`).join('')}</select></label>`;
}
function selectedFilterCsv(select) { return [...select.selectedOptions].map(option => option.value).filter(code => code !== 'all').join(',') || 'all'; }
function orderStatusFilterMarkup(data) {
  return multiFilterMarkup('order-status-filter', 'Status do pedido', data.statusOptions, state.orderStatus, state.orderStatusLabels, 'pedidos');
}
function modeBadge(mode) { return badge(({ DBA: 'DBA', FBA: 'FBA', MFN: 'Envio próprio', unknown: 'Não identificado' })[mode] || 'Não identificado', mode === 'DBA' ? 'blue' : mode === 'FBA' ? 'good' : 'neutral'); }
function metric(label, value, caption, symbol, featured = false, small = false) { return `<article class="metric-card ${featured ? 'featured' : ''}"><div class="metric-top"><span class="metric-label">${label}</span><span class="metric-icon">${icon(symbol)}</span></div><div class="metric-value ${small ? 'small' : ''}">${value}</div><div class="metric-caption">${caption}</div></article>`; }
function currencyValues(rows, key) { if (!rows?.length) return '—'; return rows.map(row => `<span class="amount">${escape(money(row[key], row.currency))}</span>`).join('<br>'); }
function financialExcluded(row) {
  return [row?.financialEligibility, row?.order?.financialEligibility, row?.financial?.financialEligibility].some(eligibility => eligibility?.included === false && eligibility.reason === 'payment-pending');
}
function pendingPaymentMarkup() { return '<span class="muted">Pagamento pendente</span><small>Fora dos indicadores até a confirmação do pagamento.</small>'; }
function pendingPaymentNotice() { return `<div class="notice">${icon('clock')}<span><strong>Pagamento pendente.</strong> Fora dos indicadores até a confirmação do pagamento. Produtos, quantidades, rastreio e acompanhamento permanecem disponíveis.</span></div>`; }
function financialExclusionSummary(counts) {
  const orders = counts?.excludedPendingOrders || 0, transactions = counts?.excludedPendingTransactions || 0;
  if (!orders && !transactions) return '';
  const parts = [];
  if (orders) parts.push(`${counted(orders, 'pedido com pagamento pendente excluído', 'pedidos com pagamento pendente excluídos')} do valor dos pedidos`);
  if (transactions) parts.push(`${counted(transactions, 'lançamento vinculado excluído', 'lançamentos vinculados excluídos')} dos indicadores financeiros`);
  return `<div class="notice">${icon('clock')}<span>${parts.join('; ')}. Os valores serão considerados após a confirmação do pagamento.</span></div>`;
}
function chosenCoverage(data) { return (data?.coverage || state.bootstrap?.coverage || []).filter(c => matchesStoreSelection(state.storeId, c.storeId)); }
function coverageMarkup(data) {
  const labels = { orders: 'Pedidos', transactions: 'Financeiro', 'fba-inventory': 'Estoque FBA' };
  const seen = new Set();
  const rows = chosenCoverage(data).filter(c => { const key = `${c.storeId}|${c.source}|${c.dateBasis}|${c.from}|${c.to}|${c.status}`; if (seen.has(key)) return false; seen.add(key); return true; }).sort((a, b) => String(b.observedAt).localeCompare(String(a.observedAt)));
  const period = c => c.dateBasis === 'current-snapshot' ? `posição observada em ${escape(date(c.observedAt, true))}` : `${c.source === 'orders' && c.dateBasis === 'created' ? 'pedidos criados de ' : c.source === 'orders' && c.dateBasis === 'updated' ? 'pedidos alterados de ' : ''}${escape(date(c.from))} a ${escape(date(c.to))}`;
  return `<details class="coverage-details"><summary>Ver períodos consultados e cobertura dos dados</summary><div class="coverage-list">${rows.length ? rows.map(c => `<div><strong>${escape(labels[c.source] || c.source)}</strong> · ${period(c)} · ${c.status === 'api-pages-complete' ? `${number(c.recordsObserved)} registros consultados` : c.status === 'partial' ? 'Consulta parcial' : 'Consulta não concluída'}${isMultipleStores(state.storeId) ? ` · ${escape(storeName(c.storeId))}` : ''}</div>`).join('') : 'Nenhuma consulta registrada.'}</div></details>`;
}
function coverageNotice() { return `<div class="notice">${icon('info')}<span><strong>Base inicial em conferência.</strong> Os resultados consideram apenas as consultas já importadas. O histórico desde janeiro e a conciliação com o Seller Central ainda estão pendentes.</span></div>`; }
function storeName(id) { return state.bootstrap?.stores?.find(s => s.storeId === id)?.name || id; }
function updateSync(data) {
  if (!state.storeId || !selectedCollectionTimes) return;
  const times = selectedCollectionTimes([...(state.bootstrap?.coverage || []), ...(data?.coverage || [])], state.storeId, state.bootstrap?.stores || []);
  const label = times.count === 1 ? 'Última coleta da loja' : 'Coletas das lojas selecionadas';
  const range = times.from ? `${date(times.from, true)}${times.from !== times.to ? ` a ${date(times.to, true)}` : ''}` : 'Nenhuma coleta concluída';
  $('#last-sync').textContent = `${label}: ${range}${times.missing && times.from ? ` · ${times.missing} loja(s) sem coleta` : ''}`;
  $('#last-sync').title = 'Coletas importadas das lojas selecionadas. O saldo financeiro tem a própria data de consulta no card.';
}
function chartMarkup(daily) {
  const rows = (daily || []).filter(x => x.currency === 'BRL' && /^-?\d+$/.test(String(x.netCents))).sort((a, b) => a.date.localeCompare(b.date));
  if (!rows.length) return empty('Sem lançamentos neste período', 'Amplie as datas ou confira os períodos já consultados abaixo.');
  // Number is used only for drawing proportions. All displayed and stored money uses integer cents.
  const values = rows.map(row => Number(BigInt(row.netCents)) / 100);
  if (values.some(value => !Number.isFinite(value))) return '<p class="footnote">Consulte os valores detalhados ao lado.</p>';
  const max = Math.max(1, ...values), min = Math.min(0, ...values), width = 620, height = 240, left = 66, top = 14, bottom = 202, right = 606;
  const y = value => top + (max - value) / (max - min) * (bottom - top);
  const step = (right - left) / rows.length, barWidth = Math.min(36, step * .53);
  const ticks = [max, (max + min) / 2, min];
  const tickText = v => new Intl.NumberFormat('pt-BR', { notation: Math.abs(v) > 999 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(v);
  return `<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Líquido de lançamentos por dia em reais">${ticks.map(t => `<line class="grid-line" x1="${left}" x2="${right}" y1="${y(t)}" y2="${y(t)}"/><text x="${left - 12}" y="${y(t) + 4}" text-anchor="end">${escape(tickText(t))}</text>`).join('')}<line class="zero-line" x1="${left}" x2="${right}" y1="${y(0)}" y2="${y(0)}"/>${rows.map((row, i) => { const value = values[i], bx = left + step * i + (step - barWidth) / 2; return `<rect class="${value < 0 ? 'bar-negative' : 'bar-positive'}" x="${bx}" y="${Math.min(y(0), y(value))}" width="${barWidth}" height="${Math.max(1, Math.abs(y(value) - y(0)))}" rx="3"><title>${escape(`${row.date.split('-').reverse().join('/')}: ${money(row.netCents, row.currency)}`)}</title></rect>${rows.length < 13 || i % Math.ceil(rows.length / 8) === 0 ? `<text x="${bx + barWidth / 2}" y="227" text-anchor="middle">${escape(row.date.slice(5).split('-').reverse().join('/'))}</text>` : ''}`; }).join('')}</svg><div class="chart-caption"><span>Valores em R$ · por data de lançamento</span><span>Repasses separados</span></div>`;
}
function platformExpenseCards(data) {
  const expenses = data.platformExpenses;
  if (!expenses) return '';
  const values = expenses.byCurrency || [], counts = expenses.counts || {};
  const caption = (count, unknownKey) => `${counted(count, 'lançamento', 'lançamentos')} · por data do lançamento${values.some(row => row[unknownKey] > 0) ? ' · há valores não informados' : ''}`;
  return `<section class="metric-grid platform-expenses" aria-label="Despesas da operação">${metric('Armazenamento FBA', currencyValues(values, 'fbaStorageCents'), caption(counts.fbaStorage, 'unknownStorageCount'), 'inventory', false, values.length > 1)}${metric('Publicidade (ADS)', currencyValues(values, 'adsCents'), caption(counts.ads, 'unknownAdsCount'), 'money', false, values.length > 1)}</section><p class="footnote">ADS e armazenamento ficam separados do faturamento líquido. Os custos dos produtos e o resultado por venda estão disponíveis em Pedidos, conforme os vínculos do estoque.</p>`;
}
function sectionHeading(index, title, hint = '') {
  return `<div class="section-heading"><span class="section-number" aria-hidden="true">${index}</span><h2>${escape(title)}</h2>${hint ? `<span class="section-hint">${escape(hint)}</span>` : ''}</div>`;
}
function currentBalancesMarkup(data, inventory) {
  const balance = data.accountBalance || {}, values = balance.byCurrency || [];
  const observed = (balance.stores || []).map(store => store.observedAt).filter(Boolean).sort();
  const available = ['complete', 'stale'].includes(balance.state);
  const balanceValue = available ? values.length ? currencyValues(values, 'totalCents') : 'Nenhum saldo registrado' : 'Saldo não disponível';
  const balanceCaption = available ? `Consultado em ${date(observed[0], true)}${balance.state === 'stale' ? ' · atualização pendente' : ''}` : 'Aguardando consulta completa dos ciclos e valores adiados';
  const summary = inventorySummary(inventory);
  const composition = available && values.length ? `<dl class="balance-composition"><div><dt>Ciclos em aberto</dt><dd>${currencyValues(values, 'openCents')}</dd></div><div><dt>Transações adiadas</dt><dd>${currencyValues(values, 'deferredCents')}</dd></div></dl>` : '';
  const balanceCard = metric('Saldo total na Amazon', balanceValue, balanceCaption, 'money', true, !available || values.length > 1).replace('</article>', `${composition}</article>`);
  const stockCard = `<article class="metric-card fba-balance-card"><div class="metric-top"><span class="metric-label">Estoque FBA · Total Amazon apto</span><span class="metric-icon">${icon('inventory')}</span></div><button type="button" class="fba-stock-total" data-open-fba-stock aria-label="Ver produtos e quantidades do estoque FBA"><strong>${number(summary.usableQuantity)}</strong><span>unidades</span>${icon('arrow')}</button><div class="fba-stock-counts"><span>Disponíveis <strong>${number(summary.fulfillableQuantity)}</strong></span><span>Reservadas <strong>${number(summary.reservedQuantity)}</strong></span><span>Em entrada <strong>${number(summary.inboundQuantity)}</strong></span><span>Indisponíveis <strong>${number(summary.unfulfillableQuantity)}</strong></span></div><div class="fba-cost-line"><span>Valor a preço de custo</span><strong>${stockCostSummary(inventory?.costSummary)}</strong></div><div class="metric-caption">Clique nas unidades para ver os produtos e seus custos</div></article>`;
  return `<section class="current-balances" aria-label="Saldos atuais">${sectionHeading('01', 'Posição atual', 'Saldo e estoque · independentes do período')}<div class="metric-grid balance-cards">${balanceCard}${stockCard}</div><details class="balance-explainer"><summary>Como interpretar o saldo e o estoque</summary><p class="footnote">Saldo total = ciclos em aberto + transações adiadas consultadas desde ${escape(date((balance.stores || []).map(store => store.deferredFrom).filter(Boolean).sort()[0]))}. Valores adiados ainda não estão disponíveis para repasse. O total FBA é o informado pela Amazon; suas categorias podem se sobrepor.</p></details></section>`;
}

let fbaStockRequest = 0;
async function openFbaStock() {
  const dialog = $('#fba-stock-dialog'), body = $('#fba-stock-detail'), request = ++fbaStockRequest;
  const storeId = state.storeId;
  body.innerHTML = '<div class="loading-state">Carregando estoque FBA…</div>';
  if (!dialog.open) dialog.showModal();
  try {
    let data, offset = 0; const items = [];
    do {
      data = await api(`/api/inventory?${new URLSearchParams({storeId,limit:'500',offset:String(offset)})}`);
      if (!dialog.open || request !== fbaStockRequest) return;
      if (data.hasMore && !data.items?.length) throw new Error('INCOMPLETE_INVENTORY');
      items.push(...(data.items || [])); offset += data.items?.length || 0;
    } while (data.hasMore);
    const summary = inventorySummary(data);
    body.innerHTML = `<div class="fba-stock-summary"><div><strong>${number(summary.usableQuantity)} unidades</strong><span>${number(items.length)} SKUs · ${escape(storeSelectionLabel(storeId))}</span></div><span>Consultado em ${escape(date(data.observationRange?.to,true))}</span></div>${inventoryCoverageNotice(data)}<label class="search-box fba-stock-search">${icon('search')}<span class="sr-only">Pesquisar no estoque FBA</span><input id="fba-stock-search" type="search" placeholder="Pesquisar produto, SKU ou ASIN" aria-label="Pesquisar no estoque FBA"></label><div id="fba-stock-list"></div><p class="footnote">Total apto: disponível + entrada + transferência e processamento. Reservas de pedidos, indisponíveis e unidades em investigação ficam fora desse saldo. O total original da Amazon continua detalhado por produto.</p>`;
    const render = () => {
      const query = $('#fba-stock-search').value.trim().toLocaleLowerCase('pt-BR');
      const selected = items.filter(item => !query || [item.title,item.sellerSku,item.asin].some(value => String(value || '').toLocaleLowerCase('pt-BR').includes(query)))
        .sort((a,b) => (b.totalQuantity ?? -1)-(a.totalQuantity ?? -1) || String(a.sellerSku).localeCompare(String(b.sellerSku)));
      $('#fba-stock-list').innerHTML = `<div class="table-scroll"><table><thead><tr><th>Produto / SKU</th><th class="numeric">Disponível</th><th class="numeric">Reservado</th><th class="numeric">Em entrada</th><th class="numeric">Indisponível</th><th class="numeric">Total Amazon apto</th><th>Custo do estoque</th></tr></thead><tbody>${selected.map(item => { const d = item.inventoryDetails || {}, inbound = [d.inboundWorkingQuantity,d.inboundShippedQuantity,d.inboundReceivingQuantity]; return `<tr><td class="product-cell"><strong>${escape(item.title || item.sellerSku || 'Produto sem descrição')}</strong><small>SKU: ${escape(item.sellerSku || 'Não informado')} · ASIN: ${inventoryAsinLink(item.asin, 'Não informado')}</small>${isMultipleStores(storeId) ? `<small>${escape(storeName(item.storeId))}</small>` : ''}</td><td class="numeric">${qty(d.fulfillableQuantity,true)}</td><td class="numeric">${qty(d.reservedQuantity?.totalReservedQuantity)}</td><td class="numeric">${qty(inbound.every(Number.isSafeInteger) ? inbound.reduce((a,b)=>a+b,0) : null)}</td><td class="numeric">${qty(d.unfulfillableQuantity?.totalUnfulfillableQuantity)}</td><td class="numeric"><strong>${qty(inventoryQuantities(item).usableQuantity)}</strong></td><td class="product-cost-cell">${productCostMarkup(item.cost, true)}</td></tr>`; }).join('') || '<tr><td colspan="7">Nenhum produto encontrado.</td></tr>'}</tbody></table></div>`;
      prepareTables($('#fba-stock-list')); layout.paginateNodes($('#fba-stock-list'), 'tbody tr', 5);
    };
    $('#fba-stock-search').addEventListener('input',render); render();
  } catch {
    if (dialog.open && request === fbaStockRequest) body.innerHTML = '<p class="notice error">Não foi possível carregar o estoque. Feche e tente novamente.</p>';
  }
}

function dashboardMarkup(data, inventory) {
  const counts = data.counts || {}, financial = data.financeByCurrency || [], revenue = data.salesRevenue || {};
  const gross = revenue.grossByCurrency || [], net = revenue.netByCurrency || [];
  const cardCount = (value, label) => `<span class="metric-count"><strong>${number(value || 0)}</strong> ${escape(label)}</span>`;
  const txRows = (data.byType || []).filter(row => String(row.type).toLowerCase() !== 'transfer');
  return `${currentBalancesMarkup(data, inventory)}<section class="dashboard-section" aria-label="Resultado do período">${sectionHeading('02', 'Resultado do período', `${date(state.from)} a ${date(state.to)}`)}<div class="metric-grid period-metrics" aria-label="Indicadores do período">
    ${metric('Faturamento bruto', currencyValues(gross, 'grossCents'), `${cardCount(revenue.orderCount, 'pedidos')}Valor das mercadorias vendidas${revenue.missingGrossOrderCount ? `<br>${number(revenue.missingGrossOrderCount)} pedidos com valor da mercadoria pendente` : ''}`, 'orders', false, gross.length > 1)}
    ${metric('Faturamento líquido', currencyValues(net, 'netCents'), `${cardCount(revenue.netOrderCount, 'pedidos com lançamentos')}Taxas e frete descontados${revenue.missingNetOrderCount ? `<br>${number(revenue.missingNetOrderCount)} pedidos com líquido ainda não identificado` : ''}${revenue.unclassifiedFeeCount ? `<br>${number(revenue.unclassifiedFeeCount)} cobranças a identificar não incluídas` : ''}`, 'money', true, net.length > 1)}
    ${metric('Reembolsos', currencyValues(financial, 'refundCents'), `${cardCount(counts.refunds, 'reembolsos')}${number(counts.refundedOrders || 0)} pedidos vinculados · impacto líquido dos reembolsos`, 'refund', false, financial.length > 1)}
    ${metric('Movimentos de repasse', currencyValues(financial, 'transferCents'), 'Registro Amazon · conferir crédito no banco', 'transfer', false, financial.length > 1)}
  </div>
  <p class="footnote">Faturamento dos pedidos criados no período. O líquido usa os lançamentos conhecidos dessas vendas, inclusive valores a liberar, e não desconta reembolsos, ADS ou armazenamento. Reembolsos e demais despesas seguem a data do lançamento.</p>
  ${platformExpenseCards(data)}</section>
  <section class="dashboard-section" aria-label="Detalhamento financeiro">${sectionHeading('03', 'Detalhamento financeiro', 'Explore a composição dos valores')}<div class="two-column"><section class="panel"><div class="panel-head"><div><h2>Movimentação no período</h2><p>Líquido de vendas, reembolsos, cobranças e ajustes</p></div><span class="legend"><i class="legend-dot"></i>Líquido diário</span></div><div class="panel-body">${chartMarkup(data.daily)}</div></section>
  <section class="panel"><div class="panel-head"><div><h2>Composição financeira</h2></div></div><div class="panel-body">${txRows.length ? txRows.map(row => compositionButton(txLabels[row.type] || row.type, amount(row.totalCents, row.currency), { bucket: 'type', type: row.type, currency: row.currency, count: row.count })).join('') : '<p class="footnote">Nenhum lançamento importado para o período.</p>'}
    ${compositionButton('Líquido registrado', currencyValues(financial, 'netCents'), { bucket: 'net', total: true })}
    ${financial.map(row => `${compositionButton('Lançamentos liberados', amount(row.releasedCents, row.currency), { bucket: 'released', currency: row.currency })}${compositionButton('Lançamentos diferidos', amount(row.deferredCents, row.currency), { bucket: 'deferred', currency: row.currency })}`).join('')}
    <p class="footnote">Os valores usam o último estado conhecido de cada lançamento. Não representam o saldo disponível da conta nem a confirmação de depósito bancário.</p></div></section></div></section>
  <section class="panel"><div class="panel-head"><div><h2>Pedidos e integração de custos</h2><p>Pedidos criados dentro do período selecionado</p></div><button class="text-link" data-go="orders">Ver pedidos ${icon('arrow')}</button></div><div class="panel-body"><div class="health-grid"><div class="health-cell"><span>Pedidos</span><strong>${number(counts.orders ?? 0)}</strong><small>Na base importada</small></div><div class="health-cell"><span>Sem valor de venda</span><strong>${number(counts.ordersWithoutTotal ?? 0)}</strong><small>Informação pendente</small></div><div class="health-cell"><span>Custos dos produtos</span><strong>Estoque Origem</strong><small>Consulte o custo e o resultado em cada pedido</small></div></div><p class="footnote">Cada pedido conserva o custo registrado para sua venda; os pedidos antigos usam a base inicial da integração. Produtos sem correspondência ficam com custo pendente.</p></div></section><details class="data-explainer"><summary>Sobre os dados · cobertura, custos e pagamentos pendentes</summary>${coverageNotice()}${financialExclusionSummary(counts)}${coverageMarkup(data)}</details>`;
}
function compositionButton(label, value, { bucket, type, currency, count, total = false }) {
  return `<button type="button" class="breakdown-row composition-trigger ${total ? 'breakdown-total' : ''}" data-composition-bucket="${bucket}" ${type ? `data-composition-type="${escape(type)}"` : ''} ${currency ? `data-composition-currency="${escape(currency)}"` : ''} data-composition-label="${escape(label)}" aria-label="Ver lançamentos: ${escape(label)}${currency ? ` (${escape(currency)})` : ''}"><span class="breakdown-name">${type ? `<i class="type-dot ${({ Shipment: 'shipment', Refund: 'refund', ServiceFee: 'fee', Adjustment: 'adjustment' })[type] || ''}"></i>` : ''}<span>${escape(label)}${count !== undefined ? `<small>${counted(count, 'lançamento', 'lançamentos')}</small>` : ''}</span></span><span class="composition-row-value"><strong>${value}</strong>${icon('arrow')}</span></button>`;
}

let compositionSelection = null, compositionRequest = 0;
function compositionItemsMarkup(data, selected) {
  const period = selected.from || selected.to ? `${selected.from ? date(`${selected.from}T12:00:00-03:00`) : 'Início'} até ${selected.to ? date(`${selected.to}T12:00:00-03:00`) : 'hoje'}` : 'Todo histórico';
  return `<div class="composition-scope"><span>${escape(selected.storeLabel)} · ${escape(period)}</span><small>Por data do lançamento · horário de Brasília</small></div><div class="composition-summary"><span>${counted(data.total, 'lançamento', 'lançamentos')}</span><strong>${data.totals?.length ? currencyValues(data.totals, 'totalCents') : selected.currency ? amount('0', selected.currency) : '—'}</strong></div>${data.items?.length ? `<div class="composition-columns" aria-hidden="true"><span>Data</span><span>Pedido / situação</span><span>Tipo</span><span>Valor</span><span></span></div><div class="composition-entries">${data.items.map(tx => `<details class="composition-entry"><summary><span>${escape(date(tx.postedAt, true))}</span><span>${tx.orderIds?.length ? tx.orderIds.map(id => escape(id)).join('<br>') : 'Sem pedido vinculado'}<small>${escape(statusLabels[tx.status] || tx.status || 'Situação não informada')}${selected.storeId === 'all' ? ` · ${escape(storeName(tx.storeId))}` : ''}</small></span><span>${escape(txLabels[tx.type] || tx.type || 'Lançamento')}</span>${amount(tx.totalCents, tx.currency)}<span class="composition-chevron">${icon('chevron')}</span></summary><div class="composition-entry-body">${tx.linkedOrders?.length ? `<div class="composition-orders">${tx.linkedOrders.map(order => `${order.available ? `<button type="button" class="button compact" data-composition-order="${escape(order.orderId)}" data-store="${escape(tx.storeId)}">Ver pedido ${escape(order.orderId)}</button>` : `<span>${escape(order.orderId)} · pedido ainda não importado</span>`}<button type="button" class="copy-order composition-copy" data-copy-order="${escape(order.orderId)}" data-store="${escape(tx.storeId)}" aria-label="Copiar número do pedido ${escape(order.orderId)}">${icon('copy')}<span>Copiar pedido</span></button>`).join('')}</div>` : ''}${tx.orderIds?.length > 1 ? '<p class="detail-info">Lançamento vinculado a vários pedidos; valor total sem rateio.</p>' : ''}${transactionNotice(tx)}${tx.breakdowns?.length ? `<h3>Composição do lançamento</h3>${tree(tx.breakdowns)}` : '<p class="detail-info">Sem componentes detalhados informados pela Amazon.</p>'}${tx.items?.length ? `<details class="composition-item-details"><summary>Detalhamento por item</summary>${tx.items.map(item => `<div class="detail-product"><span>${escape(item.sku || item.asin || 'Item sem identificador')}</span>${amount(item.totalCents, item.currency)}</div>${tree(item.breakdowns)}`).join('')}</details>` : ''}<p class="transaction-id">Identificador: ${escape(tx.transactionId)}</p></div></details>`).join('')}</div>` : '<p class="detail-info">Nenhum lançamento compõe esse valor no período selecionado.</p>'}<div class="composition-pagination"><span>${data.total ? `${number(data.offset + 1)}–${number(data.offset + data.items.length)} de ${number(data.total)}` : '0 lançamentos'}</span><div><button type="button" class="button compact" data-composition-page="${Math.max(0, data.offset - data.limit)}" ${data.offset === 0 ? 'disabled' : ''}>Anterior</button><button type="button" class="button compact" data-composition-page="${data.offset + data.limit}" ${data.hasMore ? '' : 'disabled'}>Próxima</button></div></div>`;
}
async function loadCompositionPage(offset = 0) {
  const selected = compositionSelection, dialog = $('#composition-dialog'), request = ++compositionRequest;
  if (!selected) return;
  selected.offset = offset;
  const body = $('#composition-detail');
  body.innerHTML = '<div class="loading-state"><span class="spinner"></span>Carregando lançamentos…</div>';
  body.setAttribute('aria-busy', 'true');
  const query = new URLSearchParams(selected.query); query.set('limit', '6'); query.set('offset', String(offset));
  try {
    const data = await api(`/api/dashboard/transactions?${query}`);
    if (!dialog.open || request !== compositionRequest) return;
    body.innerHTML = compositionItemsMarkup(data, selected);
    body.querySelectorAll('[data-composition-page]').forEach(button => button.addEventListener('click', () => loadCompositionPage(Number(button.dataset.compositionPage))));
    body.querySelectorAll('[data-copy-order]').forEach(button => button.addEventListener('click', () => copyOrderNumber(button)));
    body.querySelectorAll('[data-composition-order]').forEach(button => button.addEventListener('click', () => openOrder(button.dataset.store, button.dataset.compositionOrder)));
    body.scrollTop = 0;
  } catch {
    if (!dialog.open || request !== compositionRequest) return;
    body.innerHTML = '<p class="notice error">Não foi possível carregar os lançamentos.</p><button type="button" class="button" id="retry-composition">Tentar novamente</button>';
    $('#retry-composition').addEventListener('click', () => loadCompositionPage(offset));
  } finally { if (request === compositionRequest) body.removeAttribute('aria-busy'); }
}
function openComposition(button) {
  const { compositionBucket: bucket, compositionType: type, compositionCurrency: currency, compositionLabel: label } = button.dataset;
  compositionSelection = { query: params({ bucket, type, currency }).toString(), storeId: state.storeId,
    storeLabel: storeSelectionLabel(), from: state.from, to: state.to, currency };
  $('#composition-title').textContent = label;
  const dialog = $('#composition-dialog'); if (!dialog.open) dialog.showModal();
  loadCompositionPage();
}

function getOrderFinancial(order) { return financialExcluded(order) ? [] : order.financial?.byCurrency || []; }
function reviewLabel(status, _kind) { return reviewDefinition(status)?.label || reviewStatusLabels[status] || status || 'Não informado'; }
function reviewBadge(review, kind) {
  const definition = reviewDefinition(review?.status), color = review?.color || definition?.color;
  return colorBadge(review?.label || definition?.label || reviewLabel(review?.status, kind), color);
}
function localReviewFilterMarkup(data, menu) {
  const options = data.reviewStatusOptions || [];
  const missing = state.reviewStatus !== 'all' && !options.some(option => option.code === state.reviewStatus);
  return `<label><span class="sr-only">Status da análise</span><select id="local-review-filter" aria-label="Status da análise" data-count-unit="registros"><option value="all">Todos os status da análise</option>${options.map(option => `<option value="${escape(option.code)}" data-label="${escape(option.label || reviewLabel(option.code, menu))}" ${state.reviewStatus === option.code ? 'selected' : ''}>${escape(option.label || reviewLabel(option.code, menu))} (${number(option.count)})</option>`).join('')}${missing ? `<option value="${escape(state.reviewStatus)}" data-label="${escape(state.reviewStatusLabel || reviewLabel(state.reviewStatus, menu))}" selected>${escape(state.reviewStatusLabel || reviewLabel(state.reviewStatus, menu))} (0)</option>` : ''}</select></label>`;
}
function localReviewButton(menu, storeId, entityId) { return menu === 'orders' ? '' : `<button class="button compact" type="button" data-local-review="${escape(entityId)}" data-review-menu="${escape(menu)}" data-store="${escape(storeId)}">Gerenciar</button>`; }
function localReviewSummary(row, menu, entityId, { compact = false } = {}) {
  if (compact) return `<section class="detail-section return-review-summary"><div class="return-review-heading"><h3>Status da análise</h3>${reviewBadge(row.review, menu)}</div>${localReviewButton(menu, row.storeId, entityId)}<p class="detail-info">${row.review?.notes ? escape(row.review.notes).replace(/\n/g, '<br>') : 'Sem anotações disponíveis.'}</p></section>${row.reviewHistory?.length ? financialReviewHistory(row, menu) : ''}`;
  return `<section class="detail-section"><h3>Status da análise</h3>${reviewBadge(row.review, menu)}<p class="detail-info">${row.review?.notes ? escape(row.review.notes).replace(/\n/g, '<br>') : 'Sem anotações disponíveis.'}</p>${localReviewButton(menu, row.storeId, entityId)}</section>${Array.isArray(row.reviewHistory) ? financialReviewHistory(row, menu) : ''}`;
}
function statusEditorMarkup(status) {
  const menus = new Set(status?.menus || []);
  const hex = validReviewHex(status?.color) ? status.color.toLowerCase() : reviewColorHex[status?.color] || reviewColorHex.neutral;
  return `<div class="panel-head"><div><h2>${status ? 'Editar status' : 'Novo status'}</h2><p>Escolha o nome, a cor e onde o status será usado.</p></div></div><div class="panel-body"><div id="status-editor-message" role="status" aria-live="polite"></div><form id="status-settings-form" class="case-review-form status-settings-form"><label for="status-name">Nome do status<input id="status-name" maxlength="60" required value="${escape(status?.label || '')}" autocomplete="off"></label><div class="status-color-field"><label for="status-color">Cor</label><div class="status-color-controls"><input type="color" id="status-color" value="${hex}" aria-label="Abrir paleta de cores"><label for="status-color-hex"><span class="sr-only">Código hexadecimal da cor</span><input type="text" id="status-color-hex" value="${hex.toUpperCase()}" maxlength="7" pattern="#[0-9a-fA-F]{6}" required spellcheck="false" autocomplete="off" aria-describedby="status-color-help"></label></div><small id="status-color-help">Escolha na paleta ou informe #RRGGBB.</small></div><div class="status-preview">Prévia: <span id="status-preview" class="badge">${escape(status?.label || 'Nome do status')}</span></div><fieldset class="status-menu-choices"><legend>Menus</legend>${reviewSettings.menus.filter(menu => menu.code !== 'refunds').map(menu => `<label><input type="checkbox" name="status-menu" value="${escape(menu.code)}" ${menus.has(menu.code) ? 'checked' : ''}>${escape(menu.label)}</label>`).join('')}</fieldset><label class="status-check"><input id="status-active" type="checkbox" ${status?.active !== false ? 'checked' : ''}>Status ativo</label><p class="detail-info">Desativar impede novas seleções e preserva o status nos registros que já o utilizam.</p><label class="status-check"><input id="status-closes-case" type="checkbox" ${status?.closesCase ? 'checked' : ''}>Conclui o acompanhamento</label><p class="detail-info">O acompanhamento é interno. A situação do pedido e da devolução na Amazon permanece separada.</p><button class="button primary" type="submit" id="save-status-settings">${status ? 'Salvar alterações' : 'Cadastrar status'}</button></form></div>`;
}
function settingsMarkup() {
  return `${productLinksSettingsModule?.productLinksSettingsMarkup() || ''}<section class="panel"><div class="panel-head"><div><h2>Status de acompanhamento</h2><p>Configuração compartilhada entre as lojas, nos menus selecionados.</p></div><button class="button compact" type="button" id="new-review-status">Novo status</button></div><div class="table-scroll"><table><thead><tr><th>Status</th><th>Menus</th><th>Disponibilidade</th><th>Acompanhamento</th><th>Ação</th></tr></thead><tbody>${reviewSettings.items.map(status => `<tr><td>${colorBadge(status.label, status.color)}</td><td>${escape((status.menus || []).map(code => code === 'refunds' ? 'Histórico antigo de reembolsos' : reviewSettings.menus.find(menu => menu.code === code)?.label || code).join(' · ') || 'Nenhum menu')}</td><td>${status.automatic ? 'Automático' : status.active ? 'Ativo' : 'Desativado'}</td><td>${status.automatic ? 'Indicador de pagamento' : status.closesCase ? 'Conclui o acompanhamento' : 'Em andamento'}</td><td>${status.readOnly ? '<span class="muted">Identificado pelos lançamentos</span>' : `<button class="button compact" type="button" data-edit-status="${escape(status.code)}">Editar</button>`}</td></tr>`).join('')}</tbody></table></div><p class="footnote">Em Gerenciar reembolsos, mudar o status mantém o caso na fila. Use Finalizar para encerrar o acompanhamento.</p></section><section class="panel status-editor-panel" id="status-editor">${statusEditorMarkup(null)}</section>`;
}
function bindStatusSettingsForm(status = null) {
  const form = $('#status-settings-form'); if (!form) return;
  let selectedColor = status?.color || 'neutral';
  const picker = $('#status-color'), hexInput = $('#status-color-hex');
  const preview = () => { $('#status-preview').textContent = $('#status-name').value.trim() || 'Nome do status'; applyReviewColor($('#status-preview'), selectedColor); };
  const chooseColor = () => { selectedColor = picker.value.toLowerCase(); hexInput.value = selectedColor.toUpperCase(); hexInput.setCustomValidity(''); preview(); };
  picker.addEventListener('input', chooseColor); picker.addEventListener('change', chooseColor);
  hexInput.addEventListener('input', () => {
    const value = hexInput.value.trim();
    hexInput.setCustomValidity(validReviewHex(value) ? '' : 'Informe uma cor no formato #RRGGBB, como #7C3AED.');
    if (validReviewHex(value)) { selectedColor = value.toLowerCase(); picker.value = selectedColor; preview(); }
  });
  hexInput.addEventListener('blur', () => { if (validReviewHex(hexInput.value.trim())) hexInput.value = hexInput.value.trim().toUpperCase(); });
  $('#status-name').addEventListener('input', preview);
  preview();
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const label = $('#status-name').value.trim(), color = selectedColor, active = $('#status-active').checked;
    const menus = [...new Set([...form.querySelectorAll('[name="status-menu"]:checked')].map(input => input.value).concat((status?.menus || []).filter(code => code === 'refunds')))];
    const expectedVersion = status?.version ?? 0;
    if (!label || label.length > 60 || (!Object.hasOwn(reviewColors, color) && !validReviewHex(color)) || !validReviewHex(hexInput.value) || (active && !menus.length) || !Number.isSafeInteger(expectedVersion)) {
      $('#status-editor-message').innerHTML = '<p class="inline-warning">Informe um nome de até 60 caracteres e selecione ao menos um menu para um status ativo.</p>'; return;
    }
    const input = { ...(status ? { code: status.code } : {}), label, color, menus, active, closesCase: $('#status-closes-case').checked, expectedVersion };
    for (const control of form.elements) control.disabled = true;
    $('#save-status-settings').textContent = 'Salvando…';
    try {
      const result = await api('/api/settings/statuses', { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': state.csrf }, body: JSON.stringify(input) });
      rememberReviewSettings(result.settings);
      if (state.view === 'settings') { $('#content').innerHTML = settingsMarkup(); bindContent(); showMessage('Status salvo. Os registros mantêm seu histórico.'); }
    } catch (error) {
      if (state.view !== 'settings' || !form.isConnected) return;
      for (const control of form.elements) control.disabled = false;
      $('#save-status-settings').textContent = status ? 'Salvar alterações' : 'Cadastrar status';
      const conflict = error.code === 'STATUS_CONFLICT';
      $('#save-status-settings').disabled = conflict;
      $('#status-editor-message').innerHTML = `<p class="inline-warning">${escape(error.message)}${conflict ? ' Sua edição continua no formulário. Recarregar substituirá os campos pela versão mais recente.' : ''}</p>${conflict ? '<button class="button compact" type="button" id="reload-status-editor">Recarregar status</button>' : ''}`;
      $('#reload-status-editor')?.addEventListener('click', () => openStatusEditor(status?.code));
    }
  });
}
let statusEditorRequest = 0;
async function openStatusEditor(code) {
  const request = ++statusEditorRequest;
  const editor = $('#status-editor'); if (!editor) return;
  editor.innerHTML = '<div class="loading-state"><span class="spinner"></span>Carregando status…</div>';
  try {
    await refreshReviewSettings(); if (request !== statusEditorRequest || state.view !== 'settings' || !editor.isConnected) return;
    const status = code ? reviewDefinition(code) : null;
    if (code && !status) throw new Error('O status não está disponível. Recarregue as configurações.');
    if (status?.readOnly || status?.automatic) throw new Error('Este indicador é atualizado pelos lançamentos e não pode ser editado manualmente.');
    editor.innerHTML = statusEditorMarkup(status); bindStatusSettingsForm(status); layout.revealSection(editor); $('#status-name').focus({ preventScroll: true }); editor.scrollIntoView({ block: 'nearest' });
  } catch (error) { if (request === statusEditorRequest && editor.isConnected) editor.innerHTML = `<div class="notice error">${escape(error.message)}</div>`; }
}
function bindSettings() {
  $('#new-review-status')?.addEventListener('click', () => openStatusEditor());
  $('#content').querySelectorAll('[data-edit-status]').forEach(button => button.addEventListener('click', () => openStatusEditor(button.dataset.editStatus)));
  bindStatusSettingsForm();
}
let localReviewSelection = null, localReviewRequest = 0;
function bindLocalReviewButtons(root) {
  applyReviewColors(root);
  root.querySelectorAll('[data-local-review]').forEach(button => button.addEventListener('click', () => openLocalReview(button.dataset.reviewMenu, button.dataset.store, button.dataset.localReview)));
}
async function openLocalReview(menu, storeId, entityId, message = '') {
  if (!['returns', 'customer-returns'].includes(menu)) return;
  if (menu === 'returns') {
    returnedManagementModule ||= await loadScreenModule('/returned-management.js');
    for (const id of ['order-dialog', 'customer-return-dialog']) if ($(`#${id}`).open) $(`#${id}`).close();
    try {
      const data = await api(`/api/returns?${new URLSearchParams({ storeId, query: entityId, workflow: 'all', limit: '500' })}`);
      const row = data.items.find(item => item.storeId === storeId && item.orderId === entityId);
      if (row) returnedManagementModule.openReturnedAction('edit', [row], data.reviewStatuses, { api, csrf: state.csrf, reload: loadView, afterSave: savedViewRefresh(), showMessage });
    } catch (error) { showMessage(error.message, 'warning'); }
    return;
  }
  for (const id of ['order-dialog', 'customer-return-dialog']) if ($(`#${id}`).open) $(`#${id}`).close();
  const request = ++localReviewRequest, dialog = $('#local-review-dialog');
  localReviewSelection = { menu, storeId, entityId, request, saving: false, conflict: false };
  $('#local-review-title').textContent = `Gerenciar · ${reviewSettings.menus.find(item => item.code === menu)?.label || titles[menu]}`;
  $('#local-review-detail').innerHTML = '<div class="loading-state"><span class="spinner"></span>Carregando acompanhamento…</div>';
  if (!dialog.open) dialog.showModal();
  try {
    const [data] = await Promise.all([api(`/api/local-reviews?${new URLSearchParams({ menu, storeId, entityId })}`), refreshReviewSettings()]);
    if (!dialog.open || request !== localReviewRequest) return;
    if (data.menu !== menu || data.storeId !== storeId || data.entityId !== entityId) throw new Error('Resposta de acompanhamento inválida.');
    localReviewSelection.data = data;
    const review = data.review || {}, validVersion = Number.isSafeInteger(review.version) && review.version >= 0;
    $('#local-review-detail').innerHTML = `<div class="detail-meta"><span>${escape(storeName(storeId))}</span>${reviewBadge(review, menu)}</div><p class="detail-info">${escape(data.orderId ? `Pedido ${data.orderId}` : menu === 'customer-returns' ? 'Devolução selecionada' : `Pedido ${entityId}`)}</p><p class="detail-info">Acompanhamento interno. Não altera a situação na Amazon nem envia solicitações.</p><div id="local-review-message" role="status" aria-live="polite">${message ? `<p>${escape(message)}</p>` : ''}</div><form id="local-review-form" class="case-review-form"><label for="local-review-status">Status da análise<select id="local-review-status" required>${reviewOptionsMarkup(menu, review)}</select></label><label for="local-review-notes">Anotações<textarea id="local-review-notes" rows="6" maxlength="2000">${escape(review.notes || '')}</textarea></label><p class="detail-info">Até 2.000 caracteres.</p><button class="button primary" id="save-local-review" type="submit" ${validVersion ? '' : 'disabled'}>Salvar acompanhamento</button></form>${validVersion ? '' : '<p class="inline-warning">Recarregue o acompanhamento antes de editar.</p>'}${financialReviewHistory(data, menu)}`;
    applyReviewColors($('#local-review-detail'));
    $('#local-review-form').addEventListener('submit', saveLocalReview);
  } catch (error) { if (dialog.open && request === localReviewRequest) $('#local-review-detail').innerHTML = `<div class="notice error">${escape(error.message)}</div>`; }
}
async function saveLocalReview(event) {
  event.preventDefault();
  const selected = localReviewSelection, form = event.currentTarget;
  if (!selected?.data || selected.saving || selected.conflict) return;
  const status = $('#local-review-status').value, notes = $('#local-review-notes').value, expectedVersion = selected.data.review?.version;
  if (!reviewChoiceValid(selected.menu, status, selected.data.review) || notes.length > 2000 || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0) return;
  const refreshSaved = savedViewRefresh();
  selected.saving = true; for (const control of form.elements) control.disabled = true;
  try {
    await api('/api/local-reviews', { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': state.csrf }, body: JSON.stringify({ menu: selected.menu, storeId: selected.storeId, entityId: selected.entityId, status, notes, expectedVersion }) });
  } catch (error) {
    if (selected.request === localReviewRequest && $('#local-review-dialog').open) {
      selected.conflict = error.code === 'REVIEW_CONFLICT';
      for (const control of form.elements) control.disabled = false;
      $('#save-local-review').disabled = selected.conflict;
      $('#local-review-message').innerHTML = `<p class="inline-warning">${selected.conflict ? 'O acompanhamento foi alterado em outra sessão. Sua edição foi mantida aqui. Copie as anotações antes de recarregar.' : 'Não foi possível salvar. Sua edição continua nesta tela; confira o status ou reabra o acompanhamento.'}</p>${selected.conflict ? '<button class="button compact" type="button" id="reload-local-review">Recarregar acompanhamento</button>' : ''}`;
      $('#reload-local-review')?.addEventListener('click', () => openLocalReview(selected.menu, selected.storeId, selected.entityId));
    }
    selected.saving = false; return;
  }
  selected.saving = false;
  const refreshed = await refreshSaved().then(() => true, () => { showMessage('Salvo. Não foi possível atualizar a lista.', 'warning'); return false; });
  if (selected.request === localReviewRequest && $('#local-review-dialog').open) await openLocalReview(selected.menu, selected.storeId, selected.entityId, 'Acompanhamento salvo.');
  else if (refreshed) showMessage('Acompanhamento salvo.');
}
function financialCaseAmounts(row) {
  if (financialExcluded(row)) return pendingPaymentMarkup();
  const values = row.byCurrency?.length ? row.byCurrency : [{ currency: row.currency, totalCents: row.totalCents }];
  const credit = row.kind === 'charges' && row.financialEffect === 'credit' ? '<small>Crédito/ajuste vinculado à cobrança</small>' : '';
  const uncertain = row.amountUncertain ? '<small>Valor em conferência: movimentos vinculados divergentes</small>' : '';
  return values.map(value => `${amount(value.totalCents, value.currency)}${value.unknownAmountCount > 0 ? '<small>Há valores não informados</small>' : ''}`).join('<br>') + credit + uncertain;
}
function financialCaseDates(row, kind) {
  if (!row.eventDateKnown) return `<span class="muted">${kind === 'refunds' ? 'Data original não disponível ou incompleta' : 'Data do lançamento não disponível ou incompleta'}</span>${row.firstEventAt ? `<small>Primeira data conhecida: ${escape(date(row.firstEventAt, true))}</small>` : ''}${row.lastEventAt && row.lastEventAt !== row.firstEventAt ? `<small>Última data conhecida: ${escape(date(row.lastEventAt, true))}</small>` : ''}`;
  return `<span>${escape(date(row.firstEventAt, true))}</span>${row.lastEventAt && row.lastEventAt !== row.firstEventAt ? `<small>Último evento: ${escape(date(row.lastEventAt, true))}</small>` : ''}`;
}
function financialCaseOrder(row) {
  const ids = Array.isArray(row.orderIds) ? row.orderIds : [];
  const linked = row.order;
  const identity = ids.length ? ids.map(id => `<span class="order-id-control">${linked?.orderId === id ? `<button class="order-link" data-case-order="${escape(id)}" data-store="${escape(row.storeId)}">${escape(id)}</button>` : `<span>${escape(id)}</span>`}<button class="copy-order" type="button" data-copy-order="${escape(id)}" aria-label="Copiar número do pedido ${escape(id)}">${icon('copy')}<span class="copy-label">Copiar número</span></button></span>`).join('<br>') : '<span class="muted">Sem pedido vinculado</span>';
  return `${identity}${linked ? `<small class="product-name">${escape(linked.title || 'Produto sem descrição')}</small><small>${escape(linked.sku || 'SKU não informado')}</small>${linked.mode ? modeBadge(linked.mode) : ''}` : ids.length ? '<small>Pedido não encontrado na base importada</small>' : ''}`;
}
function financialCaseOrderStatus(row) { return row.order ? orderDisplayStatusMarkup(row.order) : orderStatusBadge(null); }
function financialReturnGroups(row) {
  const groups = new Map(), orderIds = new Set(row.orderIds || []);
  const groupFor = orderId => {
    if (typeof orderId !== 'string' || !orderId || !orderIds.has(orderId)) return null;
    if (!groups.has(orderId)) groups.set(orderId, { orderId, customerReturnIds: new Set(), returnedToSeller: false });
    return groups.get(orderId);
  };
  for (const link of row.returnLinks?.customerReturns || []) {
    if (typeof link.returnId === 'string' && link.returnId) groupFor(link.orderId)?.customerReturnIds.add(link.returnId);
  }
  for (const link of row.returnLinks?.returnedToSeller || []) {
    const group = groupFor(link.orderId);
    if (group) group.returnedToSeller = true;
  }
  return [...groups.values()];
}
function financialReturnLinksMarkup(row, detail = false) {
  const groups = financialReturnGroups(row);
  const link = (view, orderId, label) => `<button type="button" class="case-return-link" data-related-returns="${view}" data-related-order="${escape(orderId)}" data-store="${escape(row.storeId)}" aria-label="Abrir ${escape(label)} do pedido ${escape(orderId)}">${escape(label)}${icon('arrow')}</button>`;
  const content = groups.length ? groups.map(group => `<div class="case-return-link-group">${detail || groups.length > 1 ? `<small>Pedido ${escape(group.orderId)}</small>` : ''}${group.customerReturnIds.size ? link('customer-returns', group.orderId, `Devoluções (${number(group.customerReturnIds.size)})`) : ''}${group.returnedToSeller ? link('returns', group.orderId, 'Devolvido ao vendedor') : ''}</div>`).join('') : '<span class="muted">Sem registro identificado</span><small>Nos dados importados</small>';
  return detail ? `<section class="detail-section"><h3>Registros relacionados</h3><p class="detail-info">Registros da mesma loja em todo o histórico importado. Os atalhos abrem o menu filtrado pelo pedido; não alteram o status da análise nem a situação na Amazon.</p><div class="case-return-links case-return-links-detail">${content}</div></section>` : `<div class="case-return-links">${content}</div>`;
}
function financialCaseTypeMarkup(row) {
  const hasStorage = nodes => (nodes || []).some(node => ['StorageBillingFee', 'FBAStorageFee'].includes(node.kind) || hasStorage(node.children));
  const storage = row.kind === 'charges' && (row.transactions || []).some(tx => hasStorage(tx.breakdowns) || (tx.items || []).some(item => hasStorage(item.breakdowns)));
  return `${escape(row.typeLabel || financialTypeLabel(row.type, row.kind))}${row.kind === 'charges' && row.type === 'Refund' ? '<small>Investigar vínculo com o pedido</small>' : ''}${storage ? '<small>Armazenamento</small>' : ''}`;
}
function reimbursementMarkup(row) {
  if (financialExcluded(row)) return pendingPaymentMarkup();
  const reimbursement = row.reimbursement;
  if (!reimbursement?.identified) return '<span class="muted">Não identificado</span><small>Nos dados importados</small>';
  const types = (reimbursement.types || []).map(type => reimbursementLabels[type.code] || type.label || type.code);
  return `${types.length ? types.map(type => badge(type, 'good')).join(' ') : badge('Crédito identificado', 'good')}<small>${currencyValues(reimbursement.byCurrency, 'totalCents')}</small>${reimbursement.lastCreditAt ? `<small>Último crédito: ${escape(date(reimbursement.lastCreditAt, true))}</small>` : '<small>Data do crédito não informada</small>'}`;
}
function reimbursementDetailMarkup(row) {
  if (financialExcluded(row)) return `<section class="detail-section"><h3>Ressarcimento</h3>${pendingPaymentMarkup()}</section>`;
  const reimbursement = row.reimbursement;
  const credits = reimbursement?.credits || [];
  return `<section class="detail-section"><h3>Ressarcimento</h3><div class="detail-info">${reimbursementMarkup(row)}</div>${reimbursement?.identified ? `<p class="detail-info">Crédito registrado na Amazon. Não confirma cobertura integral nem depósito bancário.</p>${credits.map(credit => `<div class="detail-product"><div><p>${escape(reimbursementLabels[credit.type] || credit.label || credit.type || 'Crédito identificado')}</p><small>Lançamento: ${escape(date(credit.postedAt, true))}</small><small>Situação financeira: ${escape(statusLabels[credit.status] || credit.status || 'Não informada')}</small></div><div>${amount(credit.totalCents, credit.currency)}</div></div><p class="transaction-id">Identificador: ${escape(credit.transactionId || 'Não informado')}</p>`).join('')}` : '<p class="detail-info">Nenhum crédito SAFE-T ou Easy Ship vinculado ao pedido foi identificado nos dados importados.</p>'}<p class="detail-info">O status da análise é mantido manualmente e não muda pela identificação de um crédito.</p></section>`;
}
function financialFilterMarkup(id, label, options, selected, selectedLabel, allLabel, kind) {
  const rows = (options || []).filter(option => typeof option.code === 'string' && option.code !== 'all');
  const displayLabel = option => id === 'case-status-filter' ? option.label || reviewLabel(option.code, kind) : kind === 'charges' && option.code === 'Refund' ? 'Reembolso sem pedido' : txLabels[option.code] || option.label || option.code;
  const missing = selected !== 'all' && !rows.some(option => option.code === selected);
  const missingLabel = (id === 'case-type-filter' ? kind === 'charges' && selected === 'Refund' ? 'Reembolso sem pedido' : txLabels[selected] : null) || selectedLabel || 'Filtro selecionado';
  return `<label><span class="sr-only">${escape(label)}</span><select id="${id}" aria-label="${escape(label)}" data-count-unit="casos"><option value="all" ${selected === 'all' ? 'selected' : ''}>${escape(allLabel)}</option>${rows.map(option => `<option value="${escape(option.code)}" data-label="${escape(displayLabel(option))}" ${selected === option.code ? 'selected' : ''}>${escape(displayLabel(option))} (${number(option.count)})</option>`).join('')}${missing ? `<option value="${escape(selected)}" data-label="${escape(missingLabel)}" selected>${escape(missingLabel)} (0)</option>` : ''}</select></label>`;
}
const reimbursementChoices = [['identified', 'Com ressarcimento'], ['safe_t', 'SAFE-T'], ['easy_ship', 'Easy Ship'], ['unidentified', 'Sem ressarcimento']];
function reimbursementChoicesMarkup(data) {
  const selected = new Set(filterCodes(state.caseReimbursement));
  const counts = new Map((data.reimbursementOptions || []).map(option => [option.code, Number.isSafeInteger(option.count) && option.count >= 0 ? option.count : 0]));
  const allCount = counts.has('identified') && counts.has('unidentified') ? counts.get('identified') + counts.get('unidentified') : null;
  const choices = [['all', 'Todos'], ...reimbursementChoices];
  return `<div class="refund-reimbursement-bar"><span class="filter-field-label">Ressarcimento</span><div class="reimbursement-choices" role="group" aria-label="Ressarcimento: selecione uma ou mais opções">${choices.map(([code, label]) => {
    const pressed = code === 'all' ? selected.size === 0 : selected.has(code);
    const count = code === 'all' ? allCount : counts.get(code) ?? 0;
    return `<button class="reimbursement-choice" id="reimbursement-${code}" type="button" data-reimbursement-choice="${code}" aria-pressed="${pressed}" aria-label="${escape(label)}${count === null ? '' : `, ${counted(count, 'caso', 'casos')}`}"${code === 'unidentified' ? ' title="Sem ressarcimento identificado nos dados importados"' : ''}><span>${escape(label)}</span>${count === null ? '' : `<span class="filter-option-count" aria-hidden="true">${number(count)}</span>`}</button>`;
  }).join('')}</div></div>`;
}
const refundSelection = new Map();
let refundSelectionScope = '', bulkReviewSaving = false;
const refundKey = row => JSON.stringify([row.storeId, row.caseId]);
function syncRefundSelectionScope() {
  const scope = JSON.stringify([state.view, state.storeId, state.from, state.to, state.query, state.mode, state.orderStatus, state.caseStatus, state.caseType, state.caseReimbursement]);
  if (scope !== refundSelectionScope) { refundSelection.clear(); refundSelectionScope = scope; updateRefundSelectionControls(); }
}
function selectableRefund(row) { return typeof row.caseId === 'string' && typeof row.storeId === 'string' && Number.isSafeInteger(row.review?.version) && row.review.version >= 0; }
function refundCheckboxMarkup(row) {
  return `<td class="selection-cell"><input type="checkbox" data-refund-select="${escape(row.caseId)}" data-store="${escape(row.storeId)}" aria-label="Selecionar reembolso ${escape(row.orderIds?.join(', ') || row.caseId)}" ${refundSelection.has(refundKey(row)) ? 'checked' : ''} ${selectableRefund(row) ? '' : 'disabled'}></td>`;
}
function refundBulkToolbar() {
  if (!state.refundBulkMode) return '<div class="bulk-selection-bar bulk-mode-entry"><button class="button compact" id="enter-refund-bulk" type="button">Gerenciar em massa</button></div>';
  return `<div class="bulk-selection-bar"><span id="refund-selected-count" role="status" aria-live="polite">${counted(refundSelection.size, 'selecionado', 'selecionados')}</span><span class="muted">Seleção por página · máximo de 100</span><button class="button compact" id="clear-refund-selection" type="button" ${refundSelection.size ? '' : 'disabled'}>Limpar seleção</button><button class="button compact primary" id="manage-refund-selection" type="button" ${refundSelection.size ? '' : 'disabled'}>Gerenciar selecionados</button><button class="button compact" id="exit-refund-bulk" type="button">Sair do gerenciamento</button></div>`;
}
function setRefundBulkMode(enabled) {
  if (state.view !== 'refunds' || !state.data) return;
  closeFilterMenus(); refundSelection.clear(); state.refundBulkMode = enabled;
  $('#content').innerHTML = financialCasesMarkup(state.data, 'refunds'); bindContent();
  $(enabled ? '#exit-refund-bulk' : '#enter-refund-bulk')?.focus({ preventScroll: true });
}
function updateRefundSelectionControls() {
  const inputs = [...document.querySelectorAll('#content [data-refund-select]')];
  for (const input of inputs) input.checked = refundSelection.has(refundKey({ storeId: input.dataset.store, caseId: input.dataset.refundSelect }));
  const eligible = inputs.filter(input => !input.disabled), checked = eligible.filter(input => input.checked).length;
  const page = $('#select-refund-page');
  if (page) { page.checked = eligible.length > 0 && checked === eligible.length; page.indeterminate = checked > 0 && checked < eligible.length; page.disabled = eligible.length === 0; }
  if ($('#refund-selected-count')) $('#refund-selected-count').textContent = counted(refundSelection.size, 'selecionado', 'selecionados');
  for (const id of ['clear-refund-selection', 'manage-refund-selection']) if ($(`#${id}`)) $(`#${id}`).disabled = refundSelection.size === 0;
}
function bindRefundSelection() {
  if (state.view !== 'refunds') return;
  $('#enter-refund-bulk')?.addEventListener('click', () => setRefundBulkMode(true));
  $('#exit-refund-bulk')?.addEventListener('click', () => setRefundBulkMode(false));
  if (!state.refundBulkMode) return;
  const rows = (state.data?.items || []).filter(selectableRefund);
  const add = row => refundSelection.set(refundKey(row), { storeId: row.storeId, caseId: row.caseId, expectedVersion: row.review.version });
  document.querySelectorAll('#content [data-refund-select]').forEach(input => input.addEventListener('change', () => {
    const row = rows.find(item => item.caseId === input.dataset.refundSelect && item.storeId === input.dataset.store);
    if (!row) return;
    if (!input.checked) refundSelection.delete(refundKey(row));
    else if (refundSelection.size >= 100 && !refundSelection.has(refundKey(row))) showMessage('Selecione até 100 reembolsos por vez.', 'warning');
    else if (!refundSelection.has(refundKey(row))) add(row);
    updateRefundSelectionControls();
  }));
  $('#select-refund-page')?.addEventListener('change', event => {
    const missing = rows.filter(row => !refundSelection.has(refundKey(row)));
    if (!event.target.checked) for (const row of rows) refundSelection.delete(refundKey(row));
    else if (refundSelection.size + missing.length > 100) showMessage('Esta página ultrapassaria o limite de 100 selecionados. Selecione os reembolsos individualmente ou limpe a seleção.', 'warning');
    else for (const row of missing) add(row);
    updateRefundSelectionControls();
  });
  $('#clear-refund-selection')?.addEventListener('click', () => { refundSelection.clear(); updateRefundSelectionControls(); });
  $('#manage-refund-selection')?.addEventListener('click', openBulkReview);
  updateRefundSelectionControls();
}
async function openBulkReview() {
  syncRefundSelectionScope();
  const items = [...refundSelection.values()].map(item => ({ ...item }));
  if (!items.length || items.length > 100 || state.view !== 'refunds' || !state.refundBulkMode) return;
  const scope = refundSelectionScope, dialog = $('#bulk-review-dialog');
  if (dialog.open) return;
  $('#bulk-review-body').innerHTML = '<div class="loading-state"><span class="spinner"></span>Carregando status disponíveis…</div>';
  dialog.showModal();
  try { await refreshReviewSettings(); }
  catch { if (dialog.open) $('#bulk-review-body').innerHTML = '<div class="notice error">Não foi possível carregar os status. Feche e tente novamente.</div>'; return; }
  if (!dialog.open || scope !== refundSelectionScope) return;
  $('#bulk-review-body').innerHTML = `<p>${counted(items.length, 'reembolso selecionado', 'reembolsos selecionados')} ${items.length === 1 ? 'receberá' : 'receberão'} o status escolhido.</p><p class="detail-info">Somente o status do acompanhamento será alterado. Anotações individuais e valores financeiros serão preservados. Não envia solicitações à Amazon.</p><div id="bulk-review-message" role="status" aria-live="polite"></div><form id="bulk-review-form" class="case-review-form"><label for="bulk-review-status">Novo status<select id="bulk-review-status" required><option value="" selected>Escolha o status</option>${reviewChoices('refunds').map(item => `<option value="${escape(item.code)}">${escape(item.label)}</option>`).join('')}</select></label><p id="bulk-review-confirmation" class="detail-info">Escolha um status para conferir a alteração.</p><div class="bulk-review-actions"><button class="button" type="button" id="cancel-bulk-review">Cancelar</button><button class="button primary" type="submit" id="apply-bulk-review" disabled>Aplicar status</button></div></form>`;
  $('#bulk-review-status').addEventListener('change', event => {
    const valid = reviewChoiceValid('refunds', event.target.value);
    $('#apply-bulk-review').disabled = !valid;
    $('#bulk-review-confirmation').textContent = valid ? `Aplicar “${reviewLabel(event.target.value, 'refunds')}” a ${counted(items.length, 'reembolso', 'reembolsos')}.` : 'Escolha um status para conferir a alteração.';
  });
  $('#cancel-bulk-review').addEventListener('click', () => { if (!bulkReviewSaving) dialog.close(); });
  $('#bulk-review-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget, status = $('#bulk-review-status').value;
    if (bulkReviewSaving || !reviewChoiceValid('refunds', status)) return;
    syncRefundSelectionScope();
    if (scope !== refundSelectionScope) { dialog.close(); showMessage('Os filtros mudaram. Selecione novamente os reembolsos.', 'warning'); return; }
    bulkReviewSaving = true; $('#close-bulk-review').disabled = true;
    for (const control of form.elements) control.disabled = true;
    $('#apply-bulk-review').textContent = 'Salvando…';
    try {
      const result = await api('/api/reviews/bulk', { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': state.csrf }, body: JSON.stringify({ kind: 'refunds', items, status }) });
      refundSelection.clear(); dialog.close(); await loadView();
      showMessage(`${counted(result.updatedCount ?? items.length, 'reembolso atualizado', 'reembolsos atualizados')}.${result.unchangedCount ? ` ${counted(result.unchangedCount, 'já estava', 'já estavam')} nesse status.` : ''}`);
    } catch (error) {
      if (error.code === 'REVIEW_CONFLICT' || error.code === 'BULK_NOT_FOUND') {
        refundSelection.clear(); dialog.close(); await loadView();
        showMessage(`${error.code === 'REVIEW_CONFLICT' ? 'Um dos acompanhamentos foi alterado em outra sessão.' : 'Um dos casos não está mais disponível.'} Nenhum reembolso foi alterado nesta operação. A lista foi recarregada; selecione novamente os casos.`, 'warning');
      } else {
        $('#bulk-review-message').innerHTML = '<p class="inline-warning">Não foi possível concluir a alteração. Confira a lista antes de tentar novamente; as versões serão verificadas ao salvar.</p>';
        for (const control of form.elements) control.disabled = false;
        $('#apply-bulk-review').textContent = 'Aplicar status';
      }
    } finally { bulkReviewSaving = false; $('#close-bulk-review').disabled = false; }
  });
  $('#bulk-review-status').focus();
}
function financialCasesMarkup(data, kind) {
  const rows = data.items || [], total = data.total ?? rows.length, summary = data.summary || {};
  const refund = kind === 'refunds', amountLabel = refund ? 'Reembolso' : 'Desconto registrado';
  const caseDateLabel = refund ? 'data original do reembolso' : 'data do lançamento financeiro';
  const periodExplanation = `Todos os casos importados, incluindo os que estão sem ${caseDateLabel}. Os valores mostram o caso inteiro.`;
  return `${coverageNotice()}${summary.excludedPendingCaseCount > 0 ? `<div class="notice">${icon('clock')}<span>${counted(summary.excludedPendingCaseCount, 'caso com pagamento pendente fora', 'casos com pagamento pendente fora')} dos indicadores financeiros. O acompanhamento local foi preservado.</span></div>` : ''}<div class="notice">${icon('info')}<span>${periodExplanation} Status e anotações são controles locais.</span></div>
  ${summary.undatedExcludedCount > 0 ? `<div class="notice warning">${icon('info')}<span>${counted(summary.undatedExcludedCount, 'caso', 'casos')} sem ${caseDateLabel} conhecida ${summary.undatedExcludedCount === 1 ? 'ficou' : 'ficaram'} fora do período.${refund ? ' A data de liberação financeira não substitui a data original.' : ''}<br><button class="button compact" type="button" data-financial-all>Ver todos, incluindo sem data</button></span></div>` : ''}
  <section class="metric-grid" aria-label="Resumo dos casos selecionados">${metric('Casos encontrados', number(summary.caseCount ?? total), `${counted(summary.eventCount, 'evento', 'eventos')} · ${counted(summary.movementCount, 'movimento', 'movimentos')}`, refund ? 'refund' : 'money')}${metric(amountLabel, currencyValues(summary.byCurrency, 'totalCents'), 'Total dos casos selecionados · moedas separadas', 'money', true, (summary.byCurrency?.length || 0) > 1)}${metric(refund ? 'Novos' : 'Pendentes', number(summary.pendingCount), `${number(summary.inReviewCount)} em análise · ${number(summary.waitingAmazonCount)} aguardando Amazon`, 'clock')}${metric('Resolvidos', number(summary.resolvedCount), refund ? `${counted(summary.requestSafeTCount, 'marcado', 'marcados')} para solicitar SAFE-T` : 'Situação registrada no acompanhamento local', 'check')}</section>
  ${summary.unknownEventDateCount > 0 ? `<p class="footnote">${counted(summary.unknownEventDateCount, 'caso selecionado tem', 'casos selecionados têm')} ${caseDateLabel} incompleta.</p>` : ''}
  <section class="panel"><div class="table-toolbar"><label class="search-box">${icon('search')}<span class="sr-only">Pesquisar pedido, produto, SKU ou identificador</span><input id="search" type="search" maxlength="200" placeholder="Pesquisar pedido, produto, SKU ou identificador" value="${escape(state.query)}" autocomplete="off"></label><div class="table-filters">${financialFilterMarkup('case-status-filter', 'Status da análise', data.statusOptions, state.caseStatus, state.caseStatusLabel, 'Todos os status', kind)}${!refund ? financialFilterMarkup('case-type-filter', 'Tipo de lançamento', data.typeOptions, state.caseType, state.caseTypeLabel, 'Todos os tipos', kind) : ''}<span class="result-count">${number(total)} ${total === 1 ? 'caso' : 'casos'}</span></div></div>
  ${refund ? reimbursementChoicesMarkup(data) + refundBulkToolbar() : ''}
  ${rows.length ? `<div class="table-scroll"><table><thead><tr>${refund && state.refundBulkMode ? '<th class="selection-cell"><input id="select-refund-page" type="checkbox" aria-label="Selecionar todos os reembolsos desta página"></th>' : ''}<th>${refund ? 'Reembolso original' : 'Data do lançamento'}</th><th>Pedido / produto</th>${refund ? '<th>Status do pedido</th>' : ''}<th>Tipo</th><th class="numeric">${amountLabel}</th>${refund ? '<th>Ressarcimento</th>' : ''}<th>Status da análise</th><th>Acompanhamento</th></tr></thead><tbody>${rows.map(row => `<tr>${refund && state.refundBulkMode ? refundCheckboxMarkup(row) : ''}<td>${financialCaseDates(row, kind)}${isMultipleStores(state.storeId) ? `<small>${escape(storeName(row.storeId))}</small>` : ''}</td><td class="product-cell">${financialCaseOrder(row)}</td>${refund ? `<td>${financialCaseOrderStatus(row)}${financialReturnLinksMarkup(row)}</td>` : ''}<td>${financialCaseTypeMarkup(row)}<small>${counted(refund ? row.refundCount : row.eventCount, refund ? 'reembolso' : 'evento', refund ? 'reembolsos' : 'eventos')} · ${counted(row.movementCount, 'movimento', 'movimentos')}</small></td><td class="numeric">${financialCaseAmounts(row)}${row.allocation === 'multiple-orders-unallocated' ? '<small>Vários pedidos · sem rateio</small>' : ''}</td>${refund ? `<td>${reimbursementMarkup(row)}</td>` : ''}<td>${reviewBadge(row.review, kind)}${row.review?.updatedAt ? `<small>Atualizado em ${escape(date(row.review.updatedAt, true))}</small>` : ''}</td><td><button class="button compact" data-financial-case="${escape(row.caseId)}" data-case-kind="${kind}" data-store="${escape(row.storeId)}">Detalhes / gerenciar</button></td></tr>`).join('')}</tbody></table></div>` : empty(refund ? 'Nenhum reembolso encontrado' : 'Nenhuma cobrança não identificada', 'Ajuste a busca ou os filtros. A ausência se refere somente aos dados importados.')}${pagination(total, rows.length)}</section>
  <p class="footnote">${refund ? 'Reembolso original e liberação financeira vinculados contam como um único fato. O impacto líquido inclui os componentes informados pela Amazon; não é confirmação de depósito bancário.' : 'Este menu reúne cobranças ainda não identificadas. Armazenamento FBA e publicidade (ADS) são exibidos no Dashboard. O desconto registrado preserva o sinal e a moeda informados pela Amazon. Comissões e fretes incluídos nas vendas continuam no detalhe do pedido.'}</p>${coverageMarkup(data)}`;
}
function financialCaseTransactions(row, kind) {
  if (financialExcluded(row)) return pendingPaymentMarkup();
  const transactions = [...(row.transactions || [])].sort((a, b) => String(a.postedAt || '').localeCompare(String(b.postedAt || '')));
  if (!transactions.length) return '<p class="detail-info">Nenhum movimento disponível para detalhamento.</p>';
  return transactions.map(tx => financialExcluded(tx) ? `<div class="transaction">${pendingPaymentMarkup()}</div>` : `<details class="transaction"><summary><span class="transaction-heading"><strong>${escape(tx.isReleaseMovement ? 'Liberação financeira' : kind === 'refunds' ? 'Reembolso original' : financialTypeLabel(tx.type, kind))}</strong><small>${tx.originalPostedAt ? `Data original: ${escape(date(tx.originalPostedAt, true))}` : 'Data original não disponível'}${tx.isReleaseMovement ? ` · Movimento: ${escape(date(tx.postedAt, true))}` : ''}</small></span>${amount(tx.totalCents, tx.currency)}</summary><div class="transaction-body"><p class="detail-info">Situação financeira: ${escape(statusLabels[tx.status] || tx.status || 'Não informada')}.</p>${tx.isReleaseMovement ? '<p class="inline-warning">Liberação financeira do mesmo evento; não representa um novo reembolso ou cobrança.</p>' : ''}${tx.countsInTotal === false || tx.superseded ? '<p class="inline-warning">Este movimento não é somado novamente ao total do caso.</p>' : ''}${tree(tx.breakdowns)}${tx.items?.length ? `<details><summary class="detail-info">Detalhamento por item</summary>${tx.items.map(item => `<div class="detail-product"><span>${escape(item.sku || item.asin || 'Item sem identificador')}</span>${amount(item.totalCents, item.currency)}</div>${tree(item.breakdowns)}`).join('')}</details>` : ''}<p class="transaction-id">Identificador: ${escape(tx.transactionId)}</p></div></details>`).join('');
}
function financialReviewHistory(row, kind) {
  const history = [...(row.reviewHistory || [])].sort((a, b) => b.version - a.version);
  return `<section class="detail-section"><h3>Histórico do acompanhamento</h3>${history.length ? history.map(entry => `<details class="transaction"><summary><span class="transaction-heading"><strong>${escape(reviewLabel(entry.status, kind))}</strong><small>${escape(date(entry.changedAt, true))}${entry.previousStatus && entry.previousStatus !== entry.status ? ` · Antes: ${escape(reviewLabel(entry.previousStatus, kind))}` : ' · Anotações atualizadas'}</small></span></summary><div class="transaction-body"><p class="detail-info">${entry.notes ? escape(entry.notes).replace(/\n/g, '<br>') : 'Sem anotações nesta revisão.'}</p></div></details>`).join('') : '<p class="detail-info">Nenhuma alteração de acompanhamento registrada.</p>'}</section>`;
}
function financialCaseReviewSection(row, kind) {
  const review = row.review || {}, validVersion = Number.isSafeInteger(review.version) && review.version >= 0;
  if (kind === 'refunds') return `<section class="detail-section"><h3>Acompanhamento em Gerenciar reembolsos</h3><p class="detail-info">Este detalhe financeiro e o histórico anterior ficam disponíveis somente para consulta. O acompanhamento atual é feito em Gerenciar reembolsos.</p>${(row.orderIds || []).map(orderId => `<button type="button" class="button compact" data-manage-refund-order="${escape(orderId)}" data-store="${escape(row.storeId)}">Gerenciar pedido ${escape(orderId)}</button>`).join(' ')}${!row.orderIds?.length ? '<p class="detail-info">O vínculo com um pedido ainda não foi identificado nos dados importados. Investigue o lançamento em Cobranças.</p>' : ''}<h3>Anotações anteriores</h3><p class="detail-info">${review.notes ? escape(review.notes).replace(/\n/g, '<br>') : 'Sem anotações anteriores.'}</p></section>`;
  return `<section class="detail-section"><h3>Acompanhamento local</h3><p class="detail-info">Organização interna. Não envia solicitações à Amazon.</p><div id="case-review-message" role="status" aria-live="polite"></div><form id="case-review-form" class="case-review-form"><label for="case-review-status">Status da análise<select id="case-review-status" name="status" required>${reviewOptionsMarkup(kind, review)}</select></label><label for="case-review-notes">Anotações<textarea id="case-review-notes" name="notes" rows="6" maxlength="2000" aria-describedby="case-notes-help">${escape(review.notes || '')}</textarea></label><p id="case-notes-help" class="detail-info">Até 2.000 caracteres. Registre o que foi conferido e os próximos passos.</p><button id="case-review-save" class="button primary" type="submit" ${validVersion ? '' : 'disabled'}>Salvar acompanhamento</button></form>${validVersion ? '' : '<p class="inline-warning">A versão do acompanhamento não está disponível. Recarregue o caso antes de editar.</p>'}</section>`;
}
function legacyFinancialReviewSections(row) {
  return (row.legacyReviews || []).map(legacy => `<section class="detail-section"><h3>${legacy.kind === 'charges' ? 'Histórico anterior em Cobranças' : 'Histórico anterior do reembolso'}</h3><p class="detail-info">Registro preservado somente para consulta; independente do acompanhamento atual.</p>${reviewBadge(legacy.review, legacy.kind || 'refunds')}<p class="detail-info">${legacy.review?.notes ? escape(legacy.review.notes).replace(/\n/g, '<br>') : 'Sem anotações anteriores.'}</p></section>${financialReviewHistory({ reviewHistory: legacy.history || [] }, legacy.kind || 'refunds')}`).join('');
}
function financialCaseDetailMarkup(row, kind) {
  const refund = kind === 'refunds', review = row.review || {};
  const validVersion = Number.isSafeInteger(review.version) && review.version >= 0;
  return `<div class="detail-meta"><span>${escape(storeName(row.storeId))}</span>${refund ? `<span>Histórico anterior: ${reviewBadge(review, kind)}</span>` : reviewBadge(review, kind)}</div><section class="detail-section"><h3>${refund ? 'Reembolso' : row.type === 'Refund' ? 'Reembolso sem pedido' : row.financialEffect === 'credit' ? 'Crédito/ajuste vinculado à cobrança' : 'Desconto registrado'}</h3><div>${financialCaseAmounts(row)}</div><p class="detail-info">${counted(refund ? row.refundCount : row.eventCount, refund ? 'reembolso identificado' : 'evento identificado', refund ? 'reembolsos identificados' : 'eventos identificados')} · ${counted(row.movementCount, 'movimento financeiro', 'movimentos financeiros')}.</p><div class="detail-info">${financialCaseDates(row, kind)}</div>${row.lastMovementAt ? `<p class="detail-info">Última movimentação financeira: ${escape(date(row.lastMovementAt, true))}.</p>` : ''}${!row.eventDateKnown ? '<p class="inline-warning">Há data original não disponível. A movimentação financeira posterior não define a data original.</p>' : ''}${row.allocation === 'multiple-orders-unallocated' ? '<p class="inline-warning">Este caso está associado a vários pedidos. O valor não foi rateado entre eles.</p>' : ''}</section>
  <section class="detail-section"><h3>Pedido vinculado</h3>${!refund && row.type === 'Refund' ? '<p class="detail-info">Pedido não identificado nos dados importados. Confira o vínculo deste reembolso antes de concluir a análise.</p>' : ''}<div class="detail-info">${financialCaseOrder(row)}</div>${refund ? `<p class="detail-info">Status do pedido</p>${financialCaseOrderStatus(row)}` : ''}</section>
  ${refund ? financialReturnLinksMarkup(row, true) + reimbursementDetailMarkup(row) : ''}
  ${financialCaseReviewSection(row, kind)}
  <section class="detail-section"><h3>Movimentos financeiros</h3><p class="detail-info">Os componentes explicam o total; não são somados novamente entre si. Valores de moedas diferentes permanecem separados.</p>${financialCaseTransactions(row, kind)}</section>${financialReviewHistory(row, kind)}${legacyFinancialReviewSections(row)}<p class="transaction-id">Caso: ${escape(row.caseId)}</p>`;
}
function orderQuantity(order) {
  const values = (order.items || []).map(item => item.quantityOrdered);
  if (!values.length || values.some(value => !Number.isSafeInteger(value) || value < 0)) return null;
  const total = values.reduce((sum, value) => sum + value, 0);
  return Number.isSafeInteger(total) ? total : null;
}
function orderNumberMarkup(order) {
  return `<span class="order-id-control"><button class="order-link" data-order="${escape(order.orderId)}" data-store="${escape(order.storeId)}">${escape(order.orderId)}</button><button class="copy-order" type="button" data-copy-order="${escape(order.orderId)}" data-store="${escape(order.storeId)}" aria-label="Copiar número do pedido ${escape(order.orderId)}">${icon('copy')}<span class="copy-label">Copiar número</span></button></span>`;
}
function costBasis(cost) {
  return cost?.basis === 'initial' ? 'Custo fixado · base inicial' : 'Custo fixado na venda';
}
function costPending(cost) {
  return !cost?.connected ? 'Conexão de custos pendente' : cost.reason === 'store-unlinked' ? 'Loja sem vínculo de custo' : cost.reason === 'product-unlinked' ? 'Vincular produto no estoque' : cost.reason === 'awaiting-capture' ? 'Aguardando registro do custo' : 'Custo não registrado';
}
function productCostMarkup(cost, inventory = false) {
  if (cost?.totalCents == null) return `<span class="muted">Custo pendente</span><small>${escape(!inventory && cost?.reason === 'product-unlinked' ? 'Vincular nos detalhes do pedido' : costPending(cost))}</small>`;
  return `<span class="product-cost-value">${amount(cost.totalCents, 'BRL')}</span><small>${inventory ? 'Valor do estoque apto' : escape(costBasis(cost))}</small>${inventory && cost.unitCostCents != null ? `<small>${money(cost.unitCostCents, 'BRL')} / unidade</small>` : ''}${cost.stale ? '<small class="inline-warning">Atualização de custo pendente</small>' : ''}`;
}
function orderResultMarkup(cost) {
  if (cost?.resultCents == null) return '<span class="muted">—</span><small>Aguardando custo ou líquido da venda</small>';
  return `${amount(cost.resultCents, 'BRL')}<small>Após custo fixado do produto</small>`;
}
function stockCostSummary(cost) {
  if (!cost?.connected || cost.itemCount > 0 && cost.missingCount === cost.itemCount) return '<span class="muted">Custo pendente</span><small>Vincule os produtos e seus custos no Estoque Origem</small>';
  if (!cost.stockComplete && !cost.itemCount) return '<span class="muted">Estoque incompleto</span>';
  const partial = cost.totalCents === null;
  return `${amount(partial ? cost.knownTotalCents : cost.totalCents, 'BRL')}${partial ? `<small>Valor parcial · ${cost.missingCount ? counted(cost.missingCount, 'produto com custo pendente', 'produtos com custo pendente') : 'estoque incompleto'}</small>` : '<small>Custo médio · Estoque Origem</small>'}${cost.stale ? '<small class="inline-warning">Atualização de custos pendente</small>' : ''}`;
}
function orderCostDetail(order) {
  const cost = order.cost;
  return `<section class="detail-section order-costs"><h3>Custo e resultado da venda</h3><div class="cost-detail-grid"><div><span>Custo dos produtos</span>${productCostMarkup(cost)}</div><div><span>Resultado da venda</span>${orderResultMarkup(cost)}</div></div><p class="detail-info">${cost?.totalCents == null ? (cost?.reason === 'store-unlinked' ? 'A origem dos custos desta loja ainda não foi configurada.' : 'Há produtos com custo pendente. Use “Vincular produto” abaixo para conferir os vínculos. Os custos vêm do sistema de estoque.') : cost?.basis === 'initial' ? 'Custo atual registrado como base inicial para este pedido. Alterações futuras no estoque não mudam esse custo.' : 'Custo registrado conforme o valor vigente na data da venda. Alterações futuras no estoque não mudam esse custo.'} O resultado desconta o custo dos produtos do líquido da venda, com taxas e frete. Reembolsos, ADS, armazenamento e despesas gerais ficam fora deste resultado.</p>${cost?.observedAt ? `<small class="detail-info">Custos consultados em ${escape(date(cost.observedAt, true))}.</small>` : ''}</section>`;
}
function ordersTable(data) {
  const items = data.items || [], total = data.total ?? items.length;
  return `${coverageNotice()}<section class="panel"><div class="table-toolbar"><label class="search-box">${icon('search')}<span class="sr-only">Pesquisar pedido, produto, SKU ou ASIN</span><input id="search" type="search" maxlength="200" placeholder="Pesquisar pedido, produto, SKU ou ASIN" value="${escape(state.query)}" autocomplete="off"></label><div class="table-filters"><label><span class="sr-only">Modalidade de envio</span><select id="mode-filter" aria-label="Modalidade de envio"><option value="all">Todas as modalidades</option><option value="DBA" ${state.mode === 'DBA' ? 'selected' : ''}>DBA</option><option value="FBA" ${state.mode === 'FBA' ? 'selected' : ''}>FBA</option><option value="MFN" ${state.mode === 'MFN' ? 'selected' : ''}>Envio próprio</option><option value="unknown" ${state.mode === 'unknown' ? 'selected' : ''}>Não identificada</option></select></label>${orderStatusFilterMarkup(data)}<label><span class="sr-only">Líquido do pedido</span><select id="order-net-filter" aria-label="Líquido do pedido">${[['all', 'Todos os pedidos'], ['positive', 'Líquido positivo'], ['receivable', 'A receber — não liberado']].map(([value, label]) => `<option value="${value}" ${state.orderNet === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label><span class="result-count">${number(total)} ${total === 1 ? 'pedido' : 'pedidos'}</span></div></div>
    ${items.length ? `<div class="table-scroll"><table class="orders-table"><thead><tr><th>Pedido / data</th><th>Produto</th><th>Status</th><th>Envio</th><th class="numeric">Valor da venda</th><th class="numeric">${state.orderNet === 'receivable' ? 'Líquido a receber' : 'Líquido registrado'}</th><th>Custo dos produtos</th><th>Resultado da venda</th></tr></thead><tbody>${items.map(order => { const first = order.items?.[0], fin = getOrderFinancial(order), excluded = financialExcluded(order); return `<tr data-order-card="${escape(order.orderId)}" data-order-row="${escape(order.orderId)}" data-store="${escape(order.storeId)}" tabindex="0" aria-label="Ver detalhes do pedido ${escape(order.orderId)}"><td>${orderNumberMarkup(order)}<small>${escape(date(order.createdAt, true))}</small>${isMultipleStores(state.storeId) ? `<small>${escape(storeName(order.storeId))}</small>` : ''}</td><td class="product-cell"><span class="product-name">${escape(first?.title || 'Produto sem descrição')}</span><small>${escape(first?.sku || first?.asin || 'Identificador não informado')}${order.items.length > 1 ? ` · +${order.items.length - 1} itens` : ''}</small><span class="product-quantity"><span>Quantidade</span><strong>${number(orderQuantity(order))}</strong></span></td><td>${orderDisplayStatusMarkup(order)}</td><td>${modeBadge(order.fulfillmentMode)}</td><td class="numeric">${excluded ? pendingPaymentMarkup() : order.grandTotalCents !== null && order.grandTotalCents !== undefined ? amount(order.grandTotalCents, order.currency) : '<span class="muted">Valor não informado</span>'}</td><td class="numeric">${excluded ? pendingPaymentMarkup() : `${fin.length ? fin.map(row => amount(state.orderNet === 'receivable' ? row.deferredCents : row.netCents, row.currency)).join('<br>') : '<span class="muted">Sem lançamento</span>'}<small>${number(order.financial?.linkedTransactionCount ?? order.financial?.transactionCount ?? 0)} eventos encontrados</small>`}</td><td class="product-cost-cell">${productCostMarkup(order.cost)}</td><td class="product-cost-cell">${orderResultMarkup(order.cost)}</td></tr>`; }).join('')}</tbody></table></div>` : empty('Nenhum pedido encontrado', 'Tente outro período, termo de pesquisa, modalidade ou status. Um período sem dados importados não comprova ausência de vendas.')}
    ${pagination(total, items.length)}</section><p class="footnote">A lista usa a data de criação do pedido. ${state.orderNet === 'receivable' ? 'A receber considera somente o saldo positivo de lançamentos ainda não liberados pela Amazon.' : 'O líquido reúne os lançamentos conhecidos desse pedido, inclusive os de outras datas.'} Sem lançamento significa ausência na base importada. O custo de cada pedido fica fixado. Pedidos anteriores à integração usam o custo registrado na vinculação inicial. O resultado da venda não inclui reembolsos nem despesas gerais.</p>${coverageMarkup(data)}`;
}
function customerReturnOrder(row) {
  const id = row.orderId;
  return `${id ? `<span class="order-id-control"><span class="order-link">${escape(id)}</span><button class="copy-order" type="button" data-copy-order="${escape(id)}" aria-label="Copiar número do pedido ${escape(id)}">${icon('copy')}<span class="copy-label">Copiar número</span></button></span>` : '<span class="muted">Pedido não informado</span>'}<small class="product-name">${escape(row.productName || 'Produto não informado')}</small><small>SKU: ${escape(row.sku || 'Não informado')}</small>${row.asin ? `<small>ASIN: ${escape(row.asin)}</small>` : ''}`;
}
function customerReturnDates(row) {
  return `${row.requestedAt ? `<span>Solicitação: ${escape(date(row.requestedAt))}</span>` : ''}${row.receivedAt ? `<small>Recebimento: ${escape(date(row.receivedAt))}</small>` : ''}${!row.requestedAt && !row.receivedAt ? '<span class="muted">Não informado</span>' : ''}`;
}
function customerReturnTracking(row) {
  const tracking = row.tracking || {};
  const label = tracking.label || statusLabels[tracking.status] || tracking.status;
  const code = String(row.trackingNumber || '').trim().toUpperCase();
  const correios = /correios/i.test(row.carrier || '') && /^[A-Z]{2}\d{9}[A-Z]{2}$/.test(code);
  const reference = correios
    ? `<a class="tracking-external-link" href="https://www.linkcorreios.com.br/${encodeURIComponent(code)}" target="_blank" rel="noopener noreferrer" title="Consultar no Link Correios — abre em nova aba" aria-label="Rastrear ${escape(code)} no Link Correios">${escape(row.trackingNumber)} <span aria-hidden="true">↗</span></a><small>Consultar no Link Correios</small>`
    : row.trackingNumber ? `<span>Código: ${escape(row.trackingNumber)}</span>` : '<span class="muted">Código de rastreio não informado</span>';
  return `${reference}${row.carrier ? `<small>${escape(row.carrier)}</small>` : ''}${label ? `<small>Status do rastreio: ${escape(label)}</small>` : '<small>Sem atualização de rastreio disponível</small>'}${tracking.updatedAt ? `<small>Evento em: ${escape(date(tracking.updatedAt, true))}</small>` : ''}${tracking.observedAt ? `<small>Consultado em: ${escape(date(tracking.observedAt, true))}</small>` : ''}`;
}
// Display translations only; the imported reasonCode remains unchanged for analysis.
const customerReturnReasons = {
  'CR-DEFECTIVE': 'Produto com defeito ou mau funcionamento',
  'CR-UNWANTED_ITEM': 'Cliente não deseja mais o produto',
  'CR-ORDERED_WRONG_ITEM': 'Compra realizada por engano',
  'CR-SWITCHEROO': 'Produto diferente do pedido',
  'CR-NOT_COMPATIBLE': 'Produto incompatível com o uso pretendido',
  'CR-QUALITY_UNACCEPTABLE': 'Qualidade ou desempenho insatisfatório',
  'AMZ-PG-BAD-DESC': 'Produto diferente da descrição do anúncio',
  'CR-MISSING_PARTS': 'Peças faltando ou quebradas',
  'CR-FOUND_BETTER_PRICE': 'Encontrou preço melhor',
  'CR-DAMAGED_BY_FC': 'Dano associado à embalagem inadequada',
  'CR-DAMAGED_BY_CARRIER': 'Dano durante o transporte',
  'CR-MISSED_ESTIMATED_DELIVERY': 'Prazo estimado de entrega não cumprido',
  'CR-NO_REASON_GIVEN': 'Motivo não informado pelo cliente',
  DEFECTIVE: 'Produto com defeito', UNWANTED_ITEM: 'Cliente não deseja mais o produto',
  QUALITY_UNACCEPTABLE: 'Qualidade insatisfatória', FOUND_BETTER_PRICE: 'Encontrou preço melhor',
  UNDELIVERABLE_UNKNOWN: 'Entrega não realizada — motivo não informado',
};
function customerReturnReason(row, detail = false) {
  const code = row.reasonCode;
  if (!code) return '<span class="muted">Não informado pela Amazon</span>';
  const label = customerReturnReasons[code];
  if (detail) return `<div class="return-reason-detail"><span class="return-reason">${escape(label || code)}</span>${label ? `<div class="return-reason-code"><span>Código original</span><code>${escape(code)}</code></div>` : ''}</div>`;
  return `<span class="return-reason" title="${escape(code)}">${escape(label || code)}</span>`;
}
function customerReturnField(label, value, wide = false) {
  return `<div class="return-fact${wide ? ' return-fact-wide' : ''}"><dt>${escape(label)}</dt><dd>${value}</dd></div>`;
}
function customerReturnRefund(row, detail = false) {
  if (financialExcluded(row) || financialExcluded(row.refund)) return pendingPaymentMarkup();
  const refund = row.refund;
  if (refund?.status !== 'recorded') return '<span class="muted">Não identificado nos dados importados</span>';
  const reported = refund.source === 'return-report';
  const count = refund.source === 'financial-transactions' && Number.isFinite(refund.count) && refund.count >= 0 ? `<small>${counted(refund.count, 'reembolso identificado', 'reembolsos identificados')}</small>` : '';
  const dates = refund.latestPostedAt ? `<small>Lançamento: ${escape(date(refund.latestPostedAt, true))}</small>${refund.hasUnknownOriginalDate ? '<small>Há data original não disponível</small>' : ''}` : '<small>Data original não disponível</small>';
  if (detail) return `<div class="return-refund-top">${badge(reported ? 'Informado no relatório de devolução' : 'Reembolso registrado', 'good')}<div class="return-refund-amount">${currencyValues(refund.byCurrency, 'totalCents')}</div></div><dl class="return-facts return-refund-facts">${customerReturnField('Data do lançamento', refund.latestPostedAt ? `${escape(date(refund.latestPostedAt, true))}${refund.hasUnknownOriginalDate ? '<small>Há data original não disponível</small>' : ''}` : '<span class="muted">Data original não disponível</span>')}${count ? customerReturnField('Lançamentos identificados', number(refund.count)) : ''}</dl>`;
  return `${badge(reported ? 'Informado no relatório de devolução' : 'Reembolso registrado', 'good')}<small>${currencyValues(refund.byCurrency, 'totalCents')}</small>${dates}${count}`;
}
function customerReturnCoverage(coverage) {
  const missing = !coverage || coverage.state === 'missing';
  const text = missing ? 'Devoluções ainda não consultadas: os relatórios necessários não estão disponíveis na base importada. Isso não significa ausência de devoluções.' : coverage.state === 'partial' ? 'Cobertura parcial: algumas fontes de devoluções ainda não estão disponíveis. A lista mostra somente os registros importados.' : 'A lista contém as devoluções dos relatórios importados. A cobertura de cada modalidade depende das fontes disponíveis.';
  const sourceStatusLabels = { IMPORTED: 'Importado', IN_QUEUE: 'Na fila de consulta', IN_PROGRESS: 'Consulta em andamento', DONE: 'Pronto para importar', CANCELLED: 'Consulta cancelada', FATAL: 'Consulta não concluída', FAILED: 'Consulta não concluída', NOT_COLLECTED: 'Não consultado', AVAILABLE: 'Disponível', MISSING: 'Não consultado', NOT_REQUESTED: 'Não consultado', PENDING: 'Pendente', ERROR: 'Consulta não concluída' };
  return `<div class="notice ${missing || coverage?.state === 'partial' ? 'warning' : ''}">${icon('info')}<span>${text}</span></div>${coverage?.sources?.length ? `<details class="coverage-details"><summary>Fontes de devoluções</summary>${coverage.sources.map(source => `<p>${escape(source.label || source.reportType || 'Fonte não informada')} · ${escape(sourceStatusLabels[String(source.status || '').toUpperCase()] || source.status || 'Não informado')}${Number.isSafeInteger(source.importedWindows) && Number.isSafeInteger(source.totalWindows) && source.totalWindows > 0 ? ` · Períodos importados: ${number(source.importedWindows)} de ${number(source.totalWindows)}` : ''}${source.observedAt ? ` · Consultado em ${escape(date(source.observedAt, true))}` : ''}</p>`).join('')}</details>` : ''}`;
}
function customerReturnsMarkup(data) {
  const rows = data.items || [], total = data.total ?? rows.length, summary = data.summary || {};
  const missing = !data.coverage || data.coverage.state === 'missing';
  return `${customerReturnCoverage(data.coverage)}<p class="footnote">Todo o histórico de devoluções importado, incluindo registros sem data. O status da devolução e o rastreio são informações separadas.</p><section class="panel"><div class="table-toolbar"><label class="search-box">${icon('search')}<span class="sr-only">Pesquisar pedido, produto, SKU, ASIN ou rastreio</span><input id="search" type="search" maxlength="200" placeholder="Pesquisar pedido, produto, SKU ou rastreio" value="${escape(state.query)}" autocomplete="off"></label><div class="table-filters"><label><span class="sr-only">Modalidade de envio</span><select id="mode-filter" aria-label="Modalidade de envio"><option value="all">Todas as modalidades</option>${[['FBA', 'FBA'], ['DBA', 'DBA'], ['MFN', 'Envio próprio'], ['unknown', 'Não identificada']].map(([code, label]) => `<option value="${code}" ${state.mode === code ? 'selected' : ''}>${label}</option>`).join('')}</select></label><label><span class="sr-only">Reembolso ao cliente</span><select id="customer-refund-filter" aria-label="Reembolso ao cliente"><option value="all">Todos</option><option value="recorded" ${state.customerRefund === 'recorded' ? 'selected' : ''}>Com reembolso registrado</option><option value="not_found" ${state.customerRefund === 'not_found' ? 'selected' : ''}>Sem reembolso identificado</option></select></label>${localReviewFilterMarkup(data, 'customer-returns')}<span class="result-count">${counted(total, 'devolução', 'devoluções')}</span></div></div>${rows.length ? `<div class="table-scroll"><table><thead><tr><th>Data</th><th>Pedido / produto</th><th>Envio</th><th>Rastreio da devolução</th><th>Status da devolução</th><th>Motivo da devolução</th><th>Reembolso ao cliente</th><th>Status da análise</th><th>Acompanhamento</th></tr></thead><tbody>${rows.map(row => `<tr><td>${customerReturnDates(row)}${isMultipleStores(state.storeId) ? `<small>${escape(storeName(row.storeId))}</small>` : ''}</td><td class="product-cell">${customerReturnOrder(row)}<small>Quantidade: ${number(row.quantity)}</small></td><td>${modeBadge(row.fulfillmentMode)}</td><td>${customerReturnTracking(row)}</td><td>${badge(row.returnStatus || 'Não informado')}<small>${escape(row.sourceLabel || 'Fonte não informada')}</small></td><td class="return-reason-cell">${customerReturnReason(row)}</td><td>${customerReturnRefund(row)}</td><td>${reviewBadge(row.review, 'customer-returns')}</td><td><div class="row-actions">${localReviewButton('customer-returns', row.storeId, row.returnId)}<button type="button" class="button compact" data-customer-return="${escape(row.returnId)}" data-store="${escape(row.storeId)}">Detalhes</button></div></td></tr>`).join('')}</tbody></table></div>` : empty(missing ? 'Devoluções ainda não consultadas' : 'Nenhuma devolução encontrada nos dados importados', missing ? 'A consulta dos relatórios permitirá exibir os registros disponíveis.' : 'Confira a busca e os filtros. A ausência se refere somente às fontes importadas.')}<div class="bulk-selection-bar"><span>${counted(summary.refundedCount ?? 0, 'com reembolso registrado', 'com reembolso registrado')}</span><span>${counted(summary.withoutRefundCount ?? 0, 'sem reembolso identificado', 'sem reembolso identificado')}</span></div>${pagination(total, rows.length)}</section>`;
}
function customerReturnDetailMarkup(row) {
  const dates = `${row.requestedAt ? customerReturnField('Data da solicitação', escape(date(row.requestedAt))) : ''}${row.receivedAt ? customerReturnField('Data do recebimento', escape(date(row.receivedAt))) : ''}${!row.requestedAt && !row.receivedAt ? customerReturnField('Data da devolução', '<span class="muted">Não informada</span>') : ''}`;
  return `<section class="detail-section returned-order-metadata" aria-label="Resumo da devolução"><dl><div><dt>Modalidade</dt><dd>${modeBadge(row.fulfillmentMode)}</dd></div><div><dt>Status da devolução</dt><dd>${badge(row.returnStatus || 'Não informado')}</dd></div><div><dt>Quantidade</dt><dd>${number(row.quantity)}</dd></div><div><dt>Loja</dt><dd>${escape(storeName(row.storeId))}</dd></div></dl></section>
  <div class="customer-return-essentials" data-return-section="Devolução e rastreio">
  <section class="detail-section return-detail-panel customer-return-facts"><h3>Devolução</h3><dl class="return-facts">${dates}${customerReturnField('Tipo de devolução', escape(row.returnType || 'Não informado'))}${customerReturnField('Autorização de devolução (RMA)', `<span class="return-reference">${escape(row.rmaId || 'Não informado')}</span>`)}${customerReturnField('Motivo informado pela Amazon', customerReturnReason(row, true), true)}</dl></section>
  <section class="detail-section return-detail-panel customer-return-tracking"><h3>Rastreio da devolução</h3><div class="return-tracking-summary">${customerReturnTracking(row)}</div><details class="customer-return-tracking-help"><summary>Sobre este rastreio</summary><p class="detail-info">O rastreio é exibido apenas quando vinculado ao código desta devolução. O status da solicitação não representa um evento de transporte.</p></details></section>
  </div><div class="customer-return-accounting" data-return-section="Reembolso e pedido"><div class="customer-return-pair">
  <section class="detail-section return-detail-panel"><h3>Reembolso ao cliente</h3>${customerReturnRefund(row, true)}${financialExcluded(row) ? '' : `<p class="detail-info return-detail-note">${row.refund?.source === 'return-report' ? 'Informação de reembolso fornecida pelo relatório de devolução.' : row.refund?.source === 'financial-transactions' ? 'Lançamentos financeiros identificados para o pedido.' : 'A identificação depende dos dados importados.'} Não confirma depósito bancário nem ressarcimento ao vendedor.</p>`}</section>
  <section class="detail-section return-detail-panel"><h3>Pedido e produto</h3><div class="return-product-summary">${customerReturnOrder(row)}</div></section></div>
  ${localReviewSummary(row, 'customer-returns', row.returnId, { compact: true })}
  <p class="footnote customer-return-source">Fonte: ${escape(row.sourceLabel || 'Não informada')} · Consultado em ${escape(date(row.observedAt, true))}.</p></div>`;
}
let customerReturnRequest = 0;
function openCustomerReturnGroup(storeId, orderId, records) {
  const returns = [...new Map(records.filter(row => row.orderId === orderId && row.returnId).map(row => [row.returnId, row])).values()];
  if (!returns.length) { showMessage('O registro da devolução não está disponível. Atualize a lista e tente novamente.', 'warning'); return; }
  return openCustomerReturn(storeId, returns[0].returnId, { orderId, returns });
}
async function openCustomerReturn(storeId, returnId, related = null) {
  const request = ++customerReturnRequest, dialog = $('#customer-return-dialog');
  $('#customer-return-title').textContent = 'Detalhes da devolução';
  $('#customer-return-detail').innerHTML = '<div class="loading-state"><span class="spinner"></span>Carregando devolução…</div>';
  if (!dialog.open) dialog.showModal();
  try {
    const row = await api(`/api/customer-returns/${encodeURIComponent(returnId)}?${new URLSearchParams({ storeId })}`);
    if (!dialog.open || request !== customerReturnRequest) return;
    if (row.returnId !== returnId || row.storeId !== storeId || related && row.orderId !== related.orderId) throw new Error('INVALID_RETURN_RESPONSE');
    $('#customer-return-title').textContent = row.orderId ? `Pedido ${row.orderId}` : 'Detalhes da devolução';
    const choices = related?.returns?.length > 1 ? `<nav class="return-detail-choices" aria-label="Devoluções deste pedido">${related.returns.map((item, index) => `<button type="button" class="button compact ${item.returnId === returnId ? 'primary' : ''}" data-related-return-detail="${escape(item.returnId)}" aria-pressed="${item.returnId === returnId}">Devolução ${index + 1}${item.requestedAt || item.receivedAt ? ` · ${escape(date(item.requestedAt || item.receivedAt))}` : ''}</button>`).join('')}</nav>` : '';
    $('#customer-return-detail').innerHTML = choices + customerReturnDetailMarkup(row);
    layout.tabbedSections($('#customer-return-detail'), node => node.dataset.returnSection, { label: 'Informações da devolução' });
    $('#customer-return-detail').querySelectorAll('[data-related-return-detail]').forEach(button => button.addEventListener('click', () => openCustomerReturn(storeId, button.dataset.relatedReturnDetail, related)));
    bindLocalReviewButtons($('#customer-return-detail'));
    $('#customer-return-detail').querySelectorAll('[data-copy-order]').forEach(button => button.addEventListener('click', () => copyOrderNumber(button)));
  } catch (error) { if (dialog.open && request === customerReturnRequest) $('#customer-return-detail').innerHTML = `<div class="notice error">${escape(error.message)}</div>`; }
}
function returnDetectionMarkup(row) {
  if (row.detectionKind !== 'transition' || !row.transitionDetectedAt || !Number.isFinite(Date.parse(row.transitionDetectedAt))) return '';
  return `<strong>Mudança detectada em</strong><span>${escape(date(row.transitionDetectedAt, true))}</span><small>Observação do sistema; não é a hora exata da transportadora.</small>`;
}
function returnRefundMarkup(refund, row) {
  if (financialExcluded(row) || financialExcluded(refund)) return pendingPaymentMarkup();
  if (refund?.status !== 'recorded') return `<span class="muted">Não encontrado nos dados importados</span>`;
  const unknownOriginal = refund.hasUnknownOriginalDate || refund.hasUndatedTransactions;
  const originalDate = refund.latestPostedAt ? `<small>${unknownOriginal ? 'Última data original conhecida' : 'Último reembolso original'}: ${escape(date(refund.latestPostedAt, true))}</small>` : '<small>Data original não disponível</small>';
  const movementDate = refund.latestMovementPostedAt && refund.latestMovementPostedAt !== refund.latestPostedAt ? `<small>Última movimentação financeira: ${escape(date(refund.latestMovementPostedAt, true))}</small>` : '';
  return `${badge('Reembolso registrado', 'good')}${originalDate}${unknownOriginal && refund.latestPostedAt ? '<small>Há reembolso com data original não disponível.</small>' : ''}${movementDate}<small>${number(refund.count)} ${refund.count === 1 ? 'reembolso identificado' : 'reembolsos identificados'}</small>`;
}
function returnAlertMarkup(row) {
  if (financialExcluded(row)) return pendingPaymentMarkup();
  const alert = row.alert || {};
  if (row.detectionKind !== 'transition') return `${badge('Conferir data na Amazon', 'amber')}<small>Sem contagem iniciada: data da alteração não identificada.</small>`;
  if (row.refund?.status === 'recorded' && (!row.refund.latestPostedAt || row.refund.hasUnknownOriginalDate || row.refund.hasUndatedTransactions)) return `${badge('Conferir data na Amazon', 'amber')}<small>Data original do reembolso não disponível. Sem contagem iniciada.</small>`;
  if (alert.state === 'needs-confirmation') return `${badge('Conferir data na Amazon', 'amber')}<small>Referência do alerta ainda não confirmada. Sem contagem iniciada.</small>`;
  if (alert.state === 'pending-refund') return `${badge('Acompanhar reembolso', 'neutral')}<small>Reembolso não encontrado nos dados importados.</small>`;
  if (alert.basis !== 'internal-observation' || !alert.dueAt || Number.isNaN(Date.parse(alert.dueAt))) return `${badge('Conferir referência', 'amber')}<small>Data para o alerta interno não disponível.</small>`;
  const states = { open: ['Em acompanhamento', 'blue'], 'due-today': ['Alerta para hoje', 'amber'], overdue: ['Alerta interno vencido', 'red'] };
  const [label, color] = states[alert.state] || ['Conferir referência', 'neutral'];
  const remaining = Number.isInteger(alert.daysRemaining) && alert.daysRemaining > 0 ? `<small>${number(alert.daysRemaining)} ${alert.daysRemaining === 1 ? 'dia restante' : 'dias restantes'} na referência interna</small>` : '';
  return `${badge(label, color)}<small>Data interna: ${escape(date(alert.dueAt))}</small>${remaining}`;
}
function returnTrackingMarkup(row) {
  const detailed = statusLabels[row.detailedStatus] || row.detailedStatus;
  const status = statusLabels[row.status] || row.status;
  return `${badge(detailed || status || 'Status não informado', 'blue')}${row.detailedStatus && row.status && row.detailedStatus !== row.status ? `<small>${escape(status)}</small>` : ''}<small class="return-tracking-number">Código: ${escape(row.trackingNumber || 'Não informado')}</small><small>${number(row.returnedPackageCount)} de ${number(row.packageCount)} pacotes com devolução detectada</small>${row.partialReturn ? badge('Devolução parcial de pacotes', 'amber') : ''}`;
}
function returnMonitorMarkup(monitor) {
  const running = monitor?.state === 'running';
  const title = running ? (monitor.intervalMinutes === 60 ? 'Monitoramento horário em execução' : 'Monitoramento em execução') : monitor?.state === 'stopped' ? 'Monitoramento parado' : 'Monitoramento não confirmado';
  const schedule = running ? `<div class="return-monitor-times"><span>Última coleta concluída: <strong>${monitor.lastCompletedAt ? escape(date(monitor.lastCompletedAt, true)) : 'Primeira consulta em andamento'}</strong></span><span>Próxima consulta prevista: <strong>${monitor.nextRunAt ? escape(date(monitor.nextRunAt, true)) : 'Após concluir esta rodada'}</strong></span></div>` : '';
  return `<section class="return-monitor" aria-label="Monitoramento das devoluções"><div class="return-monitor-heading">${icon('clock')}<strong>${title}</strong>${badge(running ? 'Em execução' : monitor?.state === 'stopped' ? 'Parado' : 'Não confirmado', running ? 'good' : 'neutral')}</div>${schedule}<p>${running ? 'As consultas dependem de o computador e o sistema permanecerem ligados. O horário previsto pode mudar após falhas ou interrupções.' : 'Esta página mostra as observações já importadas. Não há confirmação de novas consultas automáticas em execução.'}</p>${monitor?.trackingLookbackDays ? `<p>Rastreio de pedidos DBA importados, criados nos últimos ${number(monitor.trackingLookbackDays)} dias. Pedidos alterados nos últimos ${number(monitor.orderLookbackDays)} dias, inclusive antigos. Financeiro: lançamentos dos últimos ${number(monitor.financialLookbackDays)} dias.</p>` : ''}${monitor?.lastErrorCode ? '<p class="inline-warning">A última tentativa encontrou uma falha. Confira a data da última coleta concluída.</p>' : ''}</section>`;
}
function returnPolicyMarkup(policy) {
  const counting = policy?.kind === 'calendar' ? 'Referência provisória de 5 dias corridos' : policy?.kind === 'business' ? 'Referência de 5 dias úteis' : 'Contagem de dias ainda a confirmar';
  return `${counting} para acompanhar SAFE-T. As datas de observação do rastreio e de lançamento do reembolso não são, necessariamente, as datas do evento e da notificação. Confira a elegibilidade e o prazo oficial na <a class="return-policy-link" href="https://sellercentral.amazon.com.br/help/hub/reference/GNGYMYPKATHYPHJN" target="_blank" rel="noopener noreferrer">política da Amazon</a>.`;
}
function returnsMarkup(data) {
  return returnedManagementModule.renderReturnedManagement(data, state, {
    number, money, date, badge, metric, icon, empty,
    orderNumber: orderNumberMarkup, tracking: returnTrackingMarkup, detection: returnDetectionMarkup,
    refund: returnRefundMarkup, alert: returnAlertMarkup, reviewBadge,
    reviewFilter: localReviewFilterMarkup, monitor: returnMonitorMarkup, policy: returnPolicyMarkup,
  });
}
function returnDetailMarkup(row, policy, order) {
  const refund = row.refund || {};
  const detection = returnDetectionMarkup(row);
  return `<section class="detail-section return-detail"><h3>Devolvido ao vendedor</h3><div class="return-detail-grid"><div><h4>Rastreamento</h4>${order.packages?.length ? `${orderTrackingMarkup(order)}<small>${number(row.returnedPackageCount)} de ${number(row.packageCount)} pacotes com devolução detectada</small>${row.partialReturn ? badge('Devolução parcial de pacotes', 'amber') : ''}` : `${returnTrackingMarkup(row)}<small>Última consulta: ${escape(date(order.trackingObservedAt || order.observedAt, true))}</small>`}</div>${detection ? `<div><h4>Detecção</h4>${detection}${row.previousObservedAt ? `<small>Consulta anterior: ${escape(date(row.previousObservedAt, true))}</small>` : ''}</div>` : ''}<div><h4>Reembolso ao cliente</h4>${returnRefundMarkup(refund, row)}${!financialExcluded(row) && refund.status === 'recorded' && refund.firstPostedAt ? `<small>Primeiro reembolso com data original conhecida: ${escape(date(refund.firstPostedAt, true))}</small>` : ''}</div><div><h4>Ressarcimento ao vendedor</h4>${reimbursementMarkup(row)}<small>Crédito registrado na Amazon; não confirma depósito bancário.</small></div><div><h4>Alerta interno (5 dias)</h4>${returnAlertMarkup(row)}${!financialExcluded(row) && row.detectionKind === 'transition' && row.alert?.referenceAt ? `<small>Referência observada em ${escape(date(row.alert.referenceAt, true))}</small>` : ''}</div></div><details class="return-date-explanation"><summary>Sobre as datas e o alerta interno</summary><p class="footnote">${returnPolicyMarkup(policy)} Reembolsos encontrados são do pedido e não comprovam cobertura de todos os pacotes.</p></details></section>`;
}
const safeTClaimUrl = 'https://sellercentral.amazon.com.br/safet-claims/create-v2?ref_=ag_sfdcf_cont_safet';
function safeTClaimLink(row) {
  return `<a class="button compact" href="${safeTClaimUrl}" target="_blank" rel="noopener noreferrer" data-safe-t-claim="${escape(row.orderId)}" aria-label="Solicitar SAFE-T do pedido ${escape(row.orderId)} na Amazon, em nova aba">Solicitar SAFE-T ${icon('arrow')}</a>`;
}
function safeTOrderNumber(row) {
  return `<span class="order-id-control">${row.order ? `<button type="button" class="order-link" data-safe-t-order="${escape(row.orderId)}" data-store="${escape(row.storeId)}">${escape(row.orderId)}</button>` : `<span>${escape(row.orderId)}</span>`}<button class="copy-order" type="button" data-copy-order="${escape(row.orderId)}" aria-label="Copiar número do pedido ${escape(row.orderId)}">${icon('copy')}<span class="copy-label">Copiar número</span></button></span>`;
}
function safeTProductMarkup(product) {
  return `<span class="product-name">${escape(product?.title || 'Produto não informado')}</span><small>SKU: ${escape(product?.sku || 'Não informado')}</small>${product?.asin ? `<small>ASIN: ${escape(product.asin)}</small>` : ''}<span class="product-quantity"><span>Quantidade</span><strong>${number(product?.quantityOrdered)}</strong></span>`;
}
function safeTRefundDate(refund) {
  if (!refund?.dateKnown) return `<span class="muted">Data original não disponível${refund?.latestPostedAt ? ' ou incompleta' : ''}</span>${refund?.latestPostedAt ? `<small>Última data conhecida: ${escape(date(refund.latestPostedAt, true))}</small>` : ''}`;
  return escape(date(refund.latestPostedAt, true));
}
function safeTRefundMarkup(refund, row) {
  if (financialExcluded(row) || financialExcluded(refund)) return pendingPaymentMarkup();
  const unallocated = refund?.allocation === 'multiple-orders-unallocated';
  return `${unallocated ? '<span class="muted">Valor não rateado por pedido</span>' : currencyValues(refund?.byCurrency, 'totalCents')}${refund?.source === 'return-report' ? '<small>Informado no relatório de devolução</small>' : ''}${Number.isSafeInteger(refund?.count) ? `<small>${counted(refund.count, 'reembolso identificado', 'reembolsos identificados')}</small>` : ''}`;
}
function safeTCategoryOptions(data) {
  const choices = [], seen = new Set();
  for (const item of data.statusOptions || []) {
    if (typeof item.code !== 'string' || item.code.toLowerCase() === 'all' || seen.has(item.code)) continue;
    seen.add(item.code); choices.push(item);
  }
  for (const code of filterCodes(state.safeTStatus)) if (!seen.has(code)) choices.push({ code, label: state.safeTStatusLabels[code] || code, count: 0 });
  return choices;
}
function safeTCategoriesMarkup(data) {
  const selected = new Set(filterCodes(state.safeTStatus));
  const allCount = data.summary?.availableOrderCount ?? data.statusOptions?.find(item => item.code === 'all')?.count ?? (selected.size ? null : data.total);
  const choices = [{ code: 'all', label: 'Todos', count: allCount }, ...safeTCategoryOptions(data)];
  return `<div class="refund-reimbursement-bar safe-t-categories"><span class="filter-field-label">Situações identificadas</span><div class="reimbursement-choices" role="group" aria-label="Situações: selecione uma ou mais opções">${choices.map(item => `<button class="reimbursement-choice" id="safe-t-category-${escape(item.code)}" type="button" data-safe-t-category="${escape(item.code)}" aria-pressed="${item.code === 'all' ? selected.size === 0 : selected.has(item.code)}"><span>${escape(item.label || item.code)}</span>${Number.isSafeInteger(item.count) ? `<span class="filter-option-count">${number(item.count)}</span>` : ''}</button>`).join('')}</div><small class="muted">Um pedido pode aparecer em mais de uma situação. A lista reúne as opções selecionadas sem duplicar pedidos.</small></div>`;
}
function safeTMarkup(data) {
  const rows = data.items || [], total = data.total ?? rows.length;
  return `${coverageNotice()}<div class="notice">${icon('info')}<span>Esta lista ajuda na conferência; não confirma elegibilidade ao SAFE-T. O botão abre a Amazon e tenta copiar o pedido. Confira a conta e os requisitos antes de preencher. Nenhuma solicitação é enviada automaticamente.</span></div><p class="footnote">${state.from || state.to ? 'O período considera as datas originais de reembolso conhecidas. Casos sem data podem ser encontrados em Todo histórico.' : 'Todo o histórico importado, incluindo os pedidos sem data original de reembolso.'} Valores preservam o sinal informado e não confirmam depósito bancário.</p>${data.summary?.withoutDateCount > 0 ? `<p class="footnote">${counted(data.summary.withoutDateCount, 'pedido tem', 'pedidos têm')} data original de reembolso não disponível ou incompleta. ${state.from || state.to ? '<button type="button" class="button compact" data-financial-all>Ver todo o histórico</button>' : ''}</p>` : ''}<section class="panel"><div class="table-toolbar"><label class="search-box">${icon('search')}<span class="sr-only">Pesquisar pedido, produto, SKU ou ASIN</span><input id="search" type="search" maxlength="200" placeholder="Pesquisar pedido, produto, SKU ou ASIN" value="${escape(state.query)}" autocomplete="off"></label><div class="table-filters"><label><span class="sr-only">Modalidade de envio</span><select id="mode-filter" aria-label="Modalidade de envio"><option value="all">Todas as modalidades</option>${[['FBA', 'FBA'], ['DBA', 'DBA'], ['MFN', 'Envio próprio'], ['unknown', 'Não identificada']].map(([code, label]) => `<option value="${code}" ${state.mode === code ? 'selected' : ''}>${label}</option>`).join('')}</select></label><span class="result-count">${counted(total, 'pedido', 'pedidos')}</span></div></div>${safeTCategoriesMarkup(data)}${rows.length ? `<div class="table-scroll"><table class="safe-t-table"><thead><tr><th>Pedido</th><th>Data do reembolso</th><th>Produto</th><th>Envio</th><th>Status do pedido</th><th class="numeric">Reembolso</th><th>Ações</th></tr></thead><tbody>${rows.map(row => `<tr><td>${safeTOrderNumber(row)}${isMultipleStores(state.storeId) ? `<small>${escape(storeName(row.storeId))}</small>` : ''}</td><td>${safeTRefundDate(row.refund)}</td><td class="product-cell">${safeTProductMarkup(row.products?.[0])}${row.products?.length > 1 ? `<small>+${number(row.products.length - 1)} ${row.products.length === 2 ? 'produto' : 'produtos'}</small>` : ''}</td><td>${modeBadge(row.fulfillmentMode)}</td><td>${orderDisplayStatusMarkup({ ...row.order, displayStatus: row.displayStatus || row.order?.displayStatus })}</td><td class="numeric">${safeTRefundMarkup(row.refund, row)}</td><td><div class="safe-t-actions"><button type="button" class="button compact" data-safe-t-detail="${escape(row.orderId)}" data-store="${escape(row.storeId)}">Detalhes</button>${safeTClaimLink(row)}</div></td></tr>`).join('')}</tbody></table></div>` : empty('Nenhum pedido encontrado neste recorte', 'Ajuste o período, a busca ou as situações. A ausência se refere somente aos dados importados.')}${pagination(total, rows.length)}</section>`;
}
function safeTDetailMarkup(row) {
  const refundCases = row.refundCaseIds || [], returns = row.customerReturns || [];
  return `<div class="detail-meta"><span>${escape(storeName(row.storeId))}</span>${modeBadge(row.fulfillmentMode)}${orderDisplayStatusMarkup({ ...row.order, displayStatus: row.displayStatus || row.order?.displayStatus })}</div><section class="detail-section"><h3>Pedido</h3>${safeTOrderNumber(row)}${!row.order ? '<p class="detail-info">O pedido ainda não está disponível na base de pedidos importada.</p>' : ''}${(row.products?.length ? row.products : [null]).map(product => `<div class="safe-t-detail-product">${safeTProductMarkup(product)}</div>`).join('')}</section><section class="detail-section"><h3>Reembolso</h3>${safeTRefundMarkup(row.refund, row)}<p class="detail-info">${safeTRefundDate(row.refund)}</p><p class="detail-info">Os valores preservam a fonte e a moeda informadas; não confirmam depósito bancário.${row.refund?.allocation === 'multiple-orders-unallocated' ? ' O caso financeiro reúne vários pedidos; o valor não foi dividido entre eles.' : ''}</p>${refundCases.map((caseId, index) => `<button type="button" class="button compact" data-safe-t-refund="${escape(caseId)}" data-store="${escape(row.storeId)}">${refundCases.length > 1 ? `Ver reembolso ${index + 1}` : 'Ver reembolso'}</button>`).join(' ')}</section><section class="detail-section"><h3>Registros de devolução</h3>${returns.length ? returns.map((item, index) => `<div class="safe-t-related-record"><div><strong>Devolução ${index + 1}</strong><small>Status informado: ${escape(item.returnStatus || 'Não informado')}</small>${customerReturnDates(item)}</div><button type="button" class="button compact" data-safe-t-return="${escape(item.returnId)}" data-store="${escape(row.storeId)}">Ver devolução</button></div>`).join('') : '<p class="detail-info">Nenhum registro identificado em Devoluções nos dados importados.</p>'}${row.returnedToSeller ? `<div class="safe-t-related-record"><div><strong>Devolvido ao vendedor</strong><small>Detectado em ${escape(date(row.returnedToSeller.detectedAt, true))}</small>${row.returnedToSeller.returnStatusChanged ? '<small>O rastreio mudou após essa detecção.</small>' : ''}</div><button type="button" class="button compact" data-safe-t-returned="${escape(row.orderId)}" data-store="${escape(row.storeId)}">Ver registro</button></div>` : '<p class="detail-info">Nenhum registro identificado em Devolvido ao vendedor nos dados importados.</p>'}</section><section class="detail-section"><h3>Abrir solicitação na Amazon</h3><p class="detail-info">Confira a conta, o pedido e os requisitos na Amazon. Este atalho não confirma elegibilidade, não envia a solicitação e não altera o acompanhamento local.</p><div id="safe-t-action-message" role="status" aria-live="polite"></div>${safeTClaimLink(row)}</section>`;
}
function openSafeTDetail(storeId, orderId) {
  const row = state.view === 'safe-t' ? state.data?.items?.find(item => item.storeId === storeId && item.orderId === orderId) : null;
  if (!row) return;
  $('#safe-t-title').textContent = `Pedido ${orderId}`;
  $('#safe-t-detail').innerHTML = safeTDetailMarkup(row);
  bindSafeTButtons($('#safe-t-detail'));
  $('#safe-t-detail').querySelectorAll('[data-copy-order]').forEach(button => button.addEventListener('click', () => copyOrderNumber(button)));
  $('#safe-t-dialog').showModal();
}
function bindSafeTButtons(root) {
  const leave = action => { if ($('#safe-t-dialog').open) $('#safe-t-dialog').close(); action(); };
  root.querySelectorAll('[data-safe-t-claim]').forEach(link => link.addEventListener('click', () => openSafeTClaim(link)));
  root.querySelectorAll('[data-safe-t-detail]').forEach(button => button.addEventListener('click', () => openSafeTDetail(button.dataset.store, button.dataset.safeTDetail)));
  root.querySelectorAll('[data-safe-t-order]').forEach(button => button.addEventListener('click', () => leave(() => openOrder(button.dataset.store, button.dataset.safeTOrder))));
  root.querySelectorAll('[data-safe-t-return]').forEach(button => button.addEventListener('click', () => leave(() => openCustomerReturn(button.dataset.store, button.dataset.safeTReturn))));
  root.querySelectorAll('[data-safe-t-refund]').forEach(button => button.addEventListener('click', () => leave(() => openFinancialCase('refunds', button.dataset.store, button.dataset.safeTRefund))));
  root.querySelectorAll('[data-safe-t-returned]').forEach(button => button.addEventListener('click', () => leave(() => openRelatedReturns('returns', button.dataset.store, button.dataset.safeTReturned))));
}
async function openSafeTClaim(link) {
  // The real link opens through the user's click with noopener/noreferrer; no form is submitted.
  let copied = false;
  try { await writeOrderClipboard(link.dataset.safeTClaim, link); copied = true; } catch {}
  const message = copied ? 'Pedido copiado. Cole o número no campo Número do pedido e clique em Verificar Elegibilidade.' : 'Não foi possível copiar o pedido. Copie o número manualmente, cole no campo Número do pedido e clique em Verificar Elegibilidade.';
  const target = $('#safe-t-dialog').open ? $('#safe-t-action-message') : null;
  if (target) target.innerHTML = `<p class="${copied ? 'detail-info' : 'inline-warning'}">${escape(message)}</p>`;
  else showMessage(message, copied ? '' : 'warning');
  $('#copy-announcement').textContent = message;
}
function pagination(total, count) { const pages = Math.max(1, Math.ceil(total / state.pageSize)); return `<div class="table-footer"><span>${count ? `${number(state.page * state.pageSize + 1)}–${number(state.page * state.pageSize + count)} de ${number(total)}` : '0 resultados'} · dados importados</span><div class="pagination"><button id="prev-page" aria-label="Página anterior" ${state.page === 0 ? 'disabled' : ''}>${icon('arrowLeft')}</button><span>${state.page + 1} / ${pages}</span><button id="next-page" aria-label="Próxima página" ${state.page + 1 >= pages ? 'disabled' : ''}>${icon('arrow')}</button></div></div>`; }
function inventorySummary(data) {
  if (data?.summary) return data.summary;
  const items = data?.items || [], whole = items.length === data?.total;
  const sum = fn => { const quantities = items.map(fn); return whole && quantities.every(v => Number.isSafeInteger(v)) ? quantities.reduce((a, b) => a + b, 0) : null; };
  return { usableQuantity: sum(i => inventoryQuantities(i).usableQuantity), internalMovementQuantity: sum(i => inventoryQuantities(i).internalMovement), totalQuantity: sum(i => i.totalQuantity), fulfillableQuantity: sum(i => i.inventoryDetails?.fulfillableQuantity), reservedQuantity: sum(i => i.inventoryDetails?.reservedQuantity?.totalReservedQuantity), unfulfillableQuantity: sum(i => i.inventoryDetails?.unfulfillableQuantity?.totalUnfulfillableQuantity), researchingQuantity: sum(i => i.inventoryDetails?.researchingQuantity?.totalResearchingQuantity), inboundQuantity: sum(i => { const d = i.inventoryDetails || {}; return [d.inboundWorkingQuantity, d.inboundShippedQuantity, d.inboundReceivingQuantity].every(Number.isSafeInteger) ? d.inboundWorkingQuantity + d.inboundShippedQuantity + d.inboundReceivingQuantity : null; }) };
}
function qty(value, available = false) { return `<span class="stock-qty ${value === 0 ? 'zero' : available ? 'available' : ''}">${number(value)}</span>`; }
function inventoryCoverageNotice(data) {
  const forecastNotice = data.forecastState === 'loading' ? '<div class="notice" role="status">Estoque carregado. Calculando vendas e duração prevista…</div>' : data.forecastState === 'failed' ? '<div class="notice warning" role="status">As quantidades estão disponíveis. Não foi possível calcular a previsão de vendas agora. Use Atualizar painel para tentar novamente.</div>' : '';
  const messages = {
    missing: 'Ainda não há consulta de estoque para todas as lojas selecionadas. Os indicadores permanecem em aberto.',
    incomplete: 'A consulta de estoque ainda está incompleta. Os indicadores serão exibidos após receber uma posição completa de cada loja.',
    partial: 'A consulta mais recente é parcial. Os produtos ausentes nessa consulta conservam a última posição conhecida.',
    stale: 'A última tentativa de consulta não foi concluída. O estoque mantém os valores da coleta anterior.',
  };
  return forecastNotice + (messages[data.state] ? `<div class="notice warning">${icon('info')}<span>${escape(messages[data.state])}</span></div>` : '');
}
function inventoryMarkup(data) {
  const summary = inventorySummary(data), all = data.items || [];
  const filtered = selectedInventoryItems(data), sorted = filtered;
  const items = sorted.slice(state.page * state.pageSize, (state.page + 1) * state.pageSize);
  return `<div class="inventory-report-bar"><div class="inventory-observed">${icon('inventory')}<span>Estoque observado${data.observationRange?.to ? ` · ${escape(date(data.observationRange.to, true))}` : ''}.</span></div><div class="inventory-report-action"><button type="button" class="button" id="download-inventory-report" ${!filtered.length || all.length < data.total ? 'disabled' : ''} title="Baixar todos os produtos dos filtros aplicados, incluindo as outras páginas">${icon('download')}Baixar relatório</button><small>${counted(filtered.length, 'produto', 'produtos')} · CSV para Excel</small></div></div>${inventoryCoverageNotice(data)}${inventoryPlanning.inventoryOverview(summary)}<section class="inventory-cost-summary"><div><span class="eyebrow">VALOR DO ESTOQUE FBA</span><h2>A preço de custo</h2></div><div>${stockCostSummary(data.costSummary)}</div>${data.costSummary?.observedAt ? `<small>Custos de ${escape(date(data.costSummary.observedAt, true))}</small>` : ''}</section>
  ${inventoryPlanning.planningControls(all, inventoryPreferences)}
  <section class="panel"><div class="table-toolbar"><label class="search-box">${icon('search')}<span class="sr-only">Pesquisar produto, SKU, ASIN ou FNSKU</span><input id="search" type="search" maxlength="200" placeholder="Pesquisar produto, SKU, ASIN ou FNSKU" value="${escape(state.query)}" autocomplete="off"></label><div class="table-filters"><label><span class="sr-only">Situação de estoque</span><select id="stock-filter" aria-label="Situação de estoque"><option value="all">Todos os produtos</option><option value="available" ${state.stock === 'available' ? 'selected' : ''}>Com unidades disponíveis</option><option value="zero" ${state.stock === 'zero' ? 'selected' : ''}>Sem unidades disponíveis</option><option value="unfulfillable" ${state.stock === 'unfulfillable' ? 'selected' : ''}>Com unidades indisponíveis</option></select></label>${inventoryPlanning.durationSortControl(state.inventoryDurationSort, true)}<span class="result-count">${number(filtered.length)} registros de SKU</span></div></div>
  ${items.length ? `<div class="table-scroll"><table class="inventory-plan-table"><thead><tr><th>Produto / SKU</th><th>Total Amazon apto</th><th>Vendas · ${inventoryPreferences.period} dias</th><th aria-sort="${state.inventoryDurationSort === 'asc' ? 'ascending' : state.inventoryDurationSort === 'desc' ? 'descending' : 'none'}">${inventoryPlanning.durationSortControl(state.inventoryDurationSort)}</th><th>Situação / ação</th><th>Custo do estoque</th><th>Estoque detalhado</th></tr></thead><tbody>${items.map(item => { const d = item.inventoryDetails || {}, r = d.reservedQuantity || {}, u = d.unfulfillableQuantity || {}; const incoming = [d.inboundWorkingQuantity, d.inboundShippedQuantity, d.inboundReceivingQuantity].every(Number.isSafeInteger) ? d.inboundWorkingQuantity + d.inboundShippedQuantity + d.inboundReceivingQuantity : null; return `<tr class="${inventoryPlanning.stockPlan(item, inventoryPreferences).status === 'excess' ? 'inventory-stock-excess' : ''}"><td class="product-cell"><span class="product-name">${escape(item.title || item.sellerSku || 'Produto sem descrição')}</span><small>${escape(item.sellerSku || 'SKU não informado')} · ${inventoryAsinLink(item.asin)}</small>${isMultipleStores(state.storeId) ? `<small>${escape(storeName(item.storeId))}</small>` : ''}</td><td><strong class="inventory-available">${qty(inventoryQuantities(item).usableQuantity, true)}</strong><small>${number(d.fulfillableQuantity)} disponíveis para venda</small></td>${inventoryPlanning.planningCells(item, inventoryPreferences, {number, date, localDay, addDays})}<td class="product-cost-cell">${productCostMarkup(item.cost, true)}</td><td class="stock-detail"><details><summary>Ver quantidades</summary><p>Total Amazon informado: ${qty(item.totalQuantity)}<br>Disponível para venda: ${qty(d.fulfillableQuantity)}<br>Reservadas: ${qty(r.totalReservedQuantity)}<br>Em entrada: ${qty(incoming)}<br>Indisponíveis: ${qty(u.totalUnfulfillableQuantity)}<br>FNSKU: ${escape(item.fnSku || 'Não informado')}<br>Reserva por pedido: ${number(r.pendingCustomerOrderQuantity)}<br>Transferência interna: ${number(r.pendingTransshipmentQuantity)}<br>Processamento Amazon: ${number(r.fcProcessingQuantity)}<br>Em investigação: ${number(d.researchingQuantity?.totalResearchingQuantity)}<br>Última alteração: ${escape(date(item.updatedAt, true))}<br>Estoque observado em: ${escape(date(item.observedAt, true))}</p></details></td></tr>`; }).join('')}</tbody></table></div>` : empty('Nenhum produto encontrado', 'Ajuste a busca, a situação do estoque ou o alerta selecionado.')}${pagination(filtered.length, items.length)}</section>
  <details class="inventory-method"><summary>Como calculamos o estoque e a previsão</summary><p>Total Amazon apto = disponível + entrada + transferência interna + processamento Amazon. Reservas de pedidos, unidades indisponíveis e em investigação ficam fora desse saldo. A duração prevista abaixo continua usando apenas o disponível para venda.</p><p>Estoque disponível ÷ média diária de unidades vendidas em pedidos FBA confirmados, por SKU e loja. São usados os últimos ${inventoryPreferences.period} dias completos do histórico importado, indicados em cada produto. Cancelamentos e pedidos aguardando pagamento não entram. Reembolsos não são subtraídos das vendas, pois a devolução pode não voltar ao estoque vendável.</p><p>Meta ideal: ${inventoryPlanning.STOCK_COVERAGE.idealDays} dias de estoque. Até ${inventoryPlanning.STOCK_COVERAGE.goodDays} dias a cobertura é boa; acima disso, o produto recebe o alerta Excesso de estoque. Os alertas de reposição continuam seguindo o prazo de operação e a margem definidos abaixo. Produtos disponíveis sem vendas têm um alerta separado, pois não há média para estimar a duração.</p><p>Agendar até = data estimada de esgotamento − ${inventoryPreferences.leadDays} dias até a venda − ${inventoryPreferences.bufferDays} dias de margem. Reservas, unidades indisponíveis e remessas em entrada não estendem essa previsão. A projeção não mede dias em que o produto ficou sem estoque; sazonalidade, promoções e atrasos podem mudar o consumo e o prazo.</p><p>Histórico incompleto, histórico com mais de 7 dias de atraso ou estoque sem atualização há mais de 2 dias ficam sem previsão confiável. Os prazos escolhidos são lembrados neste navegador.</p></details>${all.length < data.total ? '<div class="notice warning">A lista atingiu o limite de exibição. Os alertas abrangem apenas os produtos exibíveis.</div>' : ''}${coverageMarkup(data)}`;
}
function selectedInventoryItems(data) {
  return inventoryPlanning.selectInventoryItems(data.items || [], { query: state.query, stock: state.stock, storeId: state.storeId, durationSort: state.inventoryDurationSort }, inventoryPreferences);
}
async function downloadInventoryReport(event) {
  const button = event.currentTarget, data = state.inventoryData, version = state.version;
  if (button.disabled || !data || state.view !== 'inventory') return;
  const items = selectedInventoryItems(data);
  if (!items.length || data.items.length < data.total) return;
  const options = { preferences: { ...inventoryPreferences }, stores: state.bootstrap.stores, storeId: state.storeId, collectionState: data.state };
  const label = button.innerHTML; button.disabled = true; button.textContent = 'Preparando relatório…';
  try {
    const { createInventoryReport } = await loadScreenModule('/inventory-report.js');
    if (state.version !== version || state.view !== 'inventory') return;
    const report = createInventoryReport(items, options);
    const url = URL.createObjectURL(new Blob([report.csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = report.filename; link.hidden = true;
    document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 10000);
    showMessage(`Relatório gerado com ${counted(report.count, 'produto', 'produtos')} dos filtros selecionados. Confira os downloads do navegador.`, 'success');
  } catch { if (state.version === version) showMessage('Não foi possível gerar o relatório. Tente novamente.', 'warning'); }
  finally { if (button.isConnected) { button.disabled = false; button.innerHTML = label; } }
}
function tree(nodes) { if (!nodes?.length) return ''; return `<ul class="financial-tree">${nodes.map(node => `<li><div class="tree-row"><span>${escape(componentLabels[node.kind] || node.kind || 'Componente')}</span>${amount(node.amountCents, node.currency)}</div>${tree(node.children)}</li>`).join('')}</ul>`; }
function transactionNotice(transaction) {
  const messages = [];
  if (transaction.supersededByRelease) messages.push('Este evento diferido foi substituído por sua liberação e não é somado novamente ao líquido.');
  if (transaction.allocation === 'multiple-orders-unallocated') messages.push('Lançamento ligado a vários pedidos. O valor não foi rateado nem incluído integralmente no líquido deste pedido.');
  if (transaction.type === 'Transfer') messages.push('Movimento de repasse apresentado separadamente do líquido operacional.');
  return messages.map(message => `<p class="inline-warning">${escape(message)}</p>`).join('');
}
function returnedOrderMetadata(order) {
  return `<section class="detail-section returned-order-metadata" aria-label="Resumo do pedido"><dl><div><dt>Modalidade</dt><dd>${modeBadge(order.fulfillmentMode)}</dd></div><div><dt>Status do pedido</dt><dd>${orderDisplayStatusMarkup(order)}</dd></div><div><dt>Data do pedido</dt><dd>${escape(date(order.createdAt, true))}</dd></div><div><dt>Loja</dt><dd>${escape(storeName(order.storeId))}</dd></div></dl></section>`;
}
function orderTrackingMarkup(order) {
  return `${order.packages?.length ? order.packages.map(pkg => `<div class="tracking-card"><div>${badge(statusLabels[pkg.detailedStatus] || pkg.detailedStatus || statusLabels[pkg.status] || pkg.status || 'Status não informado', pkg.status === 'DELIVERED' ? 'good' : 'blue')} <span>${escape(pkg.carrier || 'Transportadora não informada')}</span></div><div class="tracking-number">Código: ${escape(pkg.trackingNumber || 'Não informado')}</div>${pkg.detailedStatus && pkg.detailedStatus !== pkg.status ? `<small class="detail-info">${escape(statusLabels[pkg.status] || pkg.status || '')}</small>` : ''}</div>`).join('') : '<p class="detail-info">Rastreio ainda não informado pela Amazon.</p>'}<p class="footnote">Última consulta: ${escape(date(order.trackingObservedAt || order.observedAt, true))}.</p>`;
}
function detailMarkup(order, { includeMetadata = true, includeTracking = true } = {}) {
  const excluded = financialExcluded(order), financial = getOrderFinancial(order), transactions = excluded ? [] : order.transactions || [];
  const hasOrderTotal = order.grandTotalCents !== null && order.grandTotalCents !== undefined;
  return `${includeMetadata ? `<div class="detail-meta">${modeBadge(order.fulfillmentMode)}<span class="detail-order-status"><span>Status do pedido:</span> ${orderDisplayStatusMarkup(order)}</span><span>${escape(date(order.createdAt, true))}</span><span>· ${escape(storeName(order.storeId))}</span></div>` : ''}${excluded ? '' : `<div class="detail-summary">${metric('Valor da venda', hasOrderTotal ? escape(money(order.grandTotalCents, order.currency)) : 'Valor não informado', 'Informado pela Amazon', 'orders', false, !hasOrderTotal)}${metric('Líquido dos lançamentos', currencyValues(financial, 'netCents'), `${counted(transactions.length, 'lançamento', 'lançamentos')} · todas as datas`, 'money', true)}</div>`}
  ${orderCostDetail(order)}<section class="detail-section order-products"><h3>Produtos do pedido</h3>${(order.items || []).map((item, index) => `<div class="detail-product"><div><p>${escape(item.title || 'Produto sem descrição')}</p><small>SKU ${escape(item.sku || 'não informado')} · ASIN ${escape(item.asin || 'não informado')}</small><small>Quantidade: ${number(item.quantityOrdered)}</small><small data-item-cost-index="${index}">${order.cost?.items?.[index]?.unitCostCents != null ? `Custo unitário: ${money(order.cost.items[index].unitCostCents, 'BRL')} · ${escape(costBasis(order.cost.items[index]))}` : 'Custo pendente'}</small>${order.cost?.items?.[index]?.linkAvailable ? `<button type="button" class="button compact cost-link-trigger" data-cost-link="${index}">${icon('inventory')} ${order.cost?.items?.[index]?.fixed ? 'Conferir vínculo' : 'Vincular produto'}</button>` : ''}</div>${excluded ? '' : `<div>${amount(item.proceedsCents, item.proceedsCurrency)}<small>Total informado do item</small></div>`}</div>`).join('')}${!excluded && order.breakdowns?.length ? `<details><summary class="detail-info">Composição do valor do pedido</summary>${tree(order.breakdowns)}</details>` : ''}</section>
  <section class="detail-section order-transactions"><h3>Lançamentos financeiros</h3>${excluded ? `<p class="detail-info">${pendingPaymentMarkup()}</p>` : transactions.length ? transactions.map(tx => financialExcluded(tx) ? `<div class="transaction">${pendingPaymentMarkup()}</div>` : `<details class="transaction"><summary><span class="transaction-heading"><strong>${escape(txLabels[tx.type] || tx.type || 'Lançamento')}</strong><small>${escape(date(tx.postedAt, true))} · ${escape(statusLabels[tx.status] || tx.status || 'Status não informado')}</small></span>${amount(tx.totalCents, tx.currency)}</summary><div class="transaction-body">${transactionNotice(tx)}${tree(tx.breakdowns)}${tx.items?.length ? `<details><summary class="detail-info">Detalhamento por item</summary>${tx.items.map(item => `<div class="detail-product"><span>${escape(item.sku || item.asin || 'Item sem identificador')}</span>${amount(item.totalCents, item.currency)}</div>${tree(item.breakdowns)}`).join('')}</details>` : ''}<p class="transaction-id">Identificador: ${escape(tx.transactionId)}</p></div></details>`).join('') : '<p class="detail-info">Nenhum lançamento importado para este pedido.</p>'}</section>
  ${includeTracking ? `<section class="detail-section order-tracking"><h3>Rastreamento</h3>${orderTrackingMarkup(order)}</section>` : ''}`;
}

function orderReviewNotes(order) {
  const review = order.review;
  if (!review?.version && !review?.notes && (!review?.status || review.status === 'pending') && !order.reviewHistory?.length) return '';
  return `<details class="order-review-notes"><summary>Anotações da análise ${reviewBadge(review, 'orders')}</summary>${review?.notes ? `<p class="detail-info">${escape(review.notes).replace(/\n/g, '<br>')}</p>` : ''}${order.reviewHistory?.length ? financialReviewHistory(order, 'orders') : ''}</details>`;
}

let financialCaseSelection = null, financialCaseRequest = 0;
function leaveFinancialCase(action, trigger) {
  const dialog = $('#financial-case-dialog'), selected = financialCaseSelection;
  if (!dialog.open) { action(); return; }
  if (selected?.saving) { showCaseReviewMessage('Aguarde o acompanhamento terminar de salvar antes de abrir outro registro.', 'warning'); return; }
  const snapshot = selected?.formSnapshot;
  const dirty = snapshot && ($('#case-review-status')?.value !== snapshot.status || $('#case-review-notes')?.value !== snapshot.notes);
  if (!dirty) { dialog.close(); action(); return; }
  $('#case-navigation-confirmation')?.remove();
  const notice = document.createElement('div');
  notice.id = 'case-navigation-confirmation'; notice.className = 'notice warning case-navigation-confirmation'; notice.setAttribute('role', 'alert');
  notice.innerHTML = '<div><p>Você alterou o status ou as anotações e ainda não salvou. Sair agora descarta essa edição.</p><div class="row-actions"><button type="button" class="button compact" data-keep-case-editing>Continuar editando</button><button type="button" class="button compact" data-leave-case-unsaved>Sair sem salvar</button></div></div>';
  (trigger.closest('.detail-section') || $('#financial-case-detail')).append(notice);
  $('[data-keep-case-editing]', notice).addEventListener('click', () => { notice.remove(); if (trigger.isConnected) trigger.focus({ preventScroll: true }); });
  $('[data-leave-case-unsaved]', notice).addEventListener('click', () => {
    if (financialCaseSelection !== selected || selected.saving) return;
    dialog.close(); action();
  });
  $('[data-keep-case-editing]', notice).focus({ preventScroll: true });
}
function openRelatedReturns(view, storeId, orderId) {
  if (!['customer-returns', 'returns'].includes(view) || !orderId || !state.bootstrap.stores?.some(store => store.storeId === storeId)) return;
  clearTimeout(searchTimer); closeFilterMenus(); pendingFilterFocus = 'search';
  state.storeId = storeId; $('#store').value = storeId;
  updateStoreIdentity();
  setPeriodPreset('all', false);
  setView(view, { preservePeriod: true, query: orderId });
}
function bindFinancialCaseOrders(root) {
  if (root.id === 'financial-case-detail') root.querySelectorAll('[data-copy-order]').forEach(button => button.addEventListener('click', () => copyOrderNumber(button)));
  root.querySelectorAll('[data-case-order]').forEach(button => button.addEventListener('click', () => leaveFinancialCase(() => openOrder(button.dataset.store, button.dataset.caseOrder), button)));
  root.querySelectorAll('[data-related-returns]').forEach(button => button.addEventListener('click', () => leaveFinancialCase(() => openRelatedReturns(button.dataset.relatedReturns, button.dataset.store, button.dataset.relatedOrder), button)));
  root.querySelectorAll('[data-manage-refund-order]').forEach(button => button.addEventListener('click', () => leaveFinancialCase(() => {
    if (!state.bootstrap?.stores?.some(store => store.storeId === button.dataset.store)) return;
    state.storeId = button.dataset.store; $('#store').value = state.storeId;
    updateStoreIdentity();
    setView('refund-management', { preservePeriod: true, query: button.dataset.manageRefundOrder });
  }, button)));
}
function showCaseReviewMessage(message, kind = '', canReload = false) {
  const target = $('#case-review-message');
  if (!target) return;
  target.innerHTML = `<div class="notice ${escape(kind)}"><span>${escape(message)}${canReload ? '<br><button class="button compact" type="button" id="reload-case-review">Recarregar revisão</button>' : ''}</span></div>`;
  $('#reload-case-review')?.addEventListener('click', () => {
    const selected = financialCaseSelection;
    if (selected) openFinancialCase(selected.kind, selected.storeId, selected.caseId);
  });
}
async function openFinancialCase(kind, storeId, caseId, { message = '' } = {}) {
  if (!['refunds', 'charges'].includes(kind)) return;
  const request = ++financialCaseRequest, dialog = $('#financial-case-dialog');
  financialCaseSelection = { kind, storeId, caseId, request, detail: null, saving: false, conflict: false };
  if ($('#order-dialog').open) $('#order-dialog').close();
  $('#financial-case-kind').textContent = kind === 'refunds' ? 'REEMBOLSOS' : 'COBRANÇAS';
  $('#financial-case-title').textContent = kind === 'refunds' ? 'Detalhes do reembolso' : 'Acompanhar cobrança';
  $('#financial-case-detail').innerHTML = '<div class="loading-state"><span class="spinner"></span>Carregando caso…</div>';
  if (!dialog.open) dialog.showModal();
  try {
    const [row] = await Promise.all([api(`/api/${kind}/${encodeURIComponent(caseId)}?${new URLSearchParams({ storeId })}`), refreshReviewSettings()]);
    if (!dialog.open || request !== financialCaseRequest) return;
    if (row.caseId !== caseId || row.storeId !== storeId || (row.kind && row.kind !== kind)) throw new Error('INVALID_CASE_RESPONSE');
    financialCaseSelection.detail = row;
    $('#financial-case-detail').innerHTML = financialCaseDetailMarkup(row, kind);
    layout.organizeDetails($('#financial-case-detail'));
    applyReviewColors($('#financial-case-detail'));
    financialCaseSelection.formSnapshot = kind === 'charges' ? { status: $('#case-review-status').value, notes: $('#case-review-notes').value } : null;
    bindFinancialCaseOrders($('#financial-case-detail'));
    $('#case-review-form')?.addEventListener('submit', saveFinancialReview);
    if (message) showCaseReviewMessage(message);
  } catch {
    if (!dialog.open || request !== financialCaseRequest) return;
    $('#financial-case-detail').innerHTML = '<div class="notice error">Não foi possível carregar o caso. Confira sua sessão local e tente novamente.</div><button id="retry-financial-case" class="button" type="button">Tentar novamente</button>';
    $('#retry-financial-case').addEventListener('click', () => openFinancialCase(kind, storeId, caseId));
  }
}
async function saveFinancialReview(event) {
  event.preventDefault();
  const refreshSaved = savedViewRefresh();
  const selected = financialCaseSelection;
  if (!selected?.detail || selected.kind !== 'charges' || selected.saving || selected.conflict) return;
  const form = event.currentTarget, status = $('#case-review-status').value, notes = $('#case-review-notes').value;
  const expectedVersion = selected.detail.review?.version;
  if (!reviewChoiceValid(selected.kind, status, selected.detail.review) || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0 || notes.length > 2000) {
    showCaseReviewMessage('Confira o status e limite as anotações a 2.000 caracteres antes de salvar.', 'warning');
    return;
  }
  selected.saving = true;
  for (const control of form.elements) control.disabled = true;
  $('#case-review-save').textContent = 'Salvando…';
  try {
    await api('/api/reviews', { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': state.csrf }, body: JSON.stringify({ kind: selected.kind, storeId: selected.storeId, caseId: selected.caseId, status, notes, expectedVersion }) });
  } catch (error) {
    if (selected.request === financialCaseRequest && $('#financial-case-dialog').open) {
      selected.conflict = error.code === 'REVIEW_CONFLICT';
      showCaseReviewMessage(selected.conflict ? 'Este acompanhamento foi alterado em outra sessão. Sua edição foi mantida nesta tela. Copie as notas que quiser preservar e recarregue a revisão antes de salvar novamente.' : 'Não foi possível salvar o acompanhamento. Suas anotações continuam nesta tela; tente novamente.', selected.conflict ? 'warning' : 'error', selected.conflict);
      for (const control of form.elements) control.disabled = false;
      $('#case-review-save').disabled = selected.conflict;
      $('#case-review-save').textContent = 'Salvar acompanhamento';
    }
    selected.saving = false;
    return;
  }
  selected.saving = false;
  const refreshed = await refreshSaved().then(() => true, () => { showMessage('Salvo. Não foi possível atualizar a lista.', 'warning'); return false; });
  if (selected.request === financialCaseRequest && $('#financial-case-dialog').open) await openFinancialCase(selected.kind, selected.storeId, selected.caseId, { message: 'Acompanhamento salvo.' });
  else if (refreshed) showMessage('Acompanhamento salvo.');
}
async function bindProductCostLinks(container, order, isCurrent) {
  container.querySelectorAll('[data-cost-link]').forEach(button => button.addEventListener('click', async () => {
    const index = Number(button.dataset.costLink), item = order.items[index], refresh = savedViewRefresh();
    button.disabled = true;
    try {
      const module = await loadScreenModule('/product-cost-links.js');
      if (!isCurrent()) return;
      await module.openProductCostLink({storeId:order.storeId, orderId:order.orderId, sku:item.sku}, { api, csrf:state.csrf,
        onSaved: async result => {
          showMessage(result.syncPending ? 'Vínculo salvo. Os custos pendentes serão preenchidos na próxima atualização.' : 'Vínculo salvo. Custos já registrados foram preservados.');
          try {
            const fresh = await api(`/api/orders/${encodeURIComponent(order.orderId)}?${new URLSearchParams({storeId:order.storeId})}`);
            if (isCurrent()) {
              container.querySelector('.order-costs').outerHTML = orderCostDetail(fresh);
              container.querySelectorAll('[data-cost-link]').forEach(trigger => { trigger.innerHTML = `${icon('inventory')} ${fresh.cost?.items?.[Number(trigger.dataset.costLink)]?.fixed ? 'Conferir vínculo' : 'Vincular produto'}`; });
              container.querySelectorAll('[data-item-cost-index]').forEach(element => {
                const cost = fresh.cost?.items?.[Number(element.dataset.itemCostIndex)];
                element.textContent = cost?.unitCostCents != null ? `Custo unitário: ${money(cost.unitCostCents, 'BRL')} · ${costBasis(cost)}` : 'Custo pendente';
              });
            }
            await refresh();
          } catch { showMessage('Vínculo salvo. Atualize o painel para conferir os custos.'); }
        }
      });
    } catch (error) { showMessage(error.message, 'error'); }
    finally { button.disabled = false; }
  }));
}

let orderDetailRequest = 0;
function openReturnedToSeller(storeId, orderId) {
  return openOrder(storeId, orderId, { showReturn: true });
}
async function openOrder(storeId, orderId, { showReturn = false, mountCaseEditor = null } = {}) {
  showReturn ||= state.view === 'returns';
  const cachedReturn = showReturn && state.view === 'returns' ? state.data?.items?.find(row => row.storeId === storeId && row.orderId === orderId) : null;
  const cachedPolicy = cachedReturn ? state.data.policy : null;
  const request = ++orderDetailRequest, dialog = $('#order-dialog');
  const current = () => dialog.open && request === orderDetailRequest;
  $('#detail-title').textContent = orderId;
  $('.eyebrow', dialog).textContent = showReturn ? 'DEVOLVIDO AO VENDEDOR' : 'DETALHES DO PEDIDO';
  dialog.classList.toggle('compact-order-dialog', !showReturn);
  dialog.classList.toggle('returned-order-dialog', showReturn);
  $('#order-detail').innerHTML = `<div class="loading-state"><span class="spinner"></span>${showReturn ? 'Carregando devolução…' : 'Carregando pedido…'}</div>`;
  if (!dialog.open) dialog.showModal();
  try {
    const [order, returns] = await Promise.all([
      api(`/api/orders/${encodeURIComponent(orderId)}?${new URLSearchParams({ storeId })}`),
      showReturn && !cachedReturn ? api(`/api/returns?${new URLSearchParams({ storeId, query: orderId, limit: '500' })}`) : Promise.resolve(null),
    ]);
    if (!current()) return;
    if (order.orderId !== orderId || order.storeId !== storeId) throw new Error('Não foi possível conferir os dados do pedido. Atualize a lista e tente novamente.');
    const returnedOrder = cachedReturn || returns?.items?.find(row => row.storeId === storeId && row.orderId === orderId);
    const returnDetails = returnedOrder
      ? localReviewSummary(returnedOrder, 'returns', orderId, { compact: true }) + returnDetailMarkup(returnedOrder, cachedPolicy || returns?.policy, order)
      : '<div class="notice">O registro de devolvido ao vendedor não está disponível na base atual. Atualize a lista para conferir.</div>';
    $('#order-detail').innerHTML = (showReturn ? returnedOrderMetadata(order) + returnDetails : '') + detailMarkup(order, { includeMetadata: !showReturn, includeTracking: !showReturn || !returnedOrder });
    if (showReturn) layout.organizeDetails($('#order-detail'));
    else layout.organizeOrderOverview($('#order-detail'));
    bindLocalReviewButtons($('#order-detail'));
    bindProductCostLinks($('#order-detail'), order, current);
    if (mountCaseEditor) await mountCaseEditor($('#order-detail'), { isCurrent: current, close: () => { if (current()) dialog.close(); } });
  } catch (error) { if (current()) $('#order-detail').innerHTML = `<div class="notice error">${escape(error.message)}</div>`; }
}
function setView(view, { preservePeriod = false, query = '' } = {}) {
  view = canonicalView(view);
  if (!titles[view]) return;
  const fromMobileMenu = $('#primary-navigation').contains(document.activeElement) && mobileNavigationQuery.matches;
  setMobileMenuOpen(false);
  if (fromMobileMenu) $('#main').focus({ preventScroll: true });
  clearTimeout(searchTimer);
  refundManagementCleanup?.(); refundManagementCleanup = null;
  if (view === 'refund-management' && refundManagementModule) { refundManagementState = refundManagementModule.createRefundManagementState(); refundManagementState.query = query; if (query) refundManagementState.workflow = 'all'; }
  state.view = view; state.returnWorkflow = query ? 'all' : 'active'; state.query = query; state.safeTStatus = 'all'; state.safeTStatusLabels = {}; state.page = 0; state.mode = 'all'; state.orderNet = 'all'; state.orderStatus = 'all'; state.orderStatusLabel = ''; state.orderStatusLabels = {}; state.stock = 'all'; state.returnStatus = 'all'; state.customerRefund = 'all'; state.caseStatus = 'all'; state.caseStatusLabel = ''; state.reviewStatus = 'all'; state.reviewStatusLabel = ''; state.caseType = 'all'; state.caseTypeLabel = ''; state.caseReimbursement = 'all'; state.refundBulkMode = false;
  state.returnCard = 'all';
  if (!preservePeriod && !['refunds', 'refund-management', 'charges', 'customer-returns'].includes(view)) setPeriodPreset('today', false);
  history.replaceState(null, '', `#${view}`);
  document.body.dataset.view = view;
  $('#page-context').textContent = ({ dashboard: 'PAINEL DA OPERAÇÃO', orders: 'CONSULTA DE PEDIDOS', 'product-sales': 'DESEMPENHO POR CANAL', charges: 'CONFERÊNCIA FINANCEIRA', 'customer-returns': 'ACOMPANHAMENTO', returns: 'LOGÍSTICA REVERSA', inventory: 'POSIÇÃO DE ESTOQUE', settings: 'SEU ESPAÇO DE TRABALHO' })[view] || 'ACOMPANHAMENTO';
  document.querySelectorAll('[data-view]').forEach(button => { button.classList.toggle('active', button.dataset.view === view); button.setAttribute('aria-current', button.dataset.view === view ? 'page' : 'false'); });
  $('#page-title').textContent = titles[view]; $('#breadcrumb-current').textContent = titles[view];
  $('#period-bar').hidden = ['sales-alerts', 'inventory', 'product-sales', 'returns', 'settings', 'refunds', 'refund-management', 'charges', 'customer-returns'].includes(view);
  $('.page-heading').hidden = view === 'refund-management';
  document.querySelectorAll('[data-history-period]').forEach(button => { button.hidden = !['orders', 'refunds', 'charges', 'customer-returns', 'safe-t'].includes(view); });
  document.title = `${titles[view]} · SynthAmazon`;
  loadView();
}
let searchTimer, copyTimer, pendingFilterFocus;
function closeFilterMenus() {
  document.querySelectorAll('.filter-menu').forEach(menu => { menu.dispatchEvent(new Event('filter-menu-close')); menu.hidden = true; });
  document.querySelectorAll('.filter-trigger').forEach(button => button.setAttribute('aria-expanded', 'false'));
}
document.addEventListener('click', event => { if (!event.target.closest('.filter-select')) closeFilterMenus(); });
function enhanceMultiFilter(select) {
  const label = select.getAttribute('aria-label') || 'Filtrar';
  const choices = [...select.options], specific = choices.filter(option => option.value !== 'all');
  const applied = () => new Set(specific.filter(option => option.selected).map(option => option.value));
  let draft = applied();
  const selected = specific.filter(option => option.selected);
  const selectedLabel = selected.length > 1 ? `${number(selected.length)} selecionados` : selected[0]?.dataset.label || 'Todos';
  const host = document.createElement('div'); host.className = 'filter-select filter-multiple';
  const trigger = document.createElement('button'); trigger.type = 'button'; trigger.className = 'filter-trigger';
  trigger.id = `${select.id}-trigger`; trigger.setAttribute('aria-haspopup', 'dialog'); trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-controls', `${select.id}-menu`); trigger.setAttribute('aria-label', `${label}: ${selectedLabel}`);
  trigger.innerHTML = `<span><small class="filter-trigger-label">${escape(label)}</small><span class="filter-selected-value">${escape(selectedLabel)}</span></span>${icon('chevron')}`;
  const menu = document.createElement('div'); menu.className = 'filter-menu filter-multiple-menu'; menu.id = `${select.id}-menu`; menu.hidden = true;
  menu.setAttribute('role', 'dialog'); menu.setAttribute('aria-label', label); menu.setAttribute('aria-describedby', `${select.id}-hint`);
  const hint = document.createElement('p'); hint.className = 'filter-multiple-hint'; hint.id = `${select.id}-hint`;
  hint.textContent = 'Escolha uma ou mais opções. Todos remove as restrições.';
  const list = document.createElement('div'); list.className = 'filter-multiple-options';
  const checkboxes = [];
  const renderDraft = () => {
    for (const entry of checkboxes) {
      entry.input.checked = entry.value === 'all' ? draft.size === 0 : draft.has(entry.value);
      entry.row.classList.toggle('selected', entry.input.checked);
    }
  };
  for (const option of choices) {
    const row = document.createElement('label'); row.className = 'filter-option filter-checkbox-option';
    const input = document.createElement('input'); input.type = 'checkbox'; input.value = option.value;
    const optionLabel = option.dataset.label || option.textContent;
    const count = option.dataset.label ? option.textContent.match(/\(([\d.,]+)\)$/)?.[1] : null;
    input.setAttribute('aria-label', `${optionLabel}${count !== null ? `, ${count} ${select.dataset.countUnit || 'casos'}` : ''}`);
    const text = document.createElement('span'); text.className = 'filter-option-label'; text.textContent = optionLabel;
    row.append(input, text);
    if (count !== null) { const pill = document.createElement('span'); pill.className = 'filter-option-count'; pill.textContent = count; row.append(pill); }
    input.addEventListener('change', () => {
      if (option.value === 'all') draft.clear();
      else if (input.checked) draft.add(option.value);
      else draft.delete(option.value);
      renderDraft();
    });
    checkboxes.push({ input, row, value: option.value }); list.append(row);
  }
  const actions = document.createElement('div'); actions.className = 'filter-multiple-actions';
  const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'button compact'; cancel.textContent = 'Cancelar';
  const apply = document.createElement('button'); apply.type = 'button'; apply.className = 'button compact primary'; apply.textContent = 'Aplicar';
  actions.append(cancel, apply); menu.append(hint, list, actions);
  menu.addEventListener('filter-menu-close', () => { draft = applied(); renderDraft(); });
  const dismiss = () => { closeFilterMenus(); trigger.focus({ preventScroll: true }); };
  cancel.addEventListener('click', dismiss);
  apply.addEventListener('click', () => {
    const before = selectedFilterCsv(select);
    for (const option of choices) option.selected = option.value === 'all' ? draft.size === 0 : draft.has(option.value);
    const changed = before !== selectedFilterCsv(select);
    dismiss();
    if (changed) { pendingFilterFocus = trigger.id; select.dispatchEvent(new Event('change', { bubbles: true })); }
  });
  const open = (last = false) => {
    closeFilterMenus(); draft = applied(); renderDraft(); menu.hidden = false; trigger.setAttribute('aria-expanded', 'true');
    const target = last ? checkboxes.at(-1)?.input : checkboxes.find(entry => entry.input.checked)?.input || checkboxes[0]?.input;
    target?.focus({ preventScroll: true }); target?.scrollIntoView({ block: 'nearest' });
  };
  trigger.addEventListener('click', () => menu.hidden ? open() : dismiss());
  trigger.addEventListener('keydown', event => {
    if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); open(event.key === 'ArrowUp'); }
    else if (event.key === 'Escape' && !menu.hidden) { event.preventDefault(); dismiss(); }
  });
  menu.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismiss(); } });
  host.addEventListener('focusout', event => { if (!menu.hidden && !host.contains(event.relatedTarget)) closeFilterMenus(); });
  const oldLabel = select.closest('label');
  if (oldLabel) oldLabel.replaceWith(host); else select.replaceWith(host);
  select.hidden = true; select.tabIndex = -1; select.setAttribute('aria-hidden', 'true');
  host.append(select, trigger, menu); renderDraft();
}
function enhanceFilters() {
  const search = $('#search');
  if (search && !search.closest('.search-field')) {
    const label = search.closest('label');
    label.classList.add('search-field');
    const fieldLabel = document.createElement('span'); fieldLabel.className = 'filter-field-label'; fieldLabel.textContent = 'Buscar';
    const wrap = document.createElement('span'); wrap.className = 'search-input-wrap';
    while (label.firstChild) wrap.append(label.firstChild);
    label.append(fieldLabel, wrap);
  }
  document.querySelectorAll('.table-filters select').forEach(select => {
    if (select.dataset.filterMultiple === 'true' && !select.hidden) enhanceMultiFilter(select);
  });
  selectMenus?.enhanceSelectMenus($('#content'));
}

let lastCopiedOrder = null, copyInteraction = 0;
function copiedOrderIdentity(element) {
  const card = element.closest('[data-order-card]');
  const orderId = element.closest('[data-copy-order]')?.dataset.copyOrder || card?.dataset.orderCard;
  const storeId = element.closest('[data-store]')?.dataset.store || card?.dataset.store || (!isMultipleStores(state.storeId) ? state.storeId : '');
  return orderId && storeId ? JSON.stringify([storeId, orderId]) : null;
}
function applyCopiedOrderHighlight(root = document) {
  root.querySelectorAll('[data-order-card]').forEach(card => {
    const active = lastCopiedOrder !== null && copiedOrderIdentity(card) === lastCopiedOrder;
    card.classList.toggle('order-last-copied', active);
    const label = card.querySelector('.copy-highlight-label');
    if (!active) label?.remove();
    else if (!label) {
      const host = card.querySelector('.rm-order-identity') || card.querySelector('.order-id-control')?.parentElement;
      if (host) { const marker = document.createElement('span'); marker.className = 'copy-highlight-label'; marker.textContent = 'Último copiado'; host.append(marker); }
    }
  });
}
function clearCopiedOrderOnOtherOrder(event) {
  if (event.type === 'keydown' && !['Enter', ' '].includes(event.key)) return;
  if (event.target.closest('[data-copy-order]')) return;
  const identity = copiedOrderIdentity(event.target);
  if (!identity) return;
  copyInteraction++;
  if (lastCopiedOrder && identity !== lastCopiedOrder) { lastCopiedOrder = null; applyCopiedOrderHighlight(); }
}
document.addEventListener('click', clearCopiedOrderOnOtherOrder, true);
document.addEventListener('keydown', clearCopiedOrderOnOtherOrder, true);
async function writeOrderClipboard(orderId, button) {
  if (typeof orderId !== 'string' || !orderId) throw new Error('MISSING_ORDER_NUMBER');
  try { await navigator.clipboard.writeText(orderId); }
  catch {
    const input = document.createElement('textarea'); input.value = orderId; input.className = 'sr-only'; input.setAttribute('readonly', '');
    const previousFocus = document.activeElement;
    const container = button.closest('dialog[open]') || document.body;
    let copied;
    try {
      container.append(input); input.focus({ preventScroll: true }); input.select(); input.setSelectionRange(0, input.value.length);
      if (document.activeElement !== input || input.selectionStart !== 0 || input.selectionEnd !== input.value.length) throw new Error('COPY_SELECTION_FAILED');
      copied = document.execCommand('copy');
    } finally {
      input.remove();
      const focusTarget = previousFocus?.isConnected ? previousFocus : button;
      focusTarget.focus({ preventScroll: true });
    }
    if (!copied) throw new Error('COPY_FAILED');
  }
}
function updateSalesAlertCount(count) {
  const badge=$('#sales-alert-count');badge.textContent=count>99?'99+':String(count);badge.hidden=!count;badge.setAttribute('aria-label',`${count} alertas novos`);
}
async function refreshSalesAlertCount() {
  const storeId=state.storeId;if(!storeId||!state.bootstrap)return;
  try{const data=await api(`/api/sales-alerts?${new URLSearchParams({storeId,limit:'1'})}`);if(storeId===state.storeId)updateSalesAlertCount(data.counts.new);}catch{}
}
setInterval(()=>{if(!document.hidden)refreshSalesAlertCount();},180000);
document.addEventListener('click',async event=>{
  const button=event.target.closest('[data-copy-asin]');if(!button)return;
  const asin=button.dataset.copyAsin;if(!/^[A-Z0-9]{10}$/.test(asin))return;
  try{
    await writeOrderClipboard(asin,button);
    button.classList.add('copied');button.setAttribute('aria-label',`ASIN ${asin} copiado`);button.innerHTML=`${icon('check')}<span class="copy-label">Copiado!</span>`;
    const feedback=$('#copy-feedback');feedback.textContent=`ASIN ${asin} copiado`;feedback.hidden=false;$('#copy-announcement').textContent=feedback.textContent;
    clearTimeout(copyTimer);copyTimer=setTimeout(()=>{feedback.hidden=true;},3000);
    setTimeout(()=>{if(button.isConnected){button.classList.remove('copied');button.setAttribute('aria-label',`Copiar ASIN ${asin}`);button.innerHTML=`${icon('copy')}<span class="copy-label">Copiar ASIN</span>`;}},2500);
  }catch{showMessage('Não foi possível copiar o ASIN. Selecione o código para copiá-lo.','warning');}
});
async function copyOrderNumber(button) {
  const orderId = button.dataset.copyOrder, identity = copiedOrderIdentity(button), interaction = ++copyInteraction;
  try {
    await writeOrderClipboard(orderId, button);
    if (interaction === copyInteraction) { lastCopiedOrder = identity; applyCopiedOrderHighlight(); }
    button.classList.add('copied'); button.innerHTML = `${icon('check')}<span class="copy-label">Copiado!</span>`;
    button.setAttribute('aria-label', `Número do pedido ${orderId} copiado`);
    const feedback = $('#copy-feedback'); feedback.textContent = `Pedido ${orderId} copiado`; feedback.hidden = false;
    $('#copy-announcement').textContent = feedback.textContent;
    clearTimeout(copyTimer); copyTimer = setTimeout(() => { feedback.hidden = true; }, 3000);
    setTimeout(() => { $('#copy-announcement').textContent = ''; if (button.isConnected) { button.classList.remove('copied'); button.setAttribute('aria-label', `Copiar número do pedido ${orderId}`); button.innerHTML = `${icon('copy')}<span class="copy-label">Copiar número</span>`; } }, 2500);
  } catch { showMessage('Não foi possível copiar. Selecione o número do pedido para copiá-lo.', 'warning'); }
}
function clearViewFilters() {
  if (!['orders', 'refunds', 'charges', 'inventory', 'returns', 'customer-returns', 'safe-t'].includes(state.view)) return;
  clearTimeout(searchTimer); searchTimer = undefined;
  closeFilterMenus();
  if (state.view === 'inventory' && inventoryPreferences) inventoryPreferences.alert = 'all';
  Object.assign(state, { safeTStatus: 'all', safeTStatusLabels: {}, query: '', mode: 'all', orderNet: 'all', orderStatus: 'all', orderStatusLabel: '', orderStatusLabels: {}, stock: 'all', returnStatus: 'all', customerRefund: 'all', caseStatus: 'all', caseStatusLabel: '', reviewStatus: 'all', reviewStatusLabel: '', caseType: 'all', caseTypeLabel: '', caseReimbursement: 'all', page: 0 });
  state.returnCard = 'all';
  if (!['refunds', 'charges', 'customer-returns'].includes(state.view)) setPeriodPreset('all', false);
  pendingFilterFocus = 'clear-filters';
  loadView();
}
function bindClearFilters() {
  if (!['orders', 'refunds', 'charges', 'inventory', 'returns', 'customer-returns', 'safe-t'].includes(state.view)) return;
  const filters = $('#content .table-toolbar .table-filters');
  if (!filters) return;
  const button = document.createElement('button'); button.type = 'button'; button.id = 'clear-filters'; button.className = 'button compact clear-filters';
  button.textContent = 'Limpar filtros';
  button.title = 'Limpar busca e filtros e mostrar todo o histórico importado, mantendo a loja selecionada';
  button.addEventListener('click', clearViewFilters);
  filters.insertBefore(button, filters.querySelector('.result-count'));
}
function renderProductSales() { productSalesCleanup?.(); productSalesCleanup=null; $('#content').innerHTML = productSalesModule.renderProductSales(productSalesData, productSalesState, {storeName,inventoryAsinLink}); bindContent(); }
async function updateProductSales({channels=productSalesState.channels,from=productSalesState.customFrom,to=productSalesState.customTo,period,focus}) {
  const version = ++state.version;
  productSalesState.loading = true;
  showMessage('');
  renderProductSales();
  try {
    const data = await api(`/api/product-sales?${params({from:from||null,to:to||null,channels:channels.join(',')})}`);
    if (version !== state.version || state.view !== 'product-sales') return;
    productSalesData = data;
    productSalesState.channels = data.channels;
    productSalesState.customFrom=from; productSalesState.customTo=to;
    if(period) { productSalesState.period=period; productSalesState.dateOpen=false; }
    productSalesState.visible = 20;
  } catch (error) {
    if (version === state.version) showMessage(error.message, 'error');
  } finally {
    if (version === state.version && state.view === 'product-sales') {
      productSalesState.loading = false;
      renderProductSales();
      $(focus)?.focus({preventScroll:true});
    }
  }
}
const changeProductSalesChannels = (channels,code) => updateProductSales({channels,focus:`[data-sales-channel="${code}"]`});
const changeProductSalesDates = (from,to) => updateProductSales({from,to,period:'custom',focus:'[data-sales-date-trigger]'});
function bindContent() {
  if(state.view==='sales-alerts'&&salesAlertsModule) {
    salesAlertsCleanup?.();
    salesAlertsCleanup=salesAlertsModule.bindSalesAlerts($('#content'),state.data,salesAlertsState,{refresh:()=>loadView(false,{preserveContent:true}),api,csrf:state.csrf,isCurrent:(()=>{const storeId=state.storeId,version=state.version;return()=>state.view==='sales-alerts'&&state.storeId===storeId&&state.version===version;})(),message:showMessage,updateCount:updateSalesAlertCount});
    return;
  }
  if (state.view === 'product-sales' && productSalesModule) { productSalesCleanup?.(); productSalesCleanup=productSalesModule.bindProductSales($('#content'),productSalesData,productSalesState,renderProductSales,changeProductSalesChannels,changeProductSalesDates); return; }
  prepareTables($('#content'));
  if (state.view === 'dashboard') layout.tabbedSections($('#content'), node => node.matches('.current-balances') || node.getAttribute('aria-label') === 'Resultado do período' ? 'Resumo' : 'Detalhamento financeiro', { remember: true, label: 'Seções da visão geral' });
  if (state.view === 'settings') {
    layout.tabbedSections($('#content'), node => node.id === 'product-links-settings' ? 'Vinculação de produtos' : node.id === 'status-editor' ? 'Cadastrar / editar status' : 'Status cadastrados', { remember:true, label: 'Seções das configurações' });
    productLinksSettingsCleanup?.();
    const workspace = $('[data-sku-workspace]');
    if (workspace && productLinksSettingsModule) {
      const storeId = state.storeId, version = state.version;
      productLinksSettingsCleanup = productLinksSettingsModule.mountProductLinksSettings(workspace, productLinksListState, {api,csrf:state.csrf,storeId,isCurrent:()=>state.view==='settings'&&state.storeId===storeId&&state.version===version});
    }
    const list = $('#content table')?.closest('.panel');
    if (list) layout.paginateNodes(list, 'tbody tr', 6);
  }
  $('#content').querySelector('[data-open-fba-stock]')?.addEventListener('click', openFbaStock);
  $('#content').querySelectorAll('[data-composition-bucket]').forEach(button => button.addEventListener('click', () => openComposition(button)));
  if (state.view === 'refund-management') {
    refundManagementCleanup = refundManagementModule.bindRefundManagement($('#content'), {
      state: refundManagementState, data: state.data, storeId: state.storeId, api, csrf: state.csrf,
      reload: loadView, afterSave: savedViewRefresh(), refreshSource: () => $('#reload').click(), helpers: refundManagementHelpers,
    });
    return;
  }
  applyReviewColors($('#content'));
  if (state.view === 'returns') returnedManagementModule.bindReturnedManagement($('#content'), { data: state.data, state, reload: loadView, afterSave: savedViewRefresh(), api, csrf: state.csrf, helpers: { applyReviewColors, showMessage } });
  enhanceFilters();
  bindClearFilters();
  bindRefundSelection();
  bindSafeTButtons($('#content'));
  if (state.view === 'settings') bindSettings();
  bindLocalReviewButtons($('#content'));
  $('#content').querySelectorAll('[data-customer-return]').forEach(button => button.addEventListener('click', () => openCustomerReturn(button.dataset.store, button.dataset.customerReturn)));
  $('#content').querySelectorAll('[data-financial-all]').forEach(button => button.addEventListener('click', () => setPeriodPreset('all')));
  $('#content').querySelectorAll('[data-financial-case]').forEach(button => button.addEventListener('click', () => openFinancialCase(button.dataset.caseKind, button.dataset.store, button.dataset.financialCase)));
  bindFinancialCaseOrders($('#content'));
  $('#content').querySelectorAll('[data-copy-order]').forEach(button => button.addEventListener('click', () => copyOrderNumber(button)));
  document.querySelectorAll('[data-go]').forEach(button => button.addEventListener('click', () => setView(button.dataset.go, { preservePeriod: true })));
  document.querySelectorAll('[data-order]').forEach(button => button.addEventListener('click', () => openOrder(button.dataset.store, button.dataset.order)));
  $('#content').querySelectorAll('[data-order-row]').forEach(row => {
    const open = () => openOrder(row.dataset.store, row.dataset.orderRow);
    row.addEventListener('click', event => {
      if (event.target.closest('button, a, input, select, textarea, summary') || window.getSelection()?.toString()) return;
      open();
    });
    row.addEventListener('keydown', event => {
      if (event.target === row && ['Enter', ' '].includes(event.key)) { event.preventDefault(); open(); }
    });
  });
  $('#mode-filter')?.addEventListener('change', event => { state.mode = event.target.value; state.page = 0; loadView(); });
  $('#order-net-filter')?.addEventListener('change', event => { state.orderNet = event.target.value; state.page = 0; loadView(); });
  $('#order-status-filter')?.addEventListener('change', event => {
    state.orderStatus = selectedFilterCsv(event.target);
    for (const option of event.target.options) if (option.value !== 'all') state.orderStatusLabels[option.value.toLowerCase()] = option.dataset.label || option.value;
    state.orderStatusLabel = [...event.target.selectedOptions].filter(option => option.value !== 'all').map(option => option.dataset.label || option.value).join(', ');
    state.page = 0; loadView();
  });
  $('#return-status-filter')?.addEventListener('change', event => { state.returnStatus = event.target.value; state.page = 0; loadView(); });
  $('#case-status-filter')?.addEventListener('change', event => { state.caseStatus = event.target.value; state.caseStatusLabel = event.target.selectedOptions[0]?.dataset.label || ''; state.page = 0; loadView(); });
  $('#local-review-filter')?.addEventListener('change', event => { state.reviewStatus = event.target.value; state.reviewStatusLabel = event.target.selectedOptions[0]?.dataset.label || ''; state.page = 0; loadView(); });
  $('#case-type-filter')?.addEventListener('change', event => { state.caseType = event.target.value; state.caseTypeLabel = event.target.selectedOptions[0]?.dataset.label || ''; state.page = 0; loadView(); });
  $('#content').querySelectorAll('[data-reimbursement-choice]').forEach(button => button.addEventListener('click', () => {
    const code = button.dataset.reimbursementChoice, selected = new Set(filterCodes(state.caseReimbursement));
    if (code === 'all') selected.clear();
    else if (reimbursementChoices.some(([value]) => value === code)) { if (selected.has(code)) selected.delete(code); else selected.add(code); }
    else return;
    const value = reimbursementChoices.map(([choice]) => choice).filter(choice => selected.has(choice)).join(',') || 'all';
    if (value === state.caseReimbursement) return;
    clearTimeout(searchTimer); state.caseReimbursement = value; state.page = 0;
    pendingFilterFocus = button.id; loadView();
  }));
  $('#content').querySelectorAll('[data-safe-t-category]').forEach(button => button.addEventListener('click', () => {
    const code = button.dataset.safeTCategory, selected = new Set(filterCodes(state.safeTStatus));
    const choices = safeTCategoryOptions(state.data);
    for (const item of choices) state.safeTStatusLabels[item.code] = item.label || item.code;
    if (code === 'all') selected.clear();
    else if (choices.some(item => item.code === code)) { if (selected.has(code)) selected.delete(code); else selected.add(code); }
    else return;
    const value = choices.map(item => item.code).filter(item => selected.has(item)).join(',') || 'all';
    if (value === state.safeTStatus) return;
    clearTimeout(searchTimer); state.safeTStatus = value; state.page = 0;
    pendingFilterFocus = button.id; loadView();
  }));
  $('#customer-refund-filter')?.addEventListener('change', event => { state.customerRefund = event.target.value; state.page = 0; loadView(); });
  $('#stock-filter')?.addEventListener('change', event => { state.stock = event.target.value; state.page = 0; renderInventory(); });
  $('#download-inventory-report')?.addEventListener('click', downloadInventoryReport);
  if (state.view === 'inventory' && inventoryPlanning) inventoryPlanning.bindInventoryPlanning(document, inventoryPreferences, () => { state.page = 0; renderInventory(); });
  document.querySelectorAll('[data-inventory-duration-sort]').forEach(button => button.addEventListener('click', () => {
    state.inventoryDurationSort = state.inventoryDurationSort === 'asc' ? 'desc' : 'asc'; state.page = 0; renderInventory();
    document.querySelector(`[data-inventory-duration-sort="${button.dataset.inventoryDurationSort}"]`)?.focus({preventScroll:true});
  }));
  $('#prev-page')?.addEventListener('click', () => changeListPage(-1));
  $('#next-page')?.addEventListener('click', () => changeListPage(1));
  $('#search')?.addEventListener('input', event => { state.query = event.target.value; state.page = 0; syncRefundSelectionScope(); clearTimeout(searchTimer); searchTimer = setTimeout(() => state.view === 'inventory' ? renderInventory(true) : loadView(true), 300); });
  if (pendingFilterFocus) { document.getElementById(pendingFilterFocus)?.focus({ preventScroll: true }); pendingFilterFocus = null; }
}
async function changeListPage(direction) {
  if ($('#content').getAttribute('aria-busy') === 'true') return;
  const previousPage = state.page;
  state.page = Math.max(0, previousPage + direction);
  if (state.view === 'inventory') { renderInventory(); return; }
  if (state.view !== 'orders') { loadView(); return; }
  const buttons = ['prev-page', 'next-page'].map(id => ({ element: document.getElementById(id), disabled: document.getElementById(id)?.disabled }));
  buttons.forEach(({ element }) => { if (element) element.disabled = true; });
  const loading = document.createElement('span'); loading.className = 'page-loading'; loading.setAttribute('role', 'status'); loading.textContent = 'Atualizando pedidos…';
  $('#content .pagination')?.prepend(loading);
  const version = state.version + 1;
  try {
    await loadView(false, { preserveContent: true });
    if (state.version === version) document.getElementById(direction > 0 ? 'next-page' : 'prev-page')?.focus({ preventScroll: true });
  } catch (error) {
    if (state.version === version) { state.page = previousPage; showMessage(error.message, 'error'); }
  } finally {
    loading.remove();
    // Only restore the original controls if this request still owns the view.
    if (state.version === version) buttons.forEach(({ element, disabled }) => { if (element?.isConnected) element.disabled = disabled; });
  }
}
function renderInventory(restoreSearch = false) { const position = $('#search')?.selectionStart; $('#content').innerHTML = inventoryMarkup(state.inventoryData); bindContent(); if (restoreSearch) { $('#search')?.focus(); try { $('#search')?.setSelectionRange(position, position); } catch {} } }
// Keep a completed save scoped to the screen on which it began. A late reply
// must never replace another store or a newer filter/navigation request.
function savedViewRefresh() {
  const view = state.view, storeId = state.storeId, version = state.version;
  return (options = {}) => state.view === view && state.storeId === storeId && state.version === version
    ? loadView(false, { preserveContent: true, refundFinalized: options.refundFinalized === true }) : Promise.resolve();
}
async function loadView(restoreSearch = false, { preserveContent = false, refundFinalized = false } = {}) {
  productSalesCleanup?.(); productSalesCleanup=null;
  salesAlertsCleanup?.(); salesAlertsCleanup=null;
  productLinksSettingsCleanup?.(); productLinksSettingsCleanup=null;
  syncRefundSelectionScope();
  const version = ++state.version, view = state.view;
  const managementSearch = view === 'refund-management' && document.activeElement?.matches('[data-rm-search]');
  const alertSearch = view === 'sales-alerts' && document.activeElement?.matches('[data-alert-search]');
  const alertPosition = alertSearch ? document.activeElement.selectionStart : null;
  const managementPosition = managementSearch ? document.activeElement.selectionStart : null;
  if (!preserveContent) { refundManagementCleanup?.(); refundManagementCleanup = null; }
  const position = restoreSearch ? $('#search')?.selectionStart : null;
  $('#content').setAttribute('aria-busy', 'true');
  if (!restoreSearch && !preserveContent) $('#content').innerHTML = '<div class="loading-state"><span class="spinner"></span>Carregando dados…</div>';
  if (!preserveContent) showMessage('');
  try {
    let html;
    if (view === 'refund-management') {
      refundManagementModule ||= await loadScreenModule('/refund-management.js');
      if (version !== state.version) return;
      if (!refundManagementState) { refundManagementState = refundManagementModule.createRefundManagementState(); refundManagementState.query = state.query; if (state.query) refundManagementState.workflow = 'all'; }
      let data = await loadAllRecords(api, '/api/refund-management', refundManagementModule.refundManagementParams(refundManagementState, state.storeId), () => version === state.version);
      if (version !== state.version) return;
      if (refundFinalized && refundManagementState.payment === 'pending' && data.total === 0) {
        const nextParams = refundManagementModule.refundManagementParams(refundManagementState, state.storeId);
        nextParams.set('payment', 'all');
        data = await loadAllRecords(api, '/api/refund-management', nextParams, () => version === state.version);
        if (version !== state.version) return;
        refundManagementState.payment = 'all';
      }
      state.data = data; html = refundManagementModule.renderRefundManagement(data, refundManagementState, refundManagementHelpers);
    } else if (view === 'dashboard') {
      const [dashboard, inventory] = await Promise.all([api(`/api/dashboard?${params()}`), api(`/api/inventory?${params({ from: null, to: null, limit: 500 })}`)]);
      if (version !== state.version) return;
      state.data = dashboard; html = dashboardMarkup(dashboard, inventory);
    } else if (view === 'sales-alerts') {
      salesAlertsModule ||= await loadScreenModule('/sales-alerts.js');
      const data=await api(`/api/sales-alerts?${params({from:null,to:null,...salesAlertsState,loading:null})}`);
      if(version!==state.version)return;
      state.data=data;html=salesAlertsModule.renderSalesAlerts(data,salesAlertsState,{storeName,inventoryAsinLink});
      refreshSalesAlertCount();
    } else if (view === 'product-sales') {
      productSalesModule ||= await loadScreenModule('/product-sales.js');
      productSalesState ||= productSalesModule.createProductSalesState();
      const data = await api(`/api/product-sales?${params({from:productSalesState.customFrom||null,to:productSalesState.customTo||null,channels:productSalesState.channels.join(',')})}`);
      if (version !== state.version) return;
      productSalesState.channels = data.channels; productSalesState.loading = false;
      productSalesData = data; html = productSalesModule.renderProductSales(data,productSalesState,{storeName,inventoryAsinLink});
    } else if (view === 'orders') {
      const data = await api(`/api/orders?${params({ query: state.query, mode: state.mode, status: state.orderStatus, net: state.orderNet, limit: state.pageSize, offset: state.page * state.pageSize })}`);
      if (version !== state.version) return;
      state.data = data; html = ordersTable(data);
    } else if (view === 'returns') {
      returnedManagementModule ||= await loadScreenModule('/returned-management.js');
      if (version !== state.version) return;
      const data = await loadAllRecords(api, '/api/returns', params({ from: null, to: null, query: state.query, status: state.returnStatus, workflow: state.returnWorkflow || 'active', card: state.returnCard || 'all', reviewStatus: state.reviewStatus }), () => version === state.version);
      if (version !== state.version) return;
      state.data = data; html = returnsMarkup(data);
    } else if (view === 'customer-returns') {
      const data = await api(`/api/customer-returns?${params({ from: null, to: null, query: state.query, mode: state.mode, refund: state.customerRefund, reviewStatus: state.reviewStatus, limit: state.pageSize, offset: state.page * state.pageSize })}`);
      if (version !== state.version) return;
      state.data = data; html = customerReturnsMarkup(data);
    } else if (view === 'refunds' || view === 'charges') {
      const data = await api(`/api/${view}?${params({ from: null, to: null, query: state.query, status: state.caseStatus, type: view === 'charges' ? state.caseType : undefined, reimbursement: view === 'refunds' ? state.caseReimbursement : undefined, limit: state.pageSize, offset: state.page * state.pageSize })}`);
      if (version !== state.version) return;
      state.data = data; html = financialCasesMarkup(data, view);
    } else if (view === 'safe-t') {
      const data = await api(`/api/safe-t?${params({ query: state.query, mode: state.mode, status: state.safeTStatus, limit: state.pageSize, offset: state.page * state.pageSize })}`);
      if (version !== state.version) return;
      state.data = data; html = safeTMarkup(data);
    } else if (view === 'settings') {
      [productLinksSettingsModule] = await Promise.all([loadScreenModule('/product-links-settings.js'), refreshReviewSettings()]);
      if (version !== state.version) return;
      html = settingsMarkup();
    } else {
      inventoryPlanning ||= await inventoryPlanningReady;
      inventoryPreferences ||= inventoryPlanning.inventoryPlanningPreferences();
      const inventory = await loadInventoryRecords(api, params({ from: null, to: null }), {
        isCurrent: () => version === state.version,
        onStock: data => {
          state.inventoryData = data;
          renderInventory(restoreSearch);
          $('#content').setAttribute('aria-busy', 'false');
        },
      });
      if (version !== state.version) return;
      state.inventoryData = inventory;
      html = inventoryMarkup(state.inventoryData);
    }
    const inventorySearch = view === 'inventory' && document.activeElement?.id === 'search';
    const inventoryPosition = inventorySearch ? $('#search')?.selectionStart : null;
    const scroll = preserveContent || view === 'inventory' ? { top: window.scrollY, left: window.scrollX } : null;
    if (preserveContent) { refundManagementCleanup?.(); refundManagementCleanup = null; }
    $('#content').innerHTML = html; bindContent();
    updateSync(view === 'inventory' ? state.inventoryData : state.data);
    if(view!=='sales-alerts')refreshSalesAlertCount();
    if(alertSearch) { const input=$('[data-alert-search]');input?.focus({preventScroll:true});try{input?.setSelectionRange(alertPosition,alertPosition);}catch{} }
    if (scroll) window.scrollTo({ ...scroll, behavior: 'instant' });
    if (inventorySearch) { $('#search')?.focus({ preventScroll: true }); try { $('#search')?.setSelectionRange(inventoryPosition, inventoryPosition); } catch {} }
    if (managementSearch) { const input = $('[data-rm-search]'); input?.focus(); try { input?.setSelectionRange(managementPosition, managementPosition); } catch {} }
    if (restoreSearch) { $('#search')?.focus(); try { $('#search')?.setSelectionRange(position, position); } catch {} }
  } catch (error) { if (version === state.version) { if (preserveContent) throw error; showMessage(error.message, 'error'); $('#content').innerHTML = empty('Os dados não puderam ser carregados', 'Use “Atualizar painel” para tentar novamente.'); } }
  finally { if (version === state.version) $('#content').setAttribute('aria-busy', 'false'); }
}
function updatePeriodButtons(preset) {
  document.querySelectorAll('[data-period]').forEach(button => {
    const selected = button.dataset.period === preset;
    button.classList.toggle('active', selected); button.setAttribute('aria-pressed', String(selected));
  });
}
function setPeriodPreset(preset, refresh = true) {
  if (preset === 'all') {
    if (!['orders', 'refunds', 'charges', 'inventory', 'returns', 'customer-returns', 'safe-t'].includes(state.view)) return;
    state.from = ''; state.to = ''; state.page = 0;
    $('#date-from').value = ''; $('#date-to').value = '';
    updatePeriodButtons('all');
    if (refresh) loadView();
    return;
  }
  const to = localDay(new Date().toISOString());
  const from = preset === 'today' ? to : preset === 'month' ? `${to.slice(0, 7)}-01` : preset === 'year' ? `${to.slice(0, 4)}-01-01` : addDays(to, -Number(preset) + 1);
  state.from = from; state.to = to; state.page = 0;
  $('#date-from').value = from; $('#date-to').value = to;
  updatePeriodButtons(preset);
  if (refresh) loadView();
}
function applyPeriod() {
  const from = $('#date-from').value, to = $('#date-to').value;
  if (!from || !to || from > to) { showMessage('Informe um período válido, com a data inicial anterior ou igual à data final.', 'warning'); return; }
  state.from = from; state.to = to; state.page = 0;
  const today = localDay(new Date().toISOString());
  updatePeriodButtons(to === today && from === today ? 'today' : to === today && from === `${today.slice(0, 7)}-01` ? 'month' : null);
  loadView();
}
const mobileNavigationQuery = window.matchMedia('(max-width: 720px)');
function setMobileMenuOpen(open, restoreFocus = false) {
  open = Boolean(open && mobileNavigationQuery.matches);
  $('.app-header').classList.toggle('mobile-menu-open', open);
  const toggle = $('#mobile-menu-toggle');
  toggle.setAttribute('aria-expanded', String(open));
  toggle.setAttribute('aria-label', open ? 'Fechar menu' : 'Abrir menu');
  toggle.innerHTML = icon(open ? 'close' : 'menu');
  if (restoreFocus) toggle.focus({ preventScroll: true });
}
$('#mobile-menu-toggle').addEventListener('click', () => {
  closeFilterMenus();
  setMobileMenuOpen($('#mobile-menu-toggle').getAttribute('aria-expanded') !== 'true');
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && $('.app-header').classList.contains('mobile-menu-open')) {
    event.preventDefault(); setMobileMenuOpen(false, true);
  }
});
document.addEventListener('click', event => {
  const path = event.composedPath();
  if (!path.includes($('#primary-navigation')) && !path.includes($('#mobile-menu-toggle'))) setMobileMenuOpen(false);
});
document.addEventListener('focusin', event => {
  if (!event.target.closest('#primary-navigation, #mobile-menu-toggle')) setMobileMenuOpen(false);
});
mobileNavigationQuery.addEventListener('change', () => {
  const restoreFocus = mobileNavigationQuery.matches && $('#primary-navigation').contains(document.activeElement);
  setMobileMenuOpen(false, restoreFocus);
});
document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => setView(button.dataset.view)));
window.addEventListener('hashchange', () => { const requested = location.hash.slice(1), view = canonicalView(requested); if (state.bootstrap && Object.hasOwn(titles, view) && (view !== state.view || requested !== view)) setView(view); });
$('.brand').addEventListener('click', event => { event.preventDefault(); setView('dashboard'); });
$('#close-fba-stock').addEventListener('click', () => $('#fba-stock-dialog').close());
$('#fba-stock-dialog').addEventListener('close', () => { fbaStockRequest++; });
$('#close-composition').addEventListener('click', () => $('#composition-dialog').close());
$('#composition-dialog').addEventListener('close', () => { compositionRequest++; compositionSelection = null; });
$('#composition-dialog').addEventListener('click', event => { if (event.target === $('#composition-dialog')) { const box = event.target.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) event.target.close(); } });
$('#close-dialog').addEventListener('click', () => $('#order-dialog').close());
$('#order-dialog').addEventListener('close', () => { orderDetailRequest++; });
$('#close-financial-case').addEventListener('click', () => $('#financial-case-dialog').close());
$('#close-bulk-review').addEventListener('click', () => { if (!bulkReviewSaving) $('#bulk-review-dialog').close(); });
$('#bulk-review-dialog').addEventListener('cancel', event => { if (bulkReviewSaving) event.preventDefault(); });
$('#close-customer-return').addEventListener('click', () => $('#customer-return-dialog').close());
$('#close-safe-t').addEventListener('click', () => $('#safe-t-dialog').close());
$('#customer-return-dialog').addEventListener('close', () => { customerReturnRequest++; });
$('#close-local-review').addEventListener('click', () => $('#local-review-dialog').close());
$('#local-review-dialog').addEventListener('close', () => { localReviewRequest++; localReviewSelection = null; });
$('#financial-case-dialog').addEventListener('close', () => { financialCaseRequest++; financialCaseSelection = null; });
$('#financial-case-dialog').addEventListener('click', event => { if (event.target === $('#financial-case-dialog')) { const box = event.target.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) event.target.close(); } });
$('#order-dialog').addEventListener('click', event => { if (event.target === $('#order-dialog')) { const box = event.target.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) event.target.close(); } });
function storeInitials(label, storeId) {
  const words = label.trim().split(/\s+/);
  return isMultipleStores(storeId) ? 'BR' : words[0]?.length === 2 ? words[0].toUpperCase() : words.slice(0, 2).map(word => word[0]).join('').toUpperCase();
}
function storeSelectionLabel(selection = state.storeId) {
  return selection === 'all' ? 'Todas as lojas' : (parseStoreSelection(selection) || []).map(storeName).join(' + ');
}
let storeDraft = new Set();
function renderStoreDraft(focusId) {
  const stores = state.bootstrap?.stores || [], allSelected = storeDraft.size === stores.length;
  const option = (id, label, selected, all = false) => `<button type="button" class="store-option${all ? ' store-option-all' : ''}" role="checkbox" tabindex="0" aria-checked="${selected}" aria-label="${escape(label)}" data-store-value="${escape(id)}" data-store-label="${escape(label)}"><span class="store-option-mark" aria-hidden="true">${all ? icon('dashboard') : escape(storeInitials(label,id))}</span><span class="store-option-text"><strong>${escape(label)}</strong><small>${all ? 'Visão consolidada' : 'Amazon Brasil'}</small></span><span class="store-option-check" aria-hidden="true">${icon('check')}</span></button>`;
  $('#store-options').innerHTML = stores.map(store => option(store.storeId, store.name || store.displayName || store.storeId, storeDraft.has(store.storeId))).join('') + (stores.length > 1 ? option('all','Todas as lojas',allSelected,true) : '');
  $('#store-selection-count').textContent = storeDraft.size ? counted(storeDraft.size, 'loja selecionada', 'lojas selecionadas') : 'Selecione pelo menos uma loja';
  $('#apply-stores').disabled = storeDraft.size === 0;
  if (focusId) [...$('#store-options').children].find(button => button.dataset.storeValue === focusId)?.focus({preventScroll:true});
}
function updateStoreIdentity() {
  const label = storeSelectionLabel(), ids = parseStoreSelection(state.storeId);
  const compact = ids?.length > 1 ? `${ids.length} lojas selecionadas` : label;
  $('#header-store-name').textContent = label;
  $('#header-store-name').title = label;
  const avatar = document.querySelector('.avatar');
  if (avatar) { avatar.textContent = storeInitials(label,state.storeId); avatar.setAttribute('aria-label',label); }
  const trigger = $('#store-trigger');
  trigger.disabled = !state.bootstrap?.stores?.length;
  trigger.setAttribute('aria-label', `Selecionar lojas: ${label}`); trigger.title = label;
  trigger.innerHTML = `<span class="store-trigger-icon">${icon('store')}</span><span class="store-trigger-label">${escape(compact)}</span>${icon('chevron')}`;
  // Keep the legacy hidden select consistent for navigation to an individual order.
  $('#store').innerHTML = (state.bootstrap?.stores || []).map(store => `<option value="${escape(store.storeId)}">${escape(store.name || store.displayName || store.storeId)}</option>`).join('') + `<option value="all">Todas as lojas</option>` + (ids?.length > 1 ? `<option value="${escape(state.storeId)}">${escape(compact)}</option>` : '');
  $('#store').value = state.storeId;
}
function openStoreMenu(last = false) {
  closeFilterMenus();
  const stores = state.bootstrap?.stores || [];
  if (!stores.length) return;
  storeDraft = new Set(parseStoreSelection(state.storeId) || stores.map(store => store.storeId));
  renderStoreDraft();
  $('#store-menu').hidden = false; $('#store-trigger').setAttribute('aria-expanded','true');
  const options = [...$('#store-options').children];
  (last ? options.at(-1) : options.find(option => option.getAttribute('aria-checked') === 'true') || options[0])?.focus({preventScroll:true});
}
function applyStoreSelection(selection) {
  const checked = restoreStoreSelection(selection,(state.bootstrap?.stores || []).map(store => store.storeId));
  if (!checked) return;
  closeFilterMenus();
  if (checked !== state.storeId) {
    state.storeId = checked; state.page = 0; salesAlertsState.offset = 0;
    try { localStorage.setItem('synthamazon-store',state.storeId); } catch {}
    updateStoreIdentity(); updateSync(); loadView();
  }
  $('#store-trigger').focus({preventScroll:true});
}
$('#store-trigger').addEventListener('click', () => $('#store-menu').hidden ? openStoreMenu() : closeFilterMenus());
$('#store-trigger').addEventListener('keydown', event => {
  if (['ArrowDown','ArrowUp'].includes(event.key)) { event.preventDefault(); openStoreMenu(event.key === 'ArrowUp'); }
});
$('#store-options').addEventListener('click', event => {
  const option = event.target.closest('[data-store-value]'); if (!option) return;
  event.stopPropagation();
  const id = option.dataset.storeValue, stores = state.bootstrap.stores.map(store => store.storeId);
  if (id === 'all') storeDraft = new Set(storeDraft.size === stores.length ? [] : stores);
  else if (storeDraft.has(id)) storeDraft.delete(id); else storeDraft.add(id);
  renderStoreDraft(id);
});
$('#apply-stores').addEventListener('click', () => {
  if (storeDraft.size) applyStoreSelection([...storeDraft].sort().join(','));
});
$('#store-menu').addEventListener('keydown', event => {
  const options = [...$('#store-options').children], index = options.indexOf(document.activeElement);
  if (event.key === 'Escape') {
    event.preventDefault(); event.stopPropagation(); closeFilterMenus(); $('#store-trigger').focus({preventScroll:true});
  } else if (index >= 0 && ['ArrowDown','ArrowUp','Home','End'].includes(event.key)) {
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
    options[next]?.focus({preventScroll:true});
  } else if (index >= 0 && event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey && event.key !== ' ') {
    const candidates = [...options.slice(index + 1),...options.slice(0,index + 1)];
    candidates.find(option => option.dataset.storeLabel.toLocaleLowerCase('pt-BR').startsWith(event.key.toLocaleLowerCase('pt-BR')))?.focus({preventScroll:true});
  }
});
$('.store-picker').addEventListener('focusout', event => {
  // A draft render temporarily removes the focused button; explicit focus is restored above.
  if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) closeFilterMenus();
});
function refreshStoreSelector() {
  const stores = state.bootstrap?.stores || [], allowed = stores.map(store => store.storeId);
  let saved = ''; try { saved = localStorage.getItem('synthamazon-store') || ''; } catch {}
  state.storeId = restoreStoreSelection(state.storeId,allowed) || restoreStoreSelection(saved,allowed) || (allowed.includes('origem-comercio') ? 'origem-comercio' : allowed[0] || '');
  updateStoreIdentity();
}
$('#store').addEventListener('change', event => applyStoreSelection(event.target.value));

$('#apply-period').addEventListener('click', applyPeriod);
document.querySelectorAll('[data-period]').forEach(button => button.addEventListener('click', () => setPeriodPreset(button.dataset.period)));
$('#reload').addEventListener('click', async () => {
  const button = $('#reload'); button.disabled = true;
  try { const result = await api('/api/reload', { method: 'POST', headers: { 'x-csrf-token': state.csrf } }); if (result.bootstrap) { state.bootstrap = result.bootstrap; rememberReviewSettings(state.bootstrap.reviewStatuses); state.csrf = result.bootstrap.meta?.csrfToken || state.csrf; refreshStoreSelector(); } updateSync(); await loadView(); showMessage(result.ok === false ? 'Algumas coletas locais não puderam ser importadas. Os dados disponíveis continuam visíveis; a base permanece incompleta.' : state.bootstrap.meta?.accountEmail ? 'Painel atualizado com os dados já importados.' : 'Os arquivos locais foram reimportados. Esta ação não faz uma nova consulta à Amazon.', result.ok === false ? 'warning' : ''); }
  catch (error) { showMessage(error.message, 'error'); }
  finally { button.disabled = false; }
});
async function init() {
  try {
    ({parseStoreSelection,isMultipleStores,matchesStoreSelection,restoreStoreSelection,selectedCollectionTimes} = await storeSelectionReady);
    layout = await layoutReady;
    selectMenus = await selectMenusReady;
    selectMenus.observeSelectMenus(document.body, {
      beforeChange: (select, trigger) => { if (select.closest('.table-filters')) pendingFilterFocus = trigger.id; },
      colorForOption: (select, option) => {
        if (!option) return null;
        if (['DBA','FBA','MFN'].includes(option.value)) return {DBA:'#397fc4',FBA:'#259177',MFN:'#9163bf'}[option.value];
        if (select.name === 'status' || /status|review/.test(select.id || select.dataset.rmFilter || '')) {
          const color = reviewDefinition(option.value)?.color;
          return reviewColorHex[color] || color;
        }
        return null;
      },
    });
    ({ loadAllRecords, loadInventoryRecords, fetchReadWithRetry, inventoryQuantities } = await listDataReady);
    state.pageSize = 10;
    state.bootstrap = await api('/api/bootstrap'); rememberReviewSettings(state.bootstrap.reviewStatuses); state.csrf = state.bootstrap.meta?.csrfToken || '';
    if (state.bootstrap.meta?.accountEmail) {
      $('#account-logout').hidden = false;
      $('#mobile-account-logout').hidden = false;
      $('#account-logout').title = `Sair de ${state.bootstrap.meta.accountEmail}`;
    }
    refreshStoreSelector();
    updateSync();
    const initialView = canonicalView(location.hash.slice(1));
    setView(Object.hasOwn(titles, initialView) ? initialView : 'dashboard');
  } catch (error) { showMessage(error.message, 'error'); $('#last-sync').textContent = 'Não foi possível concluir a conexão'; $('#content').innerHTML = empty('Não foi possível abrir a operação', location.protocol === 'https:' ? 'Atualize a página para tentar novamente.' : 'Abra o endereço de acesso local fornecido ao iniciar o sistema.'); $('#content').setAttribute('aria-busy', 'false'); }
}
setInterval(() => {
  if (state.bootstrap && state.view === 'returns' && document.visibilityState === 'visible' && !$('#order-dialog').open && !$('#local-review-dialog').open && !document.querySelector('dialog[open], [data-return-select]:checked') && !$('#content').contains(document.activeElement) && $('#content').getAttribute('aria-busy') !== 'true') loadView(false, { preserveContent: true }).catch(() => {});
}, 60000);
init();
