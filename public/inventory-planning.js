import { matchesStoreSelection } from './store-selection.js';
import { inventoryQuantities } from './inventory-quantities.js';
export { inventoryQuantities };
const e = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch]));
const KEY = 'synthamazon-inventory-planning-v1';
const number = value => Number.isFinite(value) ? new Intl.NumberFormat('pt-BR').format(value) : '—';
const svg = content => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${content}</svg>`;
const settingsIcon = svg('<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3" fill="var(--surface)"/><circle cx="15" cy="17" r="3" fill="var(--surface)"/>');
const pauseIcon = svg('<rect x="3" y="3" width="18" height="18" rx="5"/><path d="M9 8v8M15 8v8"/>');
const arrowIcon = svg('<path d="M5 12h14m-5-5 5 5-5 5"/>');
export const STOCK_COVERAGE = Object.freeze({ idealDays:35, goodDays:60 });
export function inventoryPlanningPreferences() {
  let saved = {}; try { saved = JSON.parse(localStorage.getItem(KEY)) || {}; } catch {}
  return { period: [30,60,90].includes(saved.period) ? saved.period : 30,
    leadDays: Number.isInteger(saved.leadDays) && saved.leadDays >= 1 && saved.leadDays <= 90 ? saved.leadDays : 7,
    bufferDays: Number.isInteger(saved.bufferDays) && saved.bufferDays >= 0 && saved.bufferDays <= 90 ? saved.bufferDays : 8,
    alert: 'all' };
}
export function saveInventoryPlanningPreferences(value) { try { localStorage.setItem(KEY, JSON.stringify(value)); } catch {} }
const labels = { all:'Todos', restock:'Repor estoque', out:'Sem disponível', urgent:'Reposição urgente', replenish:'Agendar reposição', covered:'Estoque ideal', good:'Estoque bom', excess:'Excesso de estoque', no_sales:'Sem vendas', unknown:'Dados pendentes' };
const reasons = { 'missing-sku':'SKU não informado', 'ambiguous-sku':'Há mais de uma posição para este SKU', 'incomplete-history':'Importação do período incompleta', 'stale-history':'Histórico de vendas desatualizado', 'incomplete-sales':'Pedido com data, status ou quantidade incompletos', 'unknown-stock':'Quantidade disponível não informada', 'stale-stock':'Estoque sem atualização há mais de 2 dias' };
const decimals = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 });
export function stockPlan(item, preferences) {
  const forecast = item.salesForecast?.[preferences.period];
  const threshold = preferences.leadDays + preferences.bufferDays;
  if (!forecast) return { forecast, status:'unknown', label:labels.unknown, noSales:false, explanation:'Previsão ainda não carregada' };
  // The idle-stock alert requires stock that can actually be sold now.
  const noSales = !forecast.reason && forecast.stockFresh && forecast.availableQuantity > 0
    && forecast.historyComplete && forecast.historyLagDays <= 7 && forecast.units === 0;
  const status = forecast.availableQuantity === 0 && forecast.stockFresh ? 'out' : forecast.reason ? 'unknown'
    : forecast.daysRemaining === null ? 'no_sales' : forecast.daysRemaining > STOCK_COVERAGE.goodDays ? 'excess'
    : forecast.daysRemaining <= preferences.leadDays ? 'urgent' : forecast.daysRemaining <= threshold ? 'replenish'
    : forecast.daysRemaining <= STOCK_COVERAGE.idealDays ? 'covered' : 'good';
  return { forecast, status, noSales, label: status === 'no_sales' ? `Sem vendas · ${preferences.period} dias` : labels[status], explanation:reasons[forecast.reason] || '' };
}
export function matchesInventoryAlert(item, preferences, filter = preferences.alert) {
  const plan = stockPlan(item, preferences);
  return filter === 'all' || (filter === 'no_sales' ? plan.noSales : filter === 'restock' ? ['urgent','replenish'].includes(plan.status) : plan.status === filter);
}
export function selectInventoryItems(items, { query = '', stock = 'all', storeId = 'all', durationSort } = {}, preferences) {
  const search = query.toLocaleLowerCase('pt-BR');
  return sortInventoryItems(items.filter(item => matchesStoreSelection(storeId, item.storeId)
    && (!search || [item.sellerSku, item.asin, item.fnSku, item.title].some(value => String(value || '').toLocaleLowerCase('pt-BR').includes(search)))
    && (stock === 'all' || stock === 'available' && item.inventoryDetails?.fulfillableQuantity > 0 || stock === 'zero' && item.inventoryDetails?.fulfillableQuantity === 0 || stock === 'unfulfillable' && item.inventoryDetails?.unfulfillableQuantity?.totalUnfulfillableQuantity > 0)
    && matchesInventoryAlert(item, preferences)), preferences, durationSort);
}
export function sortInventoryItems(items, preferences, direction) {
  if (!['asc','desc'].includes(direction)) return items;
  return [...items].sort((a,b) => {
    const left = a.salesForecast?.[preferences.period]?.daysRemaining, right = b.salesForecast?.[preferences.period]?.daysRemaining;
    const hasLeft = Number.isFinite(left), hasRight = Number.isFinite(right);
    if (hasLeft !== hasRight) return hasLeft ? -1 : 1;
    return (hasLeft ? (left-right)*(direction==='asc'?1:-1) : 0) || String(a.sellerSku).localeCompare(String(b.sellerSku),'pt-BR') || String(a.storeId).localeCompare(String(b.storeId));
  });
}
export function durationSortControl(direction, mobile = false) {
  return `<button type="button" class="inventory-duration-sort ${mobile?'inventory-mobile-sort':''}" data-inventory-duration-sort="${mobile?'mobile':'header'}" aria-label="Ordenar duração prevista: ${direction==='asc'?'maior primeiro':'menor primeiro'}">Duração prevista<span aria-hidden="true">${direction==='asc'?'↑':direction==='desc'?'↓':'↕'}</span></button>`;
}
export function inventoryOverview(summary) {
  const positions = [['usableQuantity','Total Amazon apto','Disponível, entrada e movimentação interna'],['fulfillableQuantity','Disponíveis para venda','Prontas para atender novos pedidos'],['inboundQuantity','Em entrada','Preparação, transporte e recebimento'],['internalMovementQuantity','Movimentação interna','Transferência e processamento Amazon']];
  return `<section class="inventory-overview" aria-label="Resumo do estoque FBA">${positions.map(([key,label,description],i) => `<div class="inventory-position ${i===0?'primary':''}"><span class="inventory-position-label"><i aria-hidden="true"></i>${label}</span><div><strong>${number(summary[key])}</strong><span>unidades</span></div><small>${description}</small></div>`).join('')}</section>`;
}
function settingsDialog(preferences) {
  const field = (key,title,description,min) => `<div class="inventory-rule"><div><label for="inventory-${key}">${title}</label><p>${description}</p></div><div class="inventory-stepper"><button type="button" data-plan-step="${key}" data-delta="-1" aria-label="Diminuir ${title.toLowerCase()}">−</button><input id="inventory-${key}" name="${key}" type="number" min="${min}" max="90" step="1" required value="${preferences[key]}" aria-label="${title} em dias"><span>dias</span><button type="button" data-plan-step="${key}" data-delta="1" aria-label="Aumentar ${title.toLowerCase()}">+</button></div></div>`;
  return `<dialog id="inventory-plan-dialog" aria-labelledby="inventory-plan-title"><form id="inventory-plan-form"><header class="inventory-dialog-heading"><div><span class="inventory-eyebrow">PLANEJAMENTO FBA</span><h2 id="inventory-plan-title">Seu prazo de reposição</h2></div><button type="button" data-plan-cancel aria-label="Fechar configuração de reposição">×</button></header><div class="inventory-dialog-body">${field('leadDays','Agendamento até a venda','Inclua a espera pela coleta, o transporte e a liberação da Amazon.',1)}${field('bufferDays','Margem de segurança','Tempo extra para atrasos e variações nas vendas.',0)}<div class="inventory-buffer-presets" role="group" aria-label="Sugestões de margem de segurança">${[[3,'Curta'],[8,'Equilibrada'],[14,'Ampla']].map(([n,label]) => `<button type="button" data-plan-buffer="${n}" aria-pressed="${preferences.bufferDays===n}">${label}<span>${n} dias de margem</span></button>`).join('')}</div><div class="inventory-rule-preview" aria-live="polite"></div><p class="inventory-settings-note">Os prazos ficam salvos neste navegador e se aplicam às lojas selecionadas.</p></div><footer class="inventory-dialog-actions"><button type="button" class="inventory-text-button" data-plan-default>Restaurar 7 + 8 dias</button><div><button type="button" class="inventory-outline-button" data-plan-cancel>Cancelar</button><button type="submit" class="inventory-save-button">Salvar planejamento</button></div></footer></form></dialog>`;
}
export function planningControls(items, preferences) {
  const filters = ['all','restock','excess','no_sales','out','covered','good','unknown'];
  const counts = Object.fromEntries(filters.map(id => [id, items.filter(item => matchesInventoryAlert(item,preferences,id)).length]));
  const threshold = preferences.leadDays + preferences.bufferDays;
  return `<section class="inventory-planning" aria-label="Planejamento de reposição"><div class="inventory-planning-heading"><div><span class="inventory-eyebrow">REPOSIÇÃO E GIRO</span><h2>Saúde do estoque</h2></div><div class="inventory-planning-actions"><div class="inventory-period" role="group" aria-label="Período de análise das vendas"><span>Vendas em</span><div>${[30,60,90].map(n => `<button type="button" data-inventory-period="${n}" aria-pressed="${preferences.period===n}">${n} dias</button>`).join('')}</div></div><button id="inventory-plan-open" type="button" class="inventory-outline-button" aria-haspopup="dialog">${settingsIcon}Ajustar prazos</button></div></div><div class="inventory-coverage-policy" aria-label="Faixas de cobertura do estoque"><span><i class="inventory-dot covered" aria-hidden="true"></i>Ideal: <strong>${STOCK_COVERAGE.idealDays} dias</strong></span><span><i class="inventory-dot good" aria-hidden="true"></i>Bom: <strong>até ${STOCK_COVERAGE.goodDays} dias</strong></span><span><i class="inventory-dot excess" aria-hidden="true"></i>Excesso: <strong>acima de ${STOCK_COVERAGE.goodDays} dias</strong></span></div><div class="inventory-policy"><span><i class="inventory-dot replenish" aria-hidden="true"></i>Agendar com <strong>${threshold} dias</strong> de estoque</span><span><i class="inventory-dot urgent" aria-hidden="true"></i>Crítico com <strong>${preferences.leadDays} dias</strong></span><span class="inventory-policy-formula">${preferences.leadDays} dias de operação + ${preferences.bufferDays} de margem</span></div>${counts.no_sales ? `<div class="inventory-idle-notice">${pauseIcon}<div><strong>${number(counts.no_sales)} ${counts.no_sales===1?'produto em estoque sem vendas':'produtos em estoque sem vendas'} no período</strong><p>Disponíveis para venda · nenhuma venda nos ${preferences.period} dias analisados.</p></div><button type="button" data-inventory-alert="no_sales">Revisar produtos${arrowIcon}</button></div>` : ''}<div class="inventory-filter-tabs" role="group" aria-label="Filtrar alertas de estoque">${filters.map(id => `<button type="button" class="${id}" data-inventory-alert="${id}" aria-pressed="${preferences.alert===id}">${id==='no_sales'?pauseIcon:''}<span>${labels[id]}</span><b>${number(counts[id])}</b></button>`).join('')}</div></section>${settingsDialog(preferences)}`;
}
export function bindInventoryPlanning(root, preferences, onChange) {
  root.querySelectorAll('[data-inventory-period]').forEach(button => button.addEventListener('click', () => {
    preferences.period = Number(button.dataset.inventoryPeriod); saveInventoryPlanningPreferences(preferences);
    onChange(); root.querySelector(`[data-inventory-period="${preferences.period}"]`)?.focus({preventScroll:true});
  }));
  root.querySelectorAll('[data-inventory-alert]').forEach(button => button.addEventListener('click', () => {
    preferences.alert = button.dataset.inventoryAlert; onChange();
    root.querySelector(`.inventory-filter-tabs [data-inventory-alert="${preferences.alert}"]`)?.focus({preventScroll:true});
  }));
  const dialog = root.querySelector('#inventory-plan-dialog'), form = root.querySelector('#inventory-plan-form');
  if (!dialog || !form) return;
  const lead = form.elements.namedItem('leadDays'), buffer = form.elements.namedItem('bufferDays');
  const preview = () => {
    const valid = lead.validity.valid && buffer.validity.valid;
    form.querySelector('.inventory-rule-preview').innerHTML = valid ? `<div><span>Agendamento até a venda</span><strong>${Number(lead.value)}<small>dias</small></strong></div><b>+</b><div><span>Margem de segurança</span><strong>${Number(buffer.value)}<small>dias</small></strong></div><b>=</b><div class="result"><span>Alertar quando restarem</span><strong>${Number(lead.value)+Number(buffer.value)}<small>dias de estoque</small></strong></div>` : '<p>Informe dias inteiros nos limites indicados.</p>';
    form.querySelectorAll('[data-plan-buffer]').forEach(button => button.setAttribute('aria-pressed',String(Number(buffer.value)===Number(button.dataset.planBuffer))));
    form.querySelectorAll('[data-plan-step]').forEach(button => { const input = form.elements.namedItem(button.dataset.planStep); button.disabled = Number(button.dataset.delta)<0 ? Number(input.value)<=Number(input.min) : Number(input.value)>=Number(input.max); });
  };
  root.querySelector('#inventory-plan-open')?.addEventListener('click', () => { lead.value=preferences.leadDays; buffer.value=preferences.bufferDays; preview(); dialog.showModal(); });
  form.querySelectorAll('[data-plan-cancel]').forEach(button => button.addEventListener('click', () => dialog.close()));
  dialog.addEventListener('click', event => { const rect=dialog.getBoundingClientRect(); if(event.target===dialog && (event.clientX<rect.left || event.clientX>rect.right || event.clientY<rect.top || event.clientY>rect.bottom)) dialog.close(); });
  form.addEventListener('input', preview);
  form.querySelectorAll('[data-plan-step]').forEach(button => button.addEventListener('click', () => { const input = form.elements.namedItem(button.dataset.planStep); if (Number(button.dataset.delta)>0) input.stepUp(); else input.stepDown(); preview(); }));
  form.querySelectorAll('[data-plan-buffer]').forEach(button => button.addEventListener('click', () => { buffer.value=button.dataset.planBuffer; preview(); }));
  form.querySelector('[data-plan-default]').addEventListener('click', () => { lead.value=7; buffer.value=8; preview(); });
  form.addEventListener('submit', event => { event.preventDefault(); if(!form.reportValidity()) return;
    preferences.leadDays=Number(lead.value); preferences.bufferDays=Number(buffer.value); saveInventoryPlanningPreferences(preferences);
    dialog.close(); onChange(); root.querySelector('#inventory-plan-open')?.focus({preventScroll:true});
  });
}
export function planningCells(item, preferences, helpers) {
  const { forecast: f, status, noSales, label, explanation } = stockPlan(item, preferences);
  if (!f) return '<td>—</td><td>—</td><td>Sem previsão</td>';
  const today = helpers.localDay(new Date().toISOString());
  const daysToSchedule = f.daysRemaining === null ? null : Math.floor(f.daysRemaining - preferences.leadDays - preferences.bufferDays);
  const schedule = daysToSchedule === null || status==='excess' ? '' : daysToSchedule <= 0 ? 'Agendar agora' : daysToSchedule > 3650 ? 'Agendamento distante' : `Agendar até ${helpers.date(helpers.addDays(today, daysToSchedule))}`;
  const duration = f.daysRemaining === null ? '—' : f.daysRemaining < 1 ? 'Menos de 1 dia' : f.daysRemaining > 3650 ? 'Mais de 10 anos' : `${decimals.format(Math.ceil(f.daysRemaining*10)/10)} dias`;
  return `<td class="inventory-sales ${noSales?'idle':''}"><strong>${f.units === null ? '—' : helpers.number(f.units)} un.</strong><small>${f.averageDailyUnits === null ? 'Média indisponível' : `${decimals.format(f.averageDailyUnits)} un./dia`}</small><small>${helpers.date(f.from)} a ${helpers.date(f.to)}${!f.historyComplete ? ' · parcial' : ''}</small></td><td class="inventory-duration"><strong>${duration}</strong>${f.stockoutDay ? `<small>Até ${helpers.date(f.stockoutDay)}, estimado</small>` : ''}</td><td><span class="inventory-alert-badge ${status}">${e(label)}</span>${noSales && status!=='no_sales'?`<span class="inventory-alert-badge no_sales secondary">Sem vendas · ${preferences.period} dias</span>`:''}${schedule ? `<small class="inventory-schedule">${e(schedule)}</small>` : ''}${status==='excess'?`<small class="inventory-excess-action">Acima de ${STOCK_COVERAGE.goodDays} dias de estoque. Revisar giro antes de repor.</small>`:''}${status==='no_sales'?'<small class="inventory-idle-action">Revisar anúncio e demanda</small>':''}${explanation ? `<small>${e(explanation)}</small>` : ''}</td>`;
}
