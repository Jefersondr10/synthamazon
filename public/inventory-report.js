import { isMultipleStores } from './store-selection.js';
import { stockPlan } from './inventory-planning.js';
import { inventoryQuantities } from './inventory-quantities.js';

const decimal = new Intl.NumberFormat('pt-BR', { useGrouping: false, maximumFractionDigits: 4 });
const timestamp = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' });
const day = value => /^\d{4}-\d{2}-\d{2}$/.test(value || '') ? value.split('-').reverse().join('/') : '';
const instant = value => value && Number.isFinite(Date.parse(value)) ? timestamp.format(new Date(value)) : '';
const quantity = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const costAmount = value => typeof value === 'string' && /^\d+$/.test(value) ? `${BigInt(value) / 100n},${(BigInt(value) % 100n).toString().padStart(2, '0')}` : '';
const collectionLabels = { complete: 'Completa', partial: 'Parcial: inclui a última posição conhecida', stale: 'Última consulta falhou: posição anterior', missing: 'Sem consulta', incomplete: 'Consulta incompleta' };

// Quote every field and neutralize spreadsheet formulas from seller-supplied text.
export function csvCell(value) {
  if (value === null || value === undefined) return '""';
  let text = typeof value === 'number' ? (Number.isFinite(value) ? decimal.format(value) : '') : String(value);
  if (typeof value !== 'number' && /^[\s\u0000-\u001f]*[=+@-]/u.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function createInventoryReport(items, { preferences, stores = [], storeId = 'all', collectionState, generatedAt = new Date().toISOString() }) {
  const names = new Map(stores.map(store => [store.storeId, store.name || store.displayName || store.storeId]));
  const headers = ['Loja', 'Produto', 'SKU', 'ASIN', 'FNSKU', 'Condição', 'Disponível', 'Reservado', 'Reservado para pedidos', 'Transferência entre centros Amazon', 'Processamento Amazon', 'Em entrada', 'Entrada em preparação', 'Entrada enviada', 'Entrada em recebimento', 'Indisponível', 'Em investigação', 'Total Amazon',
    'Total Amazon apto', `Vendas em ${preferences.period} dias (unidades)`, 'Média de vendas por dia', 'Duração prevista (dias)', 'Situação do estoque', 'Observação da previsão', 'Vendas de', 'Vendas até',
    'Prazo de reposição (dias)', 'Margem de segurança (dias)', 'Estoque observado em (Brasília)', 'Última alteração (Brasília)', 'Situação da coleta', 'Relatório gerado em (Brasília)',
    'Custo médio unitário (BRL)', 'Valor do estoque apto (BRL)', 'Produto no Estoque Origem', 'Custos consultados em (Brasília)', 'Situação do custo'];
  const rows = items.map(item => {
    const details = item.inventoryDetails || {}, plan = stockPlan(item, preferences), forecast = plan.forecast;
    const incoming = [details.inboundWorkingQuantity, details.inboundShippedQuantity, details.inboundReceivingQuantity];
    return [names.get(item.storeId) || item.storeId, item.title || '', item.sellerSku || '', item.asin || '', item.fnSku || '', item.condition || '',
      quantity(details.fulfillableQuantity), quantity(details.reservedQuantity?.totalReservedQuantity), quantity(details.reservedQuantity?.pendingCustomerOrderQuantity), quantity(details.reservedQuantity?.pendingTransshipmentQuantity), quantity(details.reservedQuantity?.fcProcessingQuantity),
      incoming.every(value => quantity(value) !== null) ? incoming.reduce((a, b) => a + b, 0) : null, ...incoming.map(quantity),
      quantity(details.unfulfillableQuantity?.totalUnfulfillableQuantity), quantity(details.researchingQuantity?.totalResearchingQuantity), quantity(item.totalQuantity),
      inventoryQuantities(item).usableQuantity, forecast?.units, forecast?.averageDailyUnits, forecast?.daysRemaining, plan.label, plan.explanation, day(forecast?.from), day(forecast?.to),
      preferences.leadDays, preferences.bufferDays, instant(item.observedAt), instant(item.updatedAt), collectionLabels[collectionState] || 'Não informada', instant(generatedAt),
      costAmount(item.cost?.unitCostCents), costAmount(item.cost?.totalCents), item.cost?.productName || '', instant(item.cost?.observedAt),
      item.cost?.totalCents == null ? 'Custo pendente' : item.cost.stale ? 'Atualização pendente' : 'Custo médio atual'];
  });
  const stamp = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(generatedAt));
  const scope = storeId === 'all' ? 'todas-as-lojas' : isMultipleStores(storeId) ? 'lojas-selecionadas' : String(storeId).replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 64);
  return { filename: `estoque-fba-${scope}-${stamp}.csv`, count: rows.length, csv: '\uFEFF' + [headers, ...rows].map(row => row.map(csvCell).join(';')).join('\r\n') + '\r\n' };
}
