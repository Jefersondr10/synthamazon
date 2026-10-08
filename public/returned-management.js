const e = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const identity = row => JSON.stringify([row.storeId, row.orderId]);
const finalized = row => row.review?.workflowState === 'finalized';
const tabs = { active: 'Em acompanhamento', finalized: 'Finalizados', all: 'Todos' };

function orderNumberMarkup(row, index, h) {
  return h.orderNumber(row);
}

export function reimbursementMarkup(row, h) {
  if (row.financialEligibility?.included === false) return '<span class="muted">Pagamento pendente</span>';
  const credit = row.reimbursement;
  if (!credit?.identified) return '<strong class="muted">Não identificado</strong><small>Nos dados importados</small>';
  return `${h.badge('Crédito recebido na Amazon', 'good')}${credit.byCurrency.map(value => `<strong class="returned-credit">${e(h.money(value.totalCents, value.currency))}</strong>`).join('')}<small>${e(credit.types.map(type => type.label).join(' · '))}</small>${credit.lastCreditAt ? `<small>${e(h.date(credit.lastCreditAt, true))}</small>` : ''}`;
}

export function renderReturnedManagement(data, state, h) {
  const rows = data.items || [], summary = data.summary || {}, counts = summary.workflowCounts || {};
  const showDetection = rows.some(row => Boolean(h.detection(row)));
  const activeCard = state.returnCard || 'all';
  const card = (code, label, value, caption, symbol) => `<button type="button" class="metric-card returned-filter-card" id="returned-card-${code}" data-return-card="${code}" aria-pressed="${activeCard === code}" aria-controls="returned-results"><span class="metric-top"><span class="metric-label">${e(label)}</span><span class="metric-icon">${h.icon(symbol)}</span></span><span class="metric-value">${h.number(value)}</span><span class="metric-caption">${e(caption)}</span></button>`;
  return `<div class="rm-workspace returned-workspace">
    <div class="rm-tabs" role="tablist" aria-label="Fila de devolvidos ao vendedor">${Object.entries(tabs).map(([code, label]) => `<button type="button" role="tab" data-return-workflow="${code}" id="returned-tab-${code}" aria-controls="returned-panel" aria-selected="${state.returnWorkflow === code}" tabindex="${state.returnWorkflow === code ? 0 : -1}">${label} (${h.number(counts[code] || 0)})</button>`).join('')}</div>
    <div role="tabpanel" id="returned-panel" aria-labelledby="returned-tab-${state.returnWorkflow}">
    <section class="metric-grid return-metrics" aria-label="Filtrar pelo resumo dos devolvidos ao vendedor">
      ${card('all', 'Pedidos nesta fila', summary.total, 'Mostrar todos os pedidos desta fila', 'refund')}
      ${card('refunded', 'Cliente reembolsado', summary.withRefund, 'Reembolso ao comprador registrado', 'money')}
      ${card('reimbursed', 'Com ressarcimento ao vendedor', summary.withReimbursement, 'Crédito SAFE-T ou Easy Ship identificado', 'money')}
      ${card('already_returned', 'Data da devolução a conferir', summary.alreadyReturned, 'Sem data identificada no rastreio', 'clock')}
    </section>
    <p class="footnote">Reembolso ao cliente é o valor devolvido ao comprador. Ressarcimento ao vendedor é o crédito identificado para sua loja na Amazon; não confirma depósito bancário nem cobertura integral.</p>
    <section class="rm-panel returned-panel"><div class="table-toolbar"><label class="search-box">${h.icon('search')}<span class="sr-only">Pesquisar pedido ou código de rastreio</span><input id="search" type="search" maxlength="200" placeholder="Pesquisar pedido ou rastreio" value="${e(state.query)}" autocomplete="off"></label><div class="table-filters"><label><span class="sr-only">Reembolso ao cliente</span><select id="return-status-filter" aria-label="Reembolso ao cliente"><option value="all">Todos os reembolsos ao cliente</option><option value="refunded" ${state.returnStatus === 'refunded' ? 'selected' : ''}>Cliente reembolsado</option><option value="without_refund" ${state.returnStatus === 'without_refund' ? 'selected' : ''}>Sem reembolso identificado</option></select></label>${h.reviewFilter(data, 'returns')}<span class="result-count">${h.number(data.total)} pedidos</span></div></div>
    <div class="table-scroll"><table class="returned-table"><colgroup><col class="returned-col-0"><col class="returned-col-1">${showDetection ? '<col class="returned-col-2">' : ''}<col class="returned-col-3"><col class="returned-col-4"><col class="returned-col-5"><col class="returned-col-6"><col class="returned-col-7"><col class="returned-col-8"></colgroup>
    <thead><tr><th><input type="checkbox" data-return-select-all aria-label="Selecionar os pedidos desta página, até 100"></th><th>Pedido / rastreio</th>${showDetection ? '<th>Detecção da devolução</th>' : ''}<th>Reembolso ao cliente</th><th>Ressarcimento ao vendedor</th><th>Alerta interno (5 dias)</th><th>Status da análise</th><th>Anotações</th><th>ID de caso</th></tr></thead><tbody>${rows.map((row, index) => `<tr data-order-card="${e(row.orderId)}" data-store="${e(row.storeId)}"><td><input type="checkbox" data-return-select="${index}" aria-label="Selecionar pedido ${e(row.orderId)}"></td><td>${orderNumberMarkup(row, index, h)}${h.tracking(row)}${state.storeId === 'all' ? `<small>${e(row.storeName)}</small>` : ''}</td>${showDetection ? `<td>${h.detection(row)}</td>` : ''}<td>${h.refund(row.refund, row)}</td><td>${reimbursementMarkup(row, h)}</td><td>${h.alert(row)}</td><td><button type="button" class="rm-status-button" data-return-edit="${index}" aria-label="Editar acompanhamento do pedido ${e(row.orderId)}" title="Editar acompanhamento">${h.reviewBadge(row.review, 'returns')}</button>${finalized(row) ? `<small>Finalizado${row.review.finalizedAt ? ` em ${e(h.date(row.review.finalizedAt))}` : ''}</small>` : ''}</td><td><span class="returned-note" title="${e(row.review?.notes)}">${e(row.review?.notes || '—')}</span></td><td>${row.review?.caseId ? `<a href="https://sellercentral.amazon.com.br/cu/case-dashboard/view-case?caseID=${encodeURIComponent(row.review.caseId)}" target="_blank" rel="noopener noreferrer">${e(row.review.caseId)}</a>` : '—'}</td></tr>`).join('')}</tbody></table></div>
    ${!rows.length ? h.empty('Nenhum pedido nesta fila', 'Confira as abas e os filtros selecionados.') : ''}
    <div data-return-selection class="rm-selection-bar" role="region" aria-label="Ações dos devolvidos selecionados" hidden></div>${h.pagination(data.total, rows.length)}</section>
    <details class="returned-monitor"><summary>Monitoramento e referência das datas</summary>${h.monitor(data.monitor)}<p class="footnote">${h.policy(data.policy)}</p></details>
    </div></div>`;
}

export function bindReturnedManagement(root, { data, state, reload, afterSave, api, csrf, helpers }) {
  const selected = new Map(), rows = data.items || [];
  const selectedRows = () => [...selected.values()];
  const bar = root.querySelector('[data-return-selection]'), all = root.querySelector('[data-return-select-all]');
  const inputs = [...root.querySelectorAll('[data-return-select]')];
  const syncCheckboxes = () => inputs.forEach(input => { input.checked = selected.has(identity(rows[Number(input.dataset.returnSelect)])); });
  const update = () => {
    const chosen = selectedRows();
    bar.hidden = !chosen.length;
    all.checked = rows.length > 0 && selected.size === rows.length;
    all.indeterminate = chosen.length > 0 && !all.checked;
    bar.innerHTML = chosen.length ? `<strong aria-live="polite">${chosen.length} ${chosen.length === 1 ? 'selecionado' : 'selecionados'}</strong><button class="button" type="button" data-return-clear>Limpar seleção</button><button class="button" type="button" data-return-action="edit">Editar selecionados</button>${chosen.every(row => !finalized(row)) ? '<button class="button primary" type="button" data-return-action="finalize">Finalizar selecionados</button>' : chosen.every(finalized) ? '<button class="button primary" type="button" data-return-action="reopen">Reabrir selecionados</button>' : '<small>A seleção mistura pedidos ativos e finalizados. A edição permanece disponível.</small>'}` : '';
  };
  inputs.forEach(input => input.addEventListener('change', () => {
    const row = rows[Number(input.dataset.returnSelect)];
    if (input.checked && selected.size < 100) selected.set(identity(row), row); else { selected.delete(identity(row)); input.checked = false; }
    update();
  }));
  all?.addEventListener('change', () => { if (all.checked) rows.slice(0, 100).forEach(row => selected.set(identity(row), row)); else selected.clear(); syncCheckboxes(); update(); });
  bar?.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (button?.hasAttribute('data-return-clear')) { selected.clear(); syncCheckboxes(); update(); }
    else if (button?.dataset.returnAction) openReturnedAction(button.dataset.returnAction, selectedRows(), data.reviewStatuses, { reload, afterSave, api, csrf, showMessage: helpers.showMessage });
  });
  root.querySelectorAll('[data-return-edit]').forEach(button => button.addEventListener('click', () => openReturnedAction('edit', [rows[Number(button.dataset.returnEdit)]], data.reviewStatuses, { reload, afterSave, api, csrf, showMessage: helpers.showMessage })));
  root.querySelectorAll('.returned-table tbody tr').forEach((element, index) => {
    element.addEventListener('click', event => {
      if (event.defaultPrevented || event.target.closest('a, button, input, select, textarea, label, summary, [role="button"], [contenteditable]')) return;
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed && element.contains(selection.anchorNode)) return;
      openReturnedAction('edit', [rows[index]], data.reviewStatuses, { reload, afterSave, api, csrf, showMessage: helpers.showMessage });
    });
  });
  root.querySelectorAll('[data-return-workflow]').forEach(button => {
    button.addEventListener('click', () => { state.returnWorkflow = button.dataset.returnWorkflow; state.page = 0; reload(); });
    button.addEventListener('keydown', event => {
      if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
      event.preventDefault(); const buttons = [...root.querySelectorAll('[data-return-workflow]')], index = buttons.indexOf(button);
      buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length].focus();
    });
  });
  helpers.applyReviewColors(root);
  root.querySelector('.returned-panel')?.setAttribute('id', 'returned-results');
  root.querySelector('.result-count')?.setAttribute('role', 'status');
  root.querySelectorAll('[data-return-card]').forEach(button => button.addEventListener('click', async () => {
    const next = button.dataset.returnCard;
    state.returnCard = state.returnCard === next ? 'all' : next;
    state.page = 0;
    await reload();
    if (state.view === 'returns') document.getElementById(`returned-card-${state.returnCard}`)?.focus({ preventScroll: true });
  }));
}

export function openReturnedAction(action, rows, statuses = [], { api, csrf, reload, afterSave, showMessage = () => {} }) {
  if (!rows.length || rows.length > 100) return;
  const single = rows.length === 1, first = rows[0], editing = action === 'edit';
  const title = action === 'reopen' ? 'Reabrir acompanhamento' : action === 'finalize' ? 'Finalizar acompanhamento' : 'Editar acompanhamento';
  const options = statuses.filter(item => item.active !== false && !item.automatic);
  if (editing && single && !options.some(item => item.code === first.review.status)) options.push({ code: first.review.status, label: first.review.label });
  const dialog = document.createElement('dialog'); dialog.className = 'rm-dialog'; dialog.setAttribute('aria-label', title);
  dialog.innerHTML = `<div class="rm-dialog-heading"><div><h2>${title}</h2><p>${single ? e(first.orderId) : `${rows.length} pedidos selecionados`} · Devolvido ao vendedor</p></div><button class="icon-button" type="button" data-return-close aria-label="Fechar acompanhamento">×</button></div><div class="rm-dialog-body"><p class="detail-info">${action === 'finalize' ? 'Os pedidos sairão de Em acompanhamento e ficarão em Finalizados. Isso não confirma ressarcimento nem altera o pedido na Amazon.' : action === 'reopen' ? 'Os pedidos voltarão para Em acompanhamento. As anotações serão preservadas.' : 'O acompanhamento desta fila é separado de Gerenciar reembolsos.'}</p><div role="status" data-return-error></div><form class="case-review-form">
    ${action !== 'reopen' ? `<label>Status da análise<select name="status" ${action === 'finalize' ? 'required' : ''}>${editing && !single ? '<option value="">Manter status atual</option>' : action === 'finalize' ? '<option value="">Escolha o status</option>' : ''}${options.map(item => `<option value="${e(item.code)}" data-color="${e(item.color || '')}" ${editing && single && first.review.status === item.code ? 'selected' : ''}>${e(item.label || item.code)}</option>`).join('')}</select></label>${editing && single ? `<label>ID de caso<input name="caseId" inputmode="numeric" pattern="[0-9]*" maxlength="30" value="${e(first.review.caseId || '')}"></label>` : ''}<label>${editing && single ? 'Anotações' : 'Adicionar anotação'}<textarea name="${editing && single ? 'notes' : 'note'}" rows="4" maxlength="2000">${editing && single ? e(first.review.notes || '') : ''}</textarea></label>${!single ? '<p class="detail-info">A anotação será acrescentada às existentes em cada pedido. Os IDs de caso individuais serão preservados.</p>' : ''}` : ''}
    <div class="rm-form-actions"><button class="button" type="button" data-return-close>Cancelar</button><button class="button primary" type="submit">${action === 'finalize' ? 'Confirmar finalização' : action === 'reopen' ? 'Confirmar reabertura' : 'Salvar acompanhamento'}</button></div></form></div>`;
  let saving = false, conflict = false;
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  dialog.addEventListener('cancel', event => { if (saving) event.preventDefault(); });
  const outside = event => {
    const bounds = dialog.getBoundingClientRect();
    return event.target === dialog && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom);
  };
  let backdropPress = false;
  dialog.addEventListener('pointerdown', event => { backdropPress = outside(event); });
  dialog.addEventListener('pointercancel', () => { backdropPress = false; });
  dialog.addEventListener('click', event => { if (backdropPress && outside(event) && !saving) dialog.close(); backdropPress = false; });
  dialog.querySelectorAll('[data-return-close]').forEach(button => button.addEventListener('click', () => { if (!saving) dialog.close(); }));
  const form = dialog.querySelector('form'), submit = form.querySelector('[type="submit"]');
  const validate = () => { submit.disabled = saving || conflict || !form.checkValidity(); };
  form.addEventListener('input', validate); form.addEventListener('change', validate);
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (saving || conflict || !form.checkValidity()) return;
    const input = { action, items: rows.map(row => ({ storeId: row.storeId, orderId: row.orderId, expectedVersion: row.review.version })) };
    for (const [field, value] of new FormData(form)) if (field !== 'status' || value) input[field] = value;
    saving = true; [...form.elements].forEach(control => { control.disabled = true; });
    try { await api('/api/returns/manage', { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify(input) }); dialog.close();
      try { await (afterSave || reload)(); showMessage('Acompanhamento salvo.'); }
      catch { showMessage('Acompanhamento salvo. Não foi possível atualizar a lista; use Atualizar painel.', 'warning'); } }
    catch (error) {
      saving = false; [...form.elements].forEach(control => { control.disabled = false; });
      dialog.querySelector('[data-return-error]').textContent = error.message;
      conflict = ['REVIEW_CONFLICT','WORKFLOW_CONFLICT'].includes(error.code); validate();
    }
  });
  document.body.append(dialog); dialog.showModal(); validate();
}
