const API = '/api/refund-management';
const COLUMN_KEY = 'synthamazon-refund-management-columns-v4';
const PREVIOUS_COLUMN_KEY = 'synthamazon-refund-management-columns-v3';
const OLDER_COLUMN_KEY = 'synthamazon-refund-management-columns-v2';
const LEGACY_COLUMN_KEY = 'synthamazon-refund-management-columns-v1';
const columns = [
  ['date', 'Data'], ['order', 'ID pedido'], ['orderStatus', 'Status do pedido'], ['returnSignals', 'Devolução'], ['description', 'Produto / SKU'],
  ['refundValue', 'Débito do reembolso'], ['amazonPayment', 'Pagamento Amazon'],
  ['safeTDate', 'Data SAFE-T'], ['status', 'Status da análise'], ['annotation', 'Anotação'],
  ['observation', 'Observação'], ['caseId', 'ID Caso'], ['safeTId', 'ID SAFE-T'],
];
const channelLabels = { FBA: 'FBA', DBA: 'DBA', MFN: 'Envio próprio', unknown: 'Não informado' };
const workflowLabels = { active: 'Em acompanhamento', finalized: 'Finalizados', all: 'Todos' };
const reasonOptions = [['safe_t_received', 'SAFE-T Recebido'], ['manual_refund', 'Resolvido/reembolsado manualmente'], ['return_received', 'Devolução recebida'], ['other', 'Outro motivo']];
const e = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const q = (root, selector) => root.querySelector(selector);
const key = row => JSON.stringify([row.storeId, row.managementId]);
const count = value => Number.isFinite(value) ? new Intl.NumberFormat('pt-BR').format(value) : '—';
const text = value => value ? e(value) : '—';
const isFinalized = row => row.management?.workflowState === 'finalized';
const financialExcluded = row => [row?.financialEligibility, row?.order?.financialEligibility].some(eligibility => eligibility?.included === false && eligibility.reason === 'payment-pending');
const pendingPaymentMarkup = () => '<span class="muted">Pagamento pendente</span><small>Fora dos indicadores até a confirmação do pagamento.</small>';
const finiteCents = value => /^-?\d+$/.test(String(value ?? ''));
const hasPayment = row => !financialExcluded(row) && (row.payment?.byCurrency || []).some(value => finiteCents(value.totalCents) && BigInt(value.totalCents) > 0n);
const hasNewPayment = row => !financialExcluded(row) && row.payment?.confirmationRequired;
const hasPaymentVariance = row => !financialExcluded(row) && row.payment?.variance?.requiresAcknowledgement;
const symbols = {
  columns: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16M15 4v16"/>',
};
function icon(h, name) { return symbols[name] ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${symbols[name]}</svg>` : h.icon(name); }
function amounts(values, h) { return values?.length ? values.map(value => `<span class="rm-money">${e(h.money(value.totalCents, value.currency))}</span>`).join('') : '<span class="rm-money">—</span>'; }
function statusBadge(row, h) { return h.colorBadge(row.management?.label || (row.management?.status ? row.management.status : 'Sem status'), row.management?.color || 'neutral'); }
function asDate(value, h, time = false) { return value ? e(h.date(value, time)) : '—'; }
function daysRemaining(value) {
  if (!value || Number.isNaN(Date.parse(value))) return null;
  const localDay = date => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date).filter(part => ['year', 'month', 'day'].includes(part.type)).reduce((out, part) => ({ ...out, [part.type]: part.value }), {});
  const toDay = date => { const parts = localDay(date); return `${parts.year}-${parts.month}-${parts.day}`; };
  const due = /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : toDay(new Date(value));
  return Math.round((Date.parse(`${due}T00:00:00Z`) - Date.parse(`${toDay(new Date())}T00:00:00Z`)) / 86400000);
}
function deadlineCell(row, h) {
  if (financialExcluded(row)) return pendingPaymentMarkup();
  const days = daysRemaining(row.safeTDueAt);
  const notice = ['proactive-refund', 'proactive-dba-refund', 'fba-refund', 'customer-return-wait'].includes(row.deadlinePolicy?.kind)
    ? `<small class="rm-proactive-refund-notice" title="${e(row.deadlinePolicy.description)}">${e(row.deadlinePolicy.label)}</small>` : '';
  return `<span>${asDate(row.safeTDueAt, h)}</span>${notice}<small>${days === null ? 'Data não identificada' : days < 0 ? `${count(-days)} ${days === -1 ? 'dia vencido' : 'dias vencidos'}` : days === 0 ? 'Hoje' : `${count(days)} ${days === 1 ? 'dia restante' : 'dias restantes'}`}</small>`;
}
function paymentTypeLabel(item) {
  const code = typeof item === 'string' ? item : item.code || item.type;
  return ({ safe_t: 'SAFE-T RECEBIDO', easy_ship: 'EASY-SHIP RECEBIDO' })[code] || (typeof item === 'object' ? item.label : item) || 'Crédito identificado';
}
function paymentCell(row, h) {
  if (financialExcluded(row)) return pendingPaymentMarkup();
  if (!hasPayment(row)) return '<span class="muted">Não identificado</span><small>Nos dados importados</small>';
  const paidAt = row.payment.lastCreditAt;
  const paymentDate = paidAt && Number.isFinite(Date.parse(paidAt)) ? `<small class="rm-payment-date" title="Data do lançamento do crédito na Amazon">${row.payment.credits?.length > 1 ? 'Último crédito' : 'Crédito'} em ${asDate(paidAt, h)}</small>` : '';
  return `${amounts(row.payment.byCurrency, h)}${paymentDate}${(row.payment.types || []).map(item => `<small>${e(paymentTypeLabel(item))}</small>`).join('')}<small>${row.payment.confirmationRequired ? 'Novo pagamento — revisar' : row.payment.confirmedAt ? 'Crédito conferido' : 'Crédito identificado'}</small>`;
}
function amazonLink(url, content, title) { return `<a class="rm-amazon-link" href="${e(url)}" target="_blank" rel="noopener noreferrer" title="${e(title)}">${content}</a>`; }
export function caseLinkMarkup(management = {}, { inline = false } = {}) {
  const id = String(management.caseId || '').trim();
  if (!id) return inline ? '' : '—';
  const link = amazonLink(`https://sellercentral.amazon.com.br/cu/case-dashboard/view-case?ref=sc_cd_lobby_vc_v3&ie=UTF&caseID=${encodeURIComponent(id)}`, e(id), `Abrir caso ${id} na Amazon`);
  return inline ? `<small class="rm-case-link"><span class="rm-case-label">ID DO CASO</span><span>${link}</span></small>` : link;
}
export function safeTLinksMarkup(management = {}, { inline = false } = {}) {
  const ids = [...new Set(String(management.safeTId || '').split(',').map(id => id.trim()).filter(Boolean))];
  if (!ids.length) return inline ? '' : '—';
  const source = ({ 'amazon-finances': 'Identificado nos lançamentos da Amazon',
    'amazon-return-report': 'Solicitação identificada no relatório da Amazon',
    'seller-central-report': 'Identificado no relatório SAFE-T do Seller Central',
    'amazon-multiple-sources': 'Identificado nos relatórios e consultas da Amazon',
    'amazon-reports-and-finances': 'Identificado nos relatórios e lançamentos da Amazon' })[management.safeTIdSource] || 'Informado no acompanhamento';
  const links = ids.map(id => amazonLink(`https://sellercentral.amazon.com.br/safet-claims/claim/${encodeURIComponent(id)}`, e(id), `Abrir SAFE-T ${id} na Amazon · ${source}`)).join('<br>');
  return inline ? `<small class="rm-safe-t-links"><span class="rm-safe-t-label">SAFE-T</span><span>${links}</span></small>` : links;
}
function returnReference(row) {
  const reference = row.management?.returnTracking;
  if (!reference) return '';
  if (!/^\d{3}-\d{7}-\d{7}$/.test(row.orderId)) return `<small>${e(reference)}</small>`;
  const url = new URL('https://sellercentral.amazon.com.br/gp/returns/list/v2');
  for (const [name, value] of Object.entries({ searchBy: 'undefined', searchString: row.orderId, marketplaceIds: 'A2Q3Y263D00KWC,ATVPDKIKX0DER', tabId: 'viewAll', returnRequestState: 'viewAll', orderBy: 'CreatedDateAsc', selectedDateRange: '50', pendingActionsFilterBy: 'null', isOnPendingActionsTab: 'false' })) url.searchParams.set(name, value);
  return `<small>${amazonLink(url.toString(), e(reference), 'Rastreio ou autorização informado manualmente. Abrir devoluções na Amazon; confira o período consultado')}</small>`;
}
function returnSignalsMarkup(row, h) {
  const signals = row.returnSignals || {}, returned = signals.returnedToSeller;
  const open = Array.isArray(signals.openCustomerReturns) ? signals.openCustomerReturns : [];
  const unknown = Array.isArray(signals.unknownCustomerReturns) ? signals.unknownCustomerReturns : [];
  const recorded = Array.isArray(row.returnLinks?.customerReturns) ? row.returnLinks.customerReturns : [];
  const notices = [];
  const button = (view, label, info) => `<button type="button" class="rm-return-signal" data-rm-related-return="${view}" data-rm-related-key="${e(key(row))}" title="${e(info)}" aria-label="${e(`${label}. ${info}. Abrir registros do pedido ${row.orderId}.`)}">${e(label)}</button>`;
  if (returned?.current === true) {
    const knownCounts = Number.isSafeInteger(returned.currentPackageCount) && Number.isSafeInteger(returned.packageCount) && returned.packageCount > 0;
    const partial = returned.partial ? knownCounts ? ` · ${count(returned.currentPackageCount)}/${count(returned.packageCount)} pacotes` : ' · parte dos pacotes' : '';
    const info = `Fonte: rastreio Amazon.${returned.statusObservedAt ? ` Consultado em ${h.date(returned.statusObservedAt, true)}.` : ' Data da consulta não informada.'} A consulta não informa a hora exata do evento da transportadora.`;
    const quantity = !partial && returned.currentPackageCount > 1 ? ` (${count(returned.currentPackageCount)} pacotes)` : '';
    notices.push(button('returns', `Devolvido ao vendedor${partial || quantity}`, info));
  } else if (returned?.historical === true) {
    const info = `Registro anterior: devolvido ao vendedor, informado pelo rastreio Amazon.${returned.detectedAt ? ` Detectado em ${h.date(returned.detectedAt, true)}.` : ''}${returned.statusObservedAt ? ` Última consulta em ${h.date(returned.statusObservedAt, true)}.` : ''} ${returned.currentStateKnown === false ? 'A situação atual ainda não está confirmada.' : 'Este registro não indica a situação atual do rastreio.'}`;
    notices.push(button('returns', 'Registro anterior', info));
  }
  const sourceLabels = { GET_FLAT_FILE_RETURNS_DATA_BY_RETURN_DATE: 'Solicitações de devolução do vendedor', GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA: 'Devoluções recebidas no FBA' };
  const reportInfo = records => records.map(item => `Fonte: ${sourceLabels[item.reportType] || item.reportType || 'Relatório Amazon'}. Status informado: ${item.returnStatus || 'Não informado'}. ${item.observedAt ? `Consultado em ${h.date(item.observedAt, true)}.` : 'Data da consulta não informada.'}`).join('\n');
  if (open.length) notices.push(button('customer-returns', `Em aberto${open.length > 1 ? ` (${count(open.length)})` : ''}`, reportInfo(open)));
  else if (unknown.length) notices.push(button('customer-returns', `Registrada${unknown.length > 1 ? ` (${count(unknown.length)})` : ''}`, `Situação em aberto não confirmada. ${reportInfo(unknown)}`));
  else if (recorded.length) notices.push(button('customer-returns', `Registrada${recorded.length > 1 ? ` (${count(recorded.length)})` : ''}`, `Registro de devolução da Amazon. Não confirma solicitação em aberto. ${reportInfo(recorded)}`));
  return notices.length ? `<div class="rm-return-signals">${notices.join('')}</div>` : '<span class="muted">—</span>';
}
function observations(row) {
  if (typeof row.observation === 'string') return row.observation;
  if (typeof row.management?.notes === 'string') return row.management.notes;
  if (typeof row.notes === 'string') return row.notes;
  if (Array.isArray(row.notes)) return row.notes.map(item => typeof item === 'string' ? item : item.note || item.text || '').filter(Boolean).join('\n\n');
  return row.management?.latestNote || '';
}
export function createRefundManagementState() {
  const defaultColumns = columns.map(([id]) => id).filter(id => !['caseId', 'safeTId'].includes(id));
  let visibleColumns = defaultColumns;
  try {
    const readColumns = storageKey => {
      try {
        const saved = JSON.parse(localStorage.getItem(storageKey));
        if (!Array.isArray(saved)) return null;
        const valid = [...new Set(saved.map(id => id === 'channel' ? 'order' : id === 'quantity' ? 'description' : id))].filter(id => columns.some(([known]) => known === id));
        return valid.length ? valid : null;
      } catch { return null; }
    };
    const saved = readColumns(COLUMN_KEY);
    if (saved) visibleColumns = saved;
    else {
      const previous = readColumns(PREVIOUS_COLUMN_KEY);
      const older = previous ? null : readColumns(OLDER_COLUMN_KEY);
      const legacy = previous || older ? null : readColumns(LEGACY_COLUMN_KEY);
      if (previous) visibleColumns = defaultColumns.filter(id => previous.includes(id));
      else if (older) visibleColumns = defaultColumns.filter(id => id === 'returnSignals' || older.includes(id));
      else if (legacy) visibleColumns = defaultColumns.filter(id => ['orderStatus', 'returnSignals'].includes(id) || legacy.includes(id));
      if (!visibleColumns.length) visibleColumns = defaultColumns;
      localStorage.setItem(COLUMN_KEY, JSON.stringify(visibleColumns));
    }
  } catch {}
  return { workflow: 'active', query: '', status: 'all', orderStatus: 'all', orderStatusLabels: {}, mode: 'all', returnFilter: 'all', deadline: 'all', payment: 'all', sort: 'refundDate', direction: 'desc', cardsExpanded: true, visibleColumns, selection: new Map(), scope: '', data: null, _cleanup: null, _generation: 0 };
}
export function refundManagementParams(state, storeId) {
  const scope = filterScope(state, storeId);
  if (scope !== state.scope) { state.selection.clear(); state.scope = scope; }
  return new URLSearchParams({ storeId, workflow: state.workflow, query: state.query, status: state.status, orderStatus: state.orderStatus || 'all', mode: state.mode, returnFilter: state.returnFilter, deadline: state.deadline, payment: state.payment, sort: state.sort || 'refundDate', direction: state.direction || 'desc', limit: 500, offset: 0 });
}
function filterScope(state, storeId) { return JSON.stringify([storeId, state.workflow, state.query, state.status, state.orderStatus || 'all', state.mode, state.returnFilter, state.deadline, state.payment]); }
function resetFilters(state) { Object.assign(state, { query: '', status: 'all', orderStatus: 'all', mode: 'all', returnFilter: 'all', deadline: 'all', payment: 'all' }); state.selection.clear(); }
function selectedRows(state) { return [...state.selection.values()]; }
function columnPicker(state, h) {
  return `<details class="rm-columns"><summary>${icon(h, 'columns')} Colunas</summary><div class="rm-columns-menu">${columns.map(([id, label]) => `<label><input type="checkbox" data-rm-column="${id}" ${state.visibleColumns.includes(id) ? 'checked' : ''}>${e(label)}</label>`).join('')}</div></details>`;
}
function selectFilter(id, label, value, options) {
  return `<label class="rm-filter"><span class="sr-only">${e(label)}</span><select data-rm-filter="${id}" aria-label="${e(label)}">${options.map(item => { const [code, name] = Array.isArray(item) ? item : [item.code, item.label]; return `<option value="${e(code)}" ${code === value ? 'selected' : ''}>${e(name || code)}</option>`; }).join('')}</select></label>`;
}
function selectedOrderStatuses(state) { return new Set((state.orderStatus || 'all').split(',').filter(code => code && code !== 'all')); }
function orderStatusFilter(data, state, h) {
  const selected = selectedOrderStatuses(state), options = new Map();
  state.orderStatusLabels ||= {};
  for (const item of data.orderStatusOptions || []) {
    if (!item.code || item.code === 'all') continue;
    options.set(item.code, item);
    state.orderStatusLabels[item.code] = item.label || item.code;
  }
  for (const code of selected) if (!options.has(code)) options.set(code, { code, label: state.orderStatusLabels[code] || code, count: 0 });
  const caption = selected.size === 1 ? options.get([...selected][0]).label : selected.size ? `${count(selected.size)} selecionados` : 'Todos';
  return `<div class="rm-order-status-filter"><button type="button" class="rm-order-status-trigger" data-rm-order-status-trigger aria-haspopup="dialog" aria-expanded="false" aria-controls="rm-order-status-menu" aria-label="Status do pedido: ${e(caption)}"><span><small>Status do pedido</small><span>${e(caption)}</span></span>${icon(h, 'chevron')}</button><div class="rm-order-status-menu" id="rm-order-status-menu" role="dialog" aria-label="Filtrar por status do pedido" hidden><fieldset><legend>Status do pedido</legend><p>Mostrar pedidos com qualquer status selecionado.</p><div class="rm-order-status-options"><label><input type="checkbox" data-rm-order-status-option="all" ${selected.size ? '' : 'checked'}><span>Todos</span></label>${[...options.values()].map(item => `<label><input type="checkbox" data-rm-order-status-option="${e(item.code)}" ${selected.has(item.code) ? 'checked' : ''}><span>${e(item.label || item.code)}</span><small>${count(item.count)}</small></label>`).join('')}</div></fieldset><div class="rm-order-status-actions"><button type="button" class="button" data-rm-order-status-cancel>Cancelar</button><button type="button" class="button primary" data-rm-order-status-apply>Aplicar</button></div></div></div>`;
}
function metric(h, action, title, value, caption, symbol, tone, pressed) {
  return `<button type="button" class="rm-metric ${tone || ''}" data-rm-card="${action}" aria-pressed="${pressed}"><span><span class="rm-metric-label">${e(title)}</span><strong class="rm-metric-value">${value}</strong></span><span class="rm-metric-icon">${icon(h, symbol)}</span><span class="rm-metric-caption">${caption}</span></button>`;
}
function columnHeading(id, label, state) {
  const sort = id === 'date' ? 'refundDate' : id === 'safeTDate' ? 'safeTDate' : null;
  const title = id === 'safeTDate' ? ' title="Após o reembolso: 45 dias para Aguardando reembolso FBA; 50 dias para DBA ou acompanhamento comum; 60 dias para reembolso proativo ou Devolução de cliente · SAFE-T 60 dias"' : '';
  if (!sort) return `<th>${e(label)}</th>`;
  const selected = state.sort === sort;
  return `<th${title} aria-sort="${selected ? state.direction === 'asc' ? 'ascending' : 'descending' : 'none'}"><button type="button" class="rm-sort" data-rm-sort="${sort}" aria-label="Ordenar ${e(label)} ${selected && state.direction === 'asc' ? 'da maior para a menor data' : 'da menor para a maior data'}">${e(label)}<span aria-hidden="true">${selected ? state.direction === 'asc' ? '↑' : '↓' : '↕'}</span></button></th>`;
}
function summaryMarkup(data, state, h) {
  if (state.workflow !== 'active') return `<div class="rm-summary-heading rm-summary-tools">${columnPicker(state, h)}</div>`;
  const summary = data.summary || {}, unfiltered = !state.query && [state.status, state.orderStatus || 'all', state.mode, state.returnFilter, state.deadline, state.payment].every(value => value === 'all');
  const overdueSelected = state.deadline === 'overdue' && state.payment === 'unpaid';
  return `<div class="rm-summary-heading"><div><strong>Resumo da fila</strong></div><div class="rm-summary-actions">${columnPicker(state, h)}<button type="button" class="button" data-rm-toggle-cards aria-expanded="${state.cardsExpanded}">${state.cardsExpanded ? 'Recolher cards' : 'Mostrar cards'} ${icon(h, 'chevron')}</button></div></div>${state.cardsExpanded ? `<div class="rm-summary-grid">${metric(h, 'all', 'Em gerenciamento', count(summary.activeCount), 'Mostrar todos os pedidos ativos', 'orders', '', unfiltered)}${metric(h, 'all', 'Total debitado', amounts(summary.activeRefundByCurrency, h), 'Débitos registrados nos reembolsos ativos', 'money', 'rm-danger', unfiltered)}${metric(h, 'pending', 'Pagamentos para revisar', count(summary.paymentAlertCount), `${amounts(summary.paymentDetectedByCurrency, h)} novos, ainda não conferidos`, 'money', 'rm-good', state.payment === 'pending')}${metric(h, 'overdue', 'SAFE-T vencido', count(summary.overdueSafeTCount), 'Referência interna · sem crédito identificado', 'clock', 'rm-warning', overdueSelected)}</div>` : ''}${summary.paymentAlertCount > 0 ? `<button type="button" class="rm-payment-notice" data-rm-card="pending">${icon(h, 'money')}<span><strong>${count(summary.paymentAlertCount)} ${summary.paymentAlertCount === 1 ? 'novo pagamento da Amazon aguarda' : 'novos pagamentos da Amazon aguardam'} conferência</strong><small>Os pedidos continuam na fila até você revisar, conferir o status e confirmar a finalização. Crédito registrado não confirma depósito bancário.</small></span>${icon(h, 'arrow')}</button>` : ''}`;
}
function channelBadge(mode) {
  const channel = ['FBA', 'DBA', 'MFN'].includes(mode) ? mode : 'unknown';
  return `<span class="rm-channel-badge" data-channel="${channel}" aria-label="Canal: ${e(channelLabels[channel])}">${e(channelLabels[channel])}</span>`;
}
function rowCell(id, row, h) {
  const management = row.management || {}, products = row.products || row.order?.items || [], first = products[0];
  const quantities = products.map(product => product.quantityOrdered);
  const quantity = quantities.length && quantities.every(Number.isSafeInteger) ? quantities.reduce((sum, value) => sum + value, 0) : null;
  switch (id) {
    case 'date': return `${asDate(row.refund?.firstEventAt, h)}${row.refund?.dateKnown === false ? '<small>Data incompleta</small>' : ''}`;
    case 'order': return `<div class="rm-order-identity"><span class="rm-order-control">${row.order ? `<button type="button" class="rm-order-link" data-rm-order="${e(key(row))}" title="Ver detalhes do pedido">${e(row.orderId)}</button>` : `<span class="rm-order-link">${e(row.orderId)}</span>`}<button type="button" class="copy-order" data-copy-order="${e(row.orderId)}" aria-label="Copiar número do pedido ${e(row.orderId)}">${icon(h, 'copy')}<span class="copy-label">Copiar</span></button></span>${safeTLinksMarkup(management, { inline: true })}${caseLinkMarkup(management, { inline: true })}${channelBadge(row.fulfillmentMode)}</div>${returnReference(row)}${row.sourceMissing ? '<small>Fora da fonte importada atual</small>' : ''}`;

    case 'orderStatus': return `<button type="button" class="rm-order-status rm-order-status-info" data-rm-operational="${e(key(row))}" aria-label="Consultar informações operacionais do pedido ${e(row.orderId)}" title="Consultar informações operacionais">${h.orderDisplayStatusMarkup({ displayStatus: row.displayStatus || row.order?.displayStatus })}</button>`;
    case 'returnSignals': return returnSignalsMarkup(row, h);
    case 'description': return `<span class="rm-product" title="${e(first?.title || '')}">${text(first?.title)}</span><small class="rm-sku" title="${e(first?.sku || '')}">${e(first?.sku || 'SKU não informado')}${products.length > 1 ? ` · +${products.length - 1}` : ''}</small><span class="product-quantity"><span>Quantidade</span><strong>${count(quantity)}</strong></span>`;
    case 'refundValue': return financialExcluded(row) ? pendingPaymentMarkup() : `${amazonLink(`https://sellercentral.amazon.com.br/payments/event/view?accountType=ALL&orderId=${encodeURIComponent(row.orderId)}&resultsPerPage=10&pageNumber=1`, amounts(row.refund?.byCurrency, h), 'Abrir detalhes financeiros na Amazon')}${row.refund?.allocation === 'multiple-orders-unallocated' ? '<small>Sem rateio por pedido</small>' : ''}`;
    case 'amazonPayment': return paymentCell(row, h);
    case 'safeTDate': return deadlineCell(row, h);
    case 'status': return `<button type="button" class="rm-status-button" data-rm-edit="${e(key(row))}" aria-label="Editar pedido ${e(row.orderId)}" title="Editar acompanhamento">${statusBadge(row, h)}</button>${isFinalized(row) && management.finalizedAt ? `<small>Finalizado em ${asDate(management.finalizedAt, h)}</small>` : ''}`;
    case 'annotation': return `<button type="button" class="rm-note-link" data-rm-read="${e(key(row))}" data-rm-note-kind="annotation" aria-label="Ler anotação do pedido ${e(row.orderId)}" title="Ler anotação completa"><span class="rm-ellipsis">${text(management.shortNote)}</span></button>`;
    case 'observation': return `<button type="button" class="rm-note-link" data-rm-read="${e(key(row))}" data-rm-note-kind="observation" aria-label="Ler observações do pedido ${e(row.orderId)}" title="Ler observações completas"><span class="rm-ellipsis">${text(observations(row))}</span></button>`;
    case 'caseId': return caseLinkMarkup(management);
    case 'safeTId': return safeTLinksMarkup(management);
    default: return '—';
  }
}
function listSummaryMarkup(data) {
  return `<div class="rm-table-footer"><span>${count(data.items?.length || 0)} pedidos exibidos · todos os resultados dos filtros</span></div>`;
}
function tableMarkup(data, state, h) {
  const rows = data.items || [], visible = columns.filter(([id]) => state.visibleColumns.includes(id));
  const allSelected = rows.length > 0 && rows.every(row => state.selection.has(key(row)));
  const selected = selectedRows(state), allActive = selected.length > 0 && selected.every(row => !isFinalized(row)), allFinalized = selected.length > 0 && selected.every(isFinalized);
  return `<div class="rm-table-scroll"><table class="rm-table"><colgroup><col class="rm-col-select">${visible.map(([id]) => `<col class="rm-col-${id}">`).join('')}</colgroup><thead><tr><th><input type="checkbox" data-rm-select-visible aria-label="Selecionar pedidos exibidos, até 100" ${allSelected ? 'checked' : ''}></th>${visible.map(([id, label]) => columnHeading(id, label, state)).join('')}</tr></thead><tbody>${rows.map(row => { const pending = !isFinalized(row) && hasNewPayment(row), overdue = !isFinalized(row) && !financialExcluded(row) && !hasPayment(row) && daysRemaining(row.safeTDueAt) < 0; return `<tr data-order-card="${e(row.orderId)}" data-store="${e(row.storeId)}" class="${pending ? 'rm-new-payment' : overdue ? 'rm-overdue' : ''}"><td><input type="checkbox" data-rm-select="${e(key(row))}" aria-label="Selecionar pedido ${e(row.orderId)}" ${state.selection.has(key(row)) ? 'checked' : ''}></td>${visible.map(([id]) => `<td${id === 'orderStatus' ? ' data-rm-operational-cell' : ''}${['annotation', 'observation'].includes(id) ? ` data-rm-note-cell="${id}"` : ''}>${rowCell(id, row, h)}</td>`).join('')}</tr>`; }).join('')}</tbody></table>${!rows.length ? '<div class="rm-empty"><strong>Nenhum reembolso encontrado</strong><p>Ajuste os filtros ou confira os dados importados.</p></div>' : ''}${listSummaryMarkup(data)}</div>${selected.length ? `<div class="rm-selection-bar" role="region" aria-label="Ações dos pedidos selecionados"><strong aria-live="polite">${count(selected.length)} ${selected.length === 1 ? 'selecionado' : 'selecionados'}</strong><button type="button" class="button" data-rm-clear-selection>Limpar seleção</button><button type="button" class="button" data-rm-bulk-edit>Editar selecionados</button>${allActive ? '<button type="button" class="button primary" data-rm-bulk-finalize>Finalizar selecionados</button>' : allFinalized ? '<button type="button" class="button primary" data-rm-bulk-reopen>Reabrir selecionados</button>' : '<small>A seleção mistura pedidos ativos e finalizados. A edição permanece disponível.</small>'}</div>` : ''}`;
}
export function renderRefundManagement(data, state, helpers) {
  state.data = data;
  const counts = data.summary?.workflowCounts || {}, workflow = state.workflow;
  const statusOptions = (data.statusOptions || []).filter(item => item.code !== 'all');
  if (state.status !== 'all' && !statusOptions.some(item => item.code === state.status)) statusOptions.push({ code: state.status, label: state.statusLabel || state.status, count: 0 });
  const filterCount = (state.query ? 1 : 0) + [state.status, state.orderStatus || 'all', state.mode, state.returnFilter, state.deadline, state.payment].filter(value => value !== 'all').length;
  const title = workflow === 'active' ? 'Reembolsos em acompanhamento' : workflow === 'finalized' ? 'Reembolsos finalizados' : 'Todos os reembolsos';
  return `<div class="rm-workspace"><header class="rm-heading"><div><p class="eyebrow">${workflow === 'active' ? 'FILA DE TRABALHO' : workflow === 'finalized' ? 'HISTÓRICO CONFIRMADO' : 'VISÃO COMPLETA'}</p><h1>${title}</h1><p>${count(counts[workflow])} pedidos ${workflow === 'active' ? 'permanecem sob acompanhamento' : workflow === 'finalized' ? 'já saíram da fila ativa' : 'entre acompanhamento e histórico'}</p></div><button type="button" class="button" data-rm-refresh>${icon(helpers, 'refresh')} Recarregar dados locais</button></header><div class="rm-tabs" role="tablist" aria-label="Fila de reembolsos">${Object.entries(workflowLabels).map(([code, label]) => `<button type="button" role="tab" id="rm-tab-${code}" data-rm-workflow="${code}" aria-selected="${workflow === code}" aria-controls="rm-workspace-panel" tabindex="${workflow === code ? 0 : -1}">${e(label)} (${count(counts[code])})</button>`).join('')}</div><div id="rm-workspace-panel" role="tabpanel" aria-labelledby="rm-tab-${workflow}">${summaryMarkup(data, state, helpers)}${data.summary?.excludedPendingCaseCount > 0 ? `<p class="rm-notice">${count(data.summary.excludedPendingCaseCount)} ${data.summary.excludedPendingCaseCount === 1 ? 'pedido com pagamento pendente está fora' : 'pedidos com pagamento pendente estão fora'} dos indicadores financeiros. O acompanhamento e o histórico foram preservados.</p>` : ''}<section class="rm-panel"><div class="rm-filter-bar"><label class="rm-search">${icon(helpers, 'search')}<span class="sr-only">Buscar reembolsos</span><input type="search" data-rm-search maxlength="200" autocomplete="off" placeholder="Pedido, caso, SAFE-T, rastreio, SKU…" value="${e(state.query)}"></label>${selectFilter('status', 'Status da análise', state.status, [['all', 'Todos os status da análise'], ...statusOptions])}${orderStatusFilter(data, state, helpers)}${selectFilter('mode', 'Filtrar por canal', state.mode, [['all', 'Todos os canais'], ...Object.entries(channelLabels)])}${selectFilter('returnFilter', 'Filtrar por devolução', state.returnFilter, [['all', 'Todos os pedidos'], ['withReturn', 'Com devolução'], ['withoutReturn', 'Sem devolução identificada']])}${selectFilter('deadline', 'Referência interna SAFE-T', state.deadline, [['all', 'Todos os prazos SAFE-T'], ['upcoming', 'Próximos prazos'], ['overdue', 'Prazo vencido']])}${selectFilter('payment', 'Filtrar por pagamento', state.payment, [['all', 'Todos os pagamentos'], ['pending', 'Novo pagamento — revisar'], ['paid', 'Pagamento já conferido'], ['unpaid', 'Sem pagamento identificado'], ['variance', 'Diferença importante']])}</div>${filterCount ? `<div class="rm-filter-summary"><span>${filterCount} ${filterCount === 1 ? 'filtro ativo' : 'filtros ativos'}</span><button type="button" class="button" data-rm-clear-filters>Limpar filtros</button></div>` : ''}<div data-rm-table>${tableMarkup(data, state, helpers)}</div></section><p class="rm-notice">${e(data.deadlinePolicy?.label || 'Data SAFE-T: 45 dias após o reembolso no status Aguardando reembolso FBA; 50 dias para DBA ou acompanhamento comum; 60 dias para reembolso proativo ou Devolução de cliente · SAFE-T 60 dias.')} O acompanhamento é local. Créditos identificados não confirmam cobertura integral nem depósito bancário.</p></div></div>`;
}

function statusOptions(statuses, current, { bulk = false, finalize = false } = {}) {
  const options = statuses.filter(item => item.active !== false && !item.automatic);
  if (!bulk && !finalize && current?.status && !options.some(item => item.code === current.status)) options.push({ code: current.status, label: current.label || current.status, preserved: true });
  const first = finalize ? '<option value="">Escolha o status</option>' : bulk ? '<option value="__keep__">Manter o status atual</option>' : `<option value="" ${!current?.status ? 'selected' : ''}>Sem status</option>`;
  return first + options.map(item => `<option value="${e(item.code)}" data-color="${e(item.color || '')}" ${!bulk && !finalize && item.code === current?.status ? 'selected' : ''}>${e(item.label || item.code)}${item.preserved ? ' (status atual preservado)' : ''}</option>`).join('');
}
function historyText(row, h) {
  const notes = Array.isArray(row.notes) ? row.notes.map(item => `${item.createdAt ? `${h.date(item.createdAt, true)}\n` : ''}${item.note || item.text || ''}`).join('\n\n') : typeof row.notes === 'string' ? row.notes : '';
  const legacy = (row.legacyReviews || []).filter(item => item.review?.notes).map(item => `Anotações anteriores em Reembolsos${item.review.updatedAt ? ` · ${h.date(item.review.updatedAt, true)}` : ''}\n${item.review.notes}`).join('\n\n');
  return [notes, legacy].filter(Boolean).join('\n\n') || 'Nenhuma observação registrada.';
}
export function refundNotesMarkup(row, h, kind = 'annotation') {
  const note = `<section class="rm-reading-section"><h3>Anotação</h3><pre>${e(row.management?.shortNote || 'Nenhuma anotação registrada.')}</pre></section>`;
  const recentFirst = { ...row, notes: Array.isArray(row.notes) ? [...row.notes].reverse() : row.notes };
  const history = `<section class="rm-reading-section"><h3>Observações registradas</h3><p class="rm-reading-caption">Mais recentes primeiro</p><pre>${e(historyText(recentFirst, h))}</pre></section>`;
  return `<div class="rm-reading-grid${kind === 'observation' ? ' rm-reading-observations' : ''}">${kind === 'observation' ? history + note : note + history}</div>`;
}
function editMarkup(row, statuses, h) {
  const current = row.management || {};
  return `${financialExcluded(row) ? '<div class="rm-alert"><strong>Pagamento pendente</strong><p>Fora dos indicadores até a confirmação do pagamento. A edição abaixo mantém o acompanhamento local.</p></div>' : ''}<div class="rm-form-grid"><label>Status da análise<select name="status">${statusOptions(statuses, current)}</select></label><label>ID Caso<input name="caseId" value="${e(current.caseId || '')}" maxlength="30" inputmode="numeric" pattern="[0-9]*" autocomplete="off"></label><label>Correção manual do ID SAFE-T<input name="safeTId" value="${e(current.manualSafeTId ?? current.safeTId ?? '')}" maxlength="100" autocomplete="off"><small>${current.automaticSafeTClaims?.length ? `Identificado na Amazon: ${e(current.automaticSafeTClaims.map(claim => claim.claimId).join(', '))}. Deixe vazio para usar os IDs automáticos.` : 'Informe o protocolo se ainda não houver um ID identificado na Amazon.'}</small></label><label>Rastreio ou autorização da devolução (anotação manual)<input name="returnTracking" value="${e(current.returnTracking || '')}" maxlength="200" autocomplete="off"></label><label class="rm-full">Anotação<textarea name="shortNote" maxlength="500" rows="3" placeholder="Resumo para a tabela">${e(current.shortNote || '')}</textarea></label><div class="rm-history rm-full"><strong>Histórico atual</strong><pre>${e(historyText(row, h))}</pre></div><label class="rm-full">Adicionar observação<textarea name="note" maxlength="2000" rows="4" placeholder="Adicione uma nova informação ao histórico"></textarea><small>O novo texto será acrescentado sem apagar as observações anteriores.</small></label></div>`;
}
function bulkEditMarkup(statuses, rows) {
  return `<div class="rm-form-grid"><label class="rm-full">Alterar status (opcional)<select name="status">${statusOptions(statuses, null, { bulk: true })}</select></label><label class="rm-full">Anotação curta (opcional)<textarea name="shortNote" maxlength="500" rows="3" placeholder="Ex.: conferido com o relatório"></textarea><small>Se preenchida, substitui a anotação curta atual da seleção.</small></label><label class="rm-full">Adicionar descrição / observação (opcional)<textarea name="note" maxlength="2000" rows="4" placeholder="Descreva a ação tomada ou o que precisa ser acompanhado"></textarea><small>O texto será acrescentado ao histórico existente, sem apagar observações anteriores.</small></label><p class="rm-notice rm-full">As alterações serão aplicadas aos ${count(rows.length)} pedidos selecionados. A edição não finaliza nem remove reembolsos da fila.</p></div>`;
}
function finalizeMarkup(statuses, rows, h) {
  const pending = rows.filter(hasNewPayment), withoutPending = rows.filter(row => !hasNewPayment(row)), variance = rows.filter(hasPaymentVariance);
  return `${rows.some(financialExcluded) ? '<div class="rm-alert"><strong>Há pedido com pagamento pendente na seleção</strong><p>Os valores permanecem fora dos indicadores até a confirmação do pagamento. Finalizar aqui registra somente sua decisão no acompanhamento local.</p></div>' : ''}${pending.length ? `<div class="rm-alert rm-alert-good"><strong>Novo pagamento da Amazon detectado em ${count(pending.length)} ${pending.length === 1 ? 'pedido' : 'pedidos'}</strong><p>Ao finalizar, esses créditos serão marcados como conferidos no acompanhamento local. Isso não confirma depósito bancário.</p></div>` : ''}${variance.length ? `<div class="rm-alert rm-alert-warning"><strong>Diferença importante em ${count(variance.length)} ${variance.length === 1 ? 'pedido' : 'pedidos'}</strong>${variance.slice(0, 8).map(row => `<p>${e(row.orderId)} · Débito: ${amounts(row.refund?.byCurrency, h)} · Crédito: ${amounts(row.payment?.byCurrency, h)}</p>`).join('')}<label class="rm-confirm-check"><input type="checkbox" name="acknowledgePaymentVariance">Estou ciente das diferenças de valor e desejo continuar.</label></div>` : ''}<div class="rm-form-grid"><label class="rm-full">Status ao finalizar<select name="status" required>${statusOptions(statuses, null, { finalize: true })}</select><small>Você pode manter o status atual, inclusive SAFE-T CONCEDIDO.</small></label><label class="rm-full">Adicionar anotação (opcional)<input name="shortNote" maxlength="500" placeholder="Ex.: pagamento conferido no extrato"></label><label class="rm-full">Adicionar observação (opcional)<textarea name="note" maxlength="2000" rows="4" placeholder="Registre os detalhes da decisão ou da devolução"></textarea><small>O texto será acrescentado ao histórico, preservando as observações anteriores.</small></label>${withoutPending.length ? `<label class="rm-full">Motivo operacional ${withoutPending.length === 1 ? 'do pedido' : `dos ${count(withoutPending.length)} pedidos`} sem pagamento novo<select name="unpaidReason" required><option value="">Escolha o motivo</option>${reasonOptions.map(([code, label]) => `<option value="${code}">${label}</option>`).join('')}</select></label>` : ''}</div>`;
}
function createDialog(title, subtitle) {
  const dialog = document.createElement('dialog'); dialog.className = 'rm-dialog'; dialog.setAttribute('aria-labelledby', 'rm-dialog-title');
  dialog.innerHTML = `<div class="rm-dialog-heading"><div><h2 id="rm-dialog-title">${e(title)}</h2><p>${e(subtitle)}</p></div><button type="button" class="icon-button" data-rm-dialog-close aria-label="Fechar">×</button></div><div class="rm-dialog-body"><div class="rm-dialog-message" role="status" aria-live="polite"></div><div data-rm-dialog-content><p class="rm-notice">Carregando acompanhamento…</p></div></div>`;
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  document.body.append(dialog); dialog.showModal(); return dialog;
}
function bindDialogDismiss(dialog, canClose = () => true) {
  const close = () => { if (canClose()) dialog.close(); };
  q(dialog, '[data-rm-dialog-close]').addEventListener('click', close);
  dialog.addEventListener('cancel', event => { if (!canClose()) event.preventDefault(); });
  const outside = event => {
    const bounds = dialog.getBoundingClientRect();
    return event.target === dialog && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom);
  };
  let backdropPress = false;
  dialog.addEventListener('pointerdown', event => { backdropPress = outside(event); });
  dialog.addEventListener('pointercancel', () => { backdropPress = false; });
  dialog.addEventListener('click', event => { if (backdropPress && outside(event)) close(); backdropPress = false; });
  return close;
}
async function openOperationalDialog(row, context) {
  const { helpers: h } = context;
  const dialog = createDialog('Informações operacionais', `${h.storeName(row.storeId)} · pedido ${row.orderId}`);
  dialog.classList.add('rm-operational-dialog');
  const close = bindDialogDismiss(dialog), content = q(dialog, '[data-rm-dialog-content]');
  content.innerHTML = '<p class="rm-notice" role="status">Carregando informações do pedido…</p>';
  try {
    // Order status is imported evidence. This entry point contains no review
    // editor, save controls or mutation requests, including clicks on cell space.
    const order = row.order ? await context.api(`/api/orders/${encodeURIComponent(row.orderId)}?${new URLSearchParams({storeId:row.storeId})}`)
      : {storeId:row.storeId,orderId:row.orderId,displayStatus:row.displayStatus,fulfillmentMode:row.fulfillmentMode};
    if (!dialog.open) return;
    if (order.storeId !== row.storeId || order.orderId !== row.orderId) throw new Error('INVALID_DETAIL');
    const status=order.displayStatus || row.displayStatus;
    const origin=({order:'Situação do pedido informada pela Amazon',tracking:'Rastreio dos pacotes informado pela Amazon'})[status?.source];
    content.innerHTML = `${h.returnedOrderMetadata(order)}${origin?`<p class="detail-info">${e(origin)}</p>`:''}${status?.description?`<p class="detail-info">${e(status.description)}</p>`:''}<section class="detail-section order-tracking"><h3>Rastreamento</h3>${row.order?h.orderTrackingMarkup(order):'<p class="detail-info">Os dados operacionais completos deste pedido ainda não foram importados.</p>'}</section><div class="rm-dialog-actions"><button type="button" class="button primary" data-rm-operational-close>Fechar</button></div>`;
    q(dialog,'[data-rm-operational-close]').addEventListener('click',close);
  } catch {
    if (dialog.open) content.innerHTML='<p class="rm-alert rm-alert-warning">Não foi possível carregar as informações operacionais. Feche e tente novamente.</p>';
  }
}
async function openNotesDialog(row, kind, context) {
  const { helpers: h } = context;
  const dialog = createDialog(kind === 'observation' ? 'Observações do pedido' : 'Anotação do pedido', `${h.storeName(row.storeId)} · pedido ${row.orderId}`);
  dialog.classList.add('rm-reading-dialog');
  const close = bindDialogDismiss(dialog);
  q(dialog, '[data-rm-dialog-content]').innerHTML = '<p class="rm-notice">Carregando texto completo…</p>';
  try {
    const detail = await context.api(`${API}/${encodeURIComponent(row.managementId)}?${new URLSearchParams({ storeId: row.storeId })}`);
    if (!dialog.open) return;
    if (detail.managementId !== row.managementId || detail.storeId !== row.storeId || detail.orderId !== row.orderId) throw new Error('INVALID_DETAIL');
    q(dialog, '[data-rm-dialog-content]').innerHTML = `${refundNotesMarkup(detail, h, kind)}<div class="rm-dialog-actions"><button type="button" class="button" data-rm-reading-edit>Editar acompanhamento</button><button type="button" class="button primary" data-rm-reading-close>Fechar</button></div>`;
    q(dialog, '[data-rm-reading-close]').addEventListener('click', close);
    q(dialog, '[data-rm-reading-edit]').addEventListener('click', () => { close(); openEditDialog('edit', [detail], context); });
  } catch {
    if (dialog.open) q(dialog, '[data-rm-dialog-content]').innerHTML = '<div class="rm-alert rm-alert-warning">Não foi possível carregar o texto completo. Feche e tente novamente.</div>';
  }
}
function mutationItems(rows) { return rows.map(row => ({ storeId: row.storeId, managementId: row.managementId, expectedVersion: row.management.version })); }
function safeMutationError(error) {
  if (/CONFLICT/.test(error?.code || '') || error?.status === 409) return 'O acompanhamento mudou em outra sessão ou houve novo crédito. Sua edição foi mantida. Recarregue os dados antes de salvar novamente; nenhuma alteração desta tentativa foi aplicada.';
  return 'Não foi possível salvar. Sua edição foi mantida. Confira os campos e tente novamente. Se os dados mudaram em outra sessão, recarregue antes de editar.';
}
async function mountOrderCaseEditor(container, selected, context, lifecycle) {
  const section = document.createElement('section');
  section.className = 'detail-section rm-order-case';
  section.setAttribute('aria-label', 'Caso na Amazon');
  container.prepend(section);
  const current = () => lifecycle.isCurrent() && section.isConnected;
  const load = async () => {
    section.innerHTML = '<p class="detail-info" role="status">Carregando ID do caso…</p>';
    try {
      const row = await context.api(`${API}/${encodeURIComponent(selected.managementId)}?${new URLSearchParams({ storeId: selected.storeId })}`);
      if (!current()) return;
      if (row.storeId !== selected.storeId || row.managementId !== selected.managementId || row.orderId !== selected.orderId) throw new Error('INVALID_DETAIL');
      const initial = row.management.caseId || '';
      section.innerHTML = `<form class="rm-order-case-form"><label>ID do caso<input name="caseId" value="${e(initial)}" maxlength="30" inputmode="numeric" pattern="[0-9]*" autocomplete="off" placeholder="Informe o número do caso"></label><button type="submit" class="button primary" disabled>Salvar ID do caso</button>${initial ? `<span class="rm-case-current">${caseLinkMarkup(row.management)}</span>` : ''}</form><div class="rm-case-message" role="status"></div>`;
      const form = q(section, 'form'), input = form.elements.namedItem('caseId'), save = q(form, '[type="submit"]'), message = q(section, '.rm-case-message');
      let saving = false, conflict = false;
      const update = () => { save.disabled = saving || conflict || input.value === initial; };
      input.addEventListener('input', () => { input.value = input.value.replace(/\D/g, '').slice(0, 30); update(); });
      form.addEventListener('submit', async event => {
        event.preventDefault();
        if (saving || conflict || input.value === initial || !form.reportValidity() || !current()) return;
        const body = { action: 'edit', items: mutationItems([row]), caseId: input.value };
        saving = true; input.disabled = true; save.disabled = true; save.textContent = 'Salvando…'; message.textContent = '';
        try {
          await context.api(API, { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': context.csrf }, body: JSON.stringify(body) });
        } catch (error) {
          if (!current()) return;
          saving = false; conflict = /CONFLICT/.test(error?.code || '') || error?.status === 409;
          input.disabled = false; save.textContent = 'Salvar ID do caso'; update();
          message.textContent = safeMutationError(error);
          if (conflict) {
            const reload = document.createElement('button'); reload.type = 'button'; reload.className = 'button'; reload.textContent = 'Recarregar ID salvo';
            reload.addEventListener('click', load); message.append(reload);
          }
          return;
        }
        lifecycle.close(); context.state.selection.clear();
        try { await (context.afterSave || context.reload)(); context.helpers.showMessage('ID do caso salvo.'); }
        catch { context.helpers.showMessage('ID do caso salvo. Recarregue os dados locais para atualizar a lista.', 'warning'); }
      });
    } catch {
      if (!current()) return;
      section.innerHTML = '<p class="detail-info">Não foi possível carregar o ID do caso.</p><button type="button" class="button">Tentar novamente</button>';
      q(section, 'button').addEventListener('click', load);
    }
  };
  await load();
}
async function openEditDialog(action, selected, context) {
  if (!selected.length || selected.length > 100) return;
  const { state, helpers: h } = context, individual = action === 'edit';
  const title = individual ? 'Atualizar reembolso' : action === 'finalize' ? selected.length === 1 ? 'Finalizar reembolso' : `Finalizar ${count(selected.length)} reembolsos em massa` : `Editar ${count(selected.length)} reembolsos em massa`;
  const subtitle = individual ? `${h.storeName(selected[0].storeId)} · pedido ${selected[0].orderId}` : action === 'finalize' ? 'A finalização move os pedidos para Finalizados. O status escolhido pode ser o mesmo que os pedidos já possuem.' : 'Preencha somente o que deseja aplicar aos pedidos selecionados. A edição não finaliza nenhum reembolso.';
  const dialog = createDialog(title, subtitle); let saving = false, conflict = false;
  const close = bindDialogDismiss(dialog, () => !saving);
  try {
    const params = refundManagementParams(state, context.storeId); params.set('limit', '1');
    const [fresh, detail] = await Promise.all([context.api(`${API}?${params}`), individual ? context.api(`${API}/${encodeURIComponent(selected[0].managementId)}?${new URLSearchParams({ storeId: selected[0].storeId })}`) : Promise.resolve(null)]);
    if (!dialog.open) return;
    if (individual && (detail.managementId !== selected[0].managementId || detail.storeId !== selected[0].storeId)) throw new Error('INVALID_DETAIL');
    const rows = individual ? [detail] : selected, statuses = (fresh.reviewStatuses || []).filter(item => !item.automatic);
    const submitLabel = individual ? 'Salvar alterações' : action === 'finalize' ? 'Confirmar finalização' : 'Aplicar à seleção';
    q(dialog, '[data-rm-dialog-content]').innerHTML = `<form data-rm-form>${individual ? editMarkup(detail, statuses, h) : action === 'finalize' ? finalizeMarkup(statuses, rows, h) : bulkEditMarkup(statuses, rows)}<div class="rm-dialog-actions"><button type="button" class="button" data-rm-cancel>Cancelar</button><button type="submit" class="button primary" data-rm-save disabled>${submitLabel}</button></div></form>`;
    const form = q(dialog, '[data-rm-form]'), save = q(form, '[data-rm-save]');
    if (individual) h.refundFormSteps(form);
    const control = name => form.elements.namedItem(name);
    const values = () => Object.fromEntries(new FormData(form));
    const initial = values();
    const validStatus = code => statuses.some(item => item.code === code && item.active !== false && !item.automatic);
    const hasChanges = () => {
      const value = values();
      if (action === 'finalize') return validStatus(value.status) && (!control('unpaidReason') || Boolean(value.unpaidReason)) && (!control('acknowledgePaymentVariance') || control('acknowledgePaymentVariance').checked);
      if (individual) return ['status', 'shortNote', 'caseId', 'safeTId', 'returnTracking'].some(name => value[name] !== initial[name]) || Boolean(value.note?.trim());
      return value.status !== '__keep__' || Boolean(value.shortNote?.trim() || value.note?.trim());
    };
    const update = () => { save.disabled = saving || conflict || !hasChanges(); };
    form.addEventListener('input', update); form.addEventListener('change', update);
    control('caseId')?.addEventListener('input', event => { event.target.value = event.target.value.replace(/\D/g, '').slice(0, 30); update(); });
    q(form, '[data-rm-cancel]').addEventListener('click', close);
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (saving || conflict || !hasChanges() || !form.reportValidity()) return;
      const value = values(), body = { action, items: mutationItems(rows) };
      if (individual) {
        if (value.status !== initial.status) body.status = value.status || null;
        for (const field of ['shortNote', 'caseId', 'safeTId', 'returnTracking']) if (value[field] !== initial[field]) body[field] = value[field];
        if (value.note?.trim()) body.note = value.note.trim();
      } else {
        if (action === 'finalize' || value.status !== '__keep__') body.status = value.status;
        if (value.shortNote?.trim()) body.shortNote = value.shortNote.trim();
        if (value.note?.trim()) body.note = value.note.trim();
        if (action === 'finalize') { body.acknowledgePaymentVariance = Boolean(control('acknowledgePaymentVariance')?.checked); if (value.unpaidReason) body.unpaidReason = value.unpaidReason; }
      }
      saving = true; save.textContent = 'Salvando…'; for (const element of form.elements) element.disabled = true;
      try {
        await context.api(API, { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': context.csrf }, body: JSON.stringify(body) });
        saving = false; state.selection.clear(); dialog.close();
        try {
          const pendingQueue = state.payment === 'pending';
          await (context.afterSave ? context.afterSave({ refundFinalized: action === 'finalize' }) : context.reload());
          h.showMessage(action === 'finalize' ? pendingQueue && state.payment === 'all' ? 'Pagamentos revisados. Os demais reembolsos estão visíveis novamente.' : 'Acompanhamento finalizado.' : 'Alterações salvas.');
        }
        catch { h.showMessage('Alterações salvas. Não foi possível atualizar a lista; recarregue os dados locais.', 'warning'); }
      } catch (error) {
        saving = false; conflict = /CONFLICT/.test(error?.code || '') || error?.status === 409;
        for (const element of form.elements) element.disabled = false;
        save.textContent = submitLabel; update();
        q(dialog, '.rm-dialog-message').innerHTML = `<div class="rm-alert rm-alert-warning">${e(safeMutationError(error))}${conflict ? '<p>Copie as anotações que deseja preservar antes de recarregar.</p><button type="button" class="button" data-rm-reload-conflict>Recarregar dados</button>' : ''}</div>`;
        q(dialog, '[data-rm-reload-conflict]')?.addEventListener('click', async () => { state.selection.clear(); dialog.close(); await context.reload(); });
      }
    });
    control('status')?.focus();
  } catch {
    if (dialog.open) q(dialog, '[data-rm-dialog-content]').innerHTML = '<div class="rm-alert rm-alert-warning">Não foi possível carregar o acompanhamento. Feche e tente novamente.</div>';
  }
}
async function reopenRows(rows, context, button) {
  if (!rows.length || rows.some(row => !isFinalized(row))) return;
  button.disabled = true;
  try {
    await context.api(API, { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': context.csrf }, body: JSON.stringify({ action: 'reopen', items: mutationItems(rows) }) });
    context.state.selection.clear();
    try { await (context.afterSave || context.reload)(); context.helpers.showMessage('Pedidos reabertos para acompanhamento.'); }
    catch { context.helpers.showMessage('Pedidos reabertos. Não foi possível atualizar a lista; recarregue os dados locais.', 'warning'); }
  } catch (error) { context.helpers.showMessage(safeMutationError(error), 'warning'); if (button.isConnected) button.disabled = false; }
}
export function bindRefundManagement(root, context) {
  const { state, helpers: h } = context;
  h.prepareTables(root);
  state._cleanup?.();
  const controller = new AbortController(), generation = ++state._generation;
  let searchTimer;
  const on = (selector, type, handler) => root.querySelectorAll(selector).forEach(element => element.addEventListener(type, event => handler(event, element), { signal: controller.signal }));
  const active = () => state._generation === generation && root.isConnected;
  const redraw = (data = state.data, focus) => {
    if (!active()) return;
    const scroll = q(root, '.rm-table-scroll'), top = scroll?.scrollTop || 0, left = scroll?.scrollLeft || 0;
    root.innerHTML = renderRefundManagement(data, state, h); bindRefundManagement(root, { ...context, data });
    const nextScroll = q(root, '.rm-table-scroll'); if (nextScroll) { nextScroll.scrollTop = top; nextScroll.scrollLeft = left; }
    if (focus) q(root, focus)?.focus({ preventScroll: true });
  };
  const apply = () => { clearTimeout(searchTimer); state.selection.clear(); context.reload(); };
  const rowFor = value => state.data?.items?.find(row => key(row) === value) || state.selection.get(value);
  const showLimit = () => h.showMessage('Selecione até 100 pedidos por vez para gerenciar em massa.', 'warning');
  const orderStatusControl = q(root, '.rm-order-status-filter'), orderStatusMenu = q(root, '[id="rm-order-status-menu"]'), orderStatusTrigger = q(root, '[data-rm-order-status-trigger]');
  let orderStatusDraft = selectedOrderStatuses(state);
  const syncOrderStatusDraft = () => {
    orderStatusControl?.querySelectorAll('[data-rm-order-status-option]').forEach(input => {
      const code = input.dataset.rmOrderStatusOption;
      input.checked = code === 'all' ? !orderStatusDraft.size : orderStatusDraft.has(code);
      input.disabled = code !== 'all' && !input.checked && orderStatusDraft.size >= 50;
    });
  };
  const closeOrderStatus = (restoreFocus = false) => {
    if (!orderStatusMenu || orderStatusMenu.hidden) return;
    orderStatusMenu.hidden = true; orderStatusTrigger.setAttribute('aria-expanded', 'false');
    orderStatusDraft = selectedOrderStatuses(state); syncOrderStatusDraft();
    if (restoreFocus) orderStatusTrigger.focus({ preventScroll: true });
  };
  const openOrderStatus = () => {
    orderStatusDraft = selectedOrderStatuses(state); syncOrderStatusDraft();
    orderStatusMenu.hidden = false; orderStatusTrigger.setAttribute('aria-expanded', 'true');
    q(orderStatusMenu, 'input:checked')?.focus({ preventScroll: true });
  };
  on('[data-rm-order-status-trigger]', 'click', () => { if (orderStatusMenu.hidden) openOrderStatus(); else closeOrderStatus(true); });
  on('[data-rm-order-status-trigger]', 'keydown', event => { if (event.key === 'ArrowDown') { event.preventDefault(); openOrderStatus(); } });
  on('[data-rm-order-status-option]', 'change', (_event, input) => {
    const code = input.dataset.rmOrderStatusOption;
    if (code === 'all') orderStatusDraft.clear();
    else if (input.checked) orderStatusDraft.add(code);
    else orderStatusDraft.delete(code);
    syncOrderStatusDraft();
  });
  on('[data-rm-order-status-cancel]', 'click', () => closeOrderStatus(true));
  on('[data-rm-order-status-apply]', 'click', () => {
    state.orderStatus = [...orderStatusDraft].join(',') || 'all';
    closeOrderStatus(true); state._restoreControl = '[data-rm-order-status-trigger]'; apply();
  });
  on('.rm-order-status-filter', 'keydown', event => { if (event.key === 'Escape' && !orderStatusMenu.hidden) { event.preventDefault(); event.stopPropagation(); closeOrderStatus(true); } });
  on('.rm-order-status-filter', 'focusout', event => { if (event.relatedTarget && !orderStatusControl.contains(event.relatedTarget)) closeOrderStatus(); });
  document.addEventListener('pointerdown', event => { if (!orderStatusControl?.contains(event.target)) closeOrderStatus(); }, { signal: controller.signal });
  h.applyReviewColors(root);
  const selectVisible = q(root, '[data-rm-select-visible]');
  if (selectVisible) { const visible = state.data?.items || []; selectVisible.indeterminate = visible.some(row => state.selection.has(key(row))) && !visible.every(row => state.selection.has(key(row))); }
  on('[data-rm-workflow]', 'click', (_event, button) => { state.workflow = button.dataset.rmWorkflow; apply(); });
  on('[data-rm-workflow]', 'keydown', (event, button) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); const tabs = [...root.querySelectorAll('[data-rm-workflow]')], index = tabs.indexOf(button);
    tabs[event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length].focus();
  });
  on('[data-rm-toggle-cards]', 'click', () => { state.cardsExpanded = !state.cardsExpanded; redraw(state.data, '[data-rm-toggle-cards]'); });
  on('[data-rm-refresh]', 'click', async (_event, button) => { button.disabled = true; try { await (context.refreshSource || context.reload)(); } finally { if (button.isConnected) button.disabled = false; } });
  on('[data-rm-card]', 'click', (_event, button) => { const code = button.dataset.rmCard, wasActive = code === 'pending' ? state.payment === 'pending' : code === 'overdue' ? state.deadline === 'overdue' && state.payment === 'unpaid' : false; resetFilters(state); state.workflow = 'active'; if (!wasActive && code === 'pending') state.payment = 'pending'; if (!wasActive && code === 'overdue') { state.deadline = 'overdue'; state.payment = 'unpaid'; state.sort = 'safeTDate'; state.direction = 'desc'; } apply(); });
  on('[data-rm-search]', 'input', (_event, input) => { state.query = input.value; state.selection.clear(); clearTimeout(searchTimer); searchTimer = setTimeout(() => { state._restoreSearch = { start: input.selectionStart, end: input.selectionEnd }; apply(); }, 300); });
  on('[data-rm-filter]', 'change', (_event, select) => { state[select.dataset.rmFilter] = select.value; if (select.dataset.rmFilter === 'status') state.statusLabel = select.selectedOptions[0]?.textContent; if (select.dataset.rmFilter === 'payment' && select.value === 'pending') state.workflow = 'active'; if (select.dataset.rmFilter === 'payment' && select.value === 'paid' && state.workflow === 'active') state.workflow = 'all'; if (select.dataset.rmFilter === 'deadline' && select.value !== 'all') { state.sort = 'safeTDate'; state.direction = select.value === 'upcoming' ? 'asc' : 'desc'; } apply(); });
  on('[data-rm-clear-filters]', 'click', () => { resetFilters(state); apply(); });
  on('[data-rm-sort]', 'click', (_event, button) => { clearTimeout(searchTimer); const sort = button.dataset.rmSort; state.direction = state.sort === sort && state.direction === 'asc' ? 'desc' : 'asc'; state.sort = sort; state._restoreControl = `[data-rm-sort="${sort}"]`; context.reload(); });
  on('[data-rm-column]', 'change', (_event, input) => { const next = new Set(state.visibleColumns); if (input.checked) next.add(input.dataset.rmColumn); else next.delete(input.dataset.rmColumn); if (!next.size) { input.checked = true; return; } state.visibleColumns = columns.map(([id]) => id).filter(id => next.has(id)); try { localStorage.setItem(COLUMN_KEY, JSON.stringify(state.visibleColumns)); } catch {} redraw(); q(root, '.rm-columns').open = true; q(root, `[data-rm-column="${input.dataset.rmColumn}"]`)?.focus(); });
  on('[data-rm-select]', 'change', (_event, input) => { const row = rowFor(input.dataset.rmSelect); if (!row) return; if (input.checked) { if (state.selection.size >= 100) { input.checked = false; showLimit(); return; } state.selection.set(key(row), row); } else state.selection.delete(key(row)); redraw(); });
  on('[data-rm-select-visible]', 'change', (_event, input) => { const rows = state.data?.items || []; if (input.checked) { for (const row of rows) { if (state.selection.size >= 100) break; state.selection.set(key(row), row); } if (rows.length > 100) showLimit(); } else for (const row of rows) state.selection.delete(key(row)); redraw(); });
  on('[data-rm-clear-selection]', 'click', () => { state.selection.clear(); redraw(); });
  on('[data-copy-order]', 'click', (_event, button) => h.copyOrderNumber(button));
  on('[data-rm-order]', 'click', (_event, button) => {
    const row = rowFor(button.dataset.rmOrder);
    if (row) h.openOrder(row.storeId, row.orderId, { mountCaseEditor: (container, lifecycle) => mountOrderCaseEditor(container, row, context, lifecycle) });
  });
  on('[data-rm-operational]', 'click', (_event, button) => { const row=rowFor(button.dataset.rmOperational); if(row) openOperationalDialog(row,context); });
  root.querySelectorAll('.rm-table tbody tr').forEach((element, index) => {
    const row = state.data?.items?.[index];
    element.addEventListener('click', event => {
      if (!row || event.defaultPrevented || event.target.closest('a, button, input, select, textarea, label, summary, [role="button"], [contenteditable]')) return;
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed && element.contains(selection.anchorNode)) return;
      if (event.target.closest('[data-rm-operational-cell]')) { openOperationalDialog(row,context); return; }
      const noteCell = event.target.closest('[data-rm-note-cell]');
      if (noteCell) { openNotesDialog(row, noteCell.dataset.rmNoteCell, context); return; }
      openEditDialog('edit', [row], context);
    }, { signal: controller.signal });
  });
  on('[data-rm-related-return]', 'click', (_event, button) => {
    const row = rowFor(button.dataset.rmRelatedKey);
    if (!row) return;
    if (button.dataset.rmRelatedReturn === 'customer-returns') {
      h.openCustomerReturnGroup(row.storeId, row.orderId, row.returnLinks?.customerReturns || []);
    } else if (button.dataset.rmRelatedReturn === 'returns') {
      h.openReturnedToSeller(row.storeId, row.orderId);
    }
  });
  on('[data-rm-edit]', 'click', (_event, button) => { const row = rowFor(button.dataset.rmEdit); if (row) openEditDialog('edit', [row], context); });
  on('[data-rm-read]', 'click', (_event, button) => { const row = rowFor(button.dataset.rmRead); if (row) openNotesDialog(row, button.dataset.rmNoteKind, context); });
  on('[data-rm-bulk-edit]', 'click', () => { const rows = selectedRows(state); openEditDialog(rows.length === 1 ? 'edit' : 'bulk-edit', rows, context); });
  on('[data-rm-bulk-finalize]', 'click', () => openEditDialog('finalize', selectedRows(state), context));
  on('[data-rm-bulk-reopen]', 'click', (_event, button) => reopenRows(selectedRows(state), context, button));
  if (state._restoreSearch) { const input = q(root, '[data-rm-search]'); input?.focus({ preventScroll: true }); try { input?.setSelectionRange(state._restoreSearch.start, state._restoreSearch.end); } catch {} state._restoreSearch = null; }
  if (state._restoreControl) { q(root, state._restoreControl)?.focus({ preventScroll: true }); state._restoreControl = null; }
  state._cleanup = () => { controller.abort(); clearTimeout(searchTimer); state._generation++; };
  return () => state._cleanup?.();
}

