const rememberedTabs = new Map();
let sequence = 0;

function button(text, className = 'button compact') {
  const node = document.createElement('button');
  node.type = 'button'; node.className = className; node.textContent = text;
  return node;
}

export function tabbedSections(container, classify, { remember = false, label = 'Seções dos detalhes' } = {}) {
  const groups = new Map();
  for (const node of [...container.children]) {
    const name = classify(node);
    if (!name) continue;
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(node);
  }
  if (groups.size < 2) return;
  const id = `layout-tabs-${++sequence}`, nav = document.createElement('div');
  nav.className = 'detail-tabs'; nav.setAttribute('role', 'tablist'); nav.setAttribute('aria-label', label);
  const panels = [], triggers = [], names = [...groups.keys()];
  const activate = index => {
    panels.forEach((panel, i) => { panel.hidden = i !== index; triggers[i].setAttribute('aria-selected', String(i === index)); triggers[i].tabIndex = i === index ? 0 : -1; });
    if (remember) rememberedTabs.set(container.id, names[index]);
    container.scrollTop = 0;
  };
  container.prepend(nav);
  for (const [name, nodes] of groups) {
    const index = panels.length, panel = document.createElement('section'), trigger = button(name, 'detail-tab');
    trigger.id = `${id}-tab-${index}`; trigger.setAttribute('role', 'tab'); trigger.setAttribute('aria-controls', `${id}-panel-${index}`);
    panel.id = `${id}-panel-${index}`; panel.className = 'dialog-tab-panel'; panel.dataset.section = name;
    panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', trigger.id);
    panel.append(...nodes); container.append(panel); nav.append(trigger); panels.push(panel); triggers.push(trigger);
    trigger.addEventListener('click', () => activate(index));
    trigger.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? names.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + names.length) % names.length;
      activate(next); triggers[next].focus();
    });
  }
  activate(Math.max(0, names.indexOf(remember ? rememberedTabs.get(container.id) : names[0])));
}

export function paginateNodes(container, selector, size = 6) {
  const nodes = [...container.querySelectorAll(selector)];
  if (nodes.length <= size || container.querySelector(':scope > .detail-pagination')) return;
  let page = 0;
  const controls = document.createElement('div'); controls.className = 'detail-pagination';
  const previous = button('Anterior'), next = button('Próxima'), label = document.createElement('span');
  label.setAttribute('role', 'status');
  const show = () => {
    nodes.forEach((node, index) => { node.hidden = index < page * size || index >= (page + 1) * size; });
    label.textContent = `${page * size + 1}–${Math.min((page + 1) * size, nodes.length)} de ${nodes.length}`;
    previous.disabled = page === 0; next.disabled = (page + 1) * size >= nodes.length;
  };
  previous.addEventListener('click', () => { page--; show(); });
  next.addEventListener('click', () => { page++; show(); });
  controls.append(previous, label, next); container.append(controls); show();
}

export function prepareTables(root) {
  root.querySelectorAll('table').forEach(table => {
    const labels = [...table.querySelectorAll('thead th')].map(th => th.textContent.trim());
    table.querySelectorAll('tbody tr').forEach(row => [...row.cells].forEach((cell, index) => { cell.dataset.column = labels[index] || 'Seleção'; }));
  });
}

export function revealSection(node) {
  const panel = node.closest('.dialog-tab-panel');
  if (panel?.hidden) document.getElementById(panel.getAttribute('aria-labelledby'))?.click();
}

export function organizeDetails(container) {
  tabbedSections(container, node => {
    const heading = node.querySelector('h3')?.textContent || '';
    if (node.matches('.return-detail-choices')) return null;
    if (node.matches('.order-products')) return 'Produtos';
    if (node.matches('.order-transactions') || heading === 'Movimentos financeiros') return 'Lançamentos';
    if (node.matches('.order-tracking')) return 'Rastreamento';
    if (node.matches('.customer-return-pair')) return 'Rastreio e reembolso';
    if (node.matches('.return-detail, .customer-return-facts')) return 'Devolução';
    if (node.querySelector('#case-review-form')) return 'Gerenciar';
    if (/Histórico|Anotações anteriores/.test(heading)) return 'Histórico';
    return 'Resumo';
  });
  container.querySelectorAll('.order-transactions').forEach(section => paginateNodes(section, ':scope > .transaction'));
  container.querySelectorAll('.order-products').forEach(section => paginateNodes(section, ':scope > .detail-product', 3));
  prepareTables(container);
}

export function organizeOrderOverview(container) {
  const transactions = container.querySelector('.order-transactions');
  if (transactions) { container.append(transactions); paginateNodes(transactions, ':scope > .transaction', 5); }
  const products = container.querySelector('.order-products');
  if (products) paginateNodes(products, ':scope > .detail-product', 3);
  const tracking = container.querySelector('.order-tracking');
  if (tracking) paginateNodes(tracking, ':scope > .tracking-card', 3);
}

export function refundFormSteps(form) {
  const grid = form.querySelector('.rm-form-grid'), history = grid?.querySelector('.rm-history');
  const note = form.elements.namedItem('note')?.closest('label');
  if (!grid || !history || !note) return;
  form.classList.add('refund-editor');
  const fields = document.createElement('section'), notes = document.createElement('section');
  fields.className = 'refund-form-step'; notes.className = 'refund-form-step';
  const fieldsHeading = document.createElement('h3'), notesHeading = document.createElement('h3');
  fieldsHeading.textContent = 'Dados do acompanhamento'; notesHeading.textContent = 'Observações e histórico';
  fields.append(fieldsHeading, grid);
  const historyDetails = document.createElement('details'), summary = document.createElement('summary');
  summary.textContent = 'Observações registradas'; historyDetails.className = 'refund-history'; historyDetails.open = true;
  historyDetails.append(summary, history); notes.append(notesHeading, historyDetails, note);
  form.prepend(fields, notes);
  const actions = form.querySelector('.rm-dialog-actions'), previous = button('Voltar'), next = button('Continuar');
  actions.prepend(previous, next);
  const nav = document.createElement('nav'); nav.className = 'detail-tabs form-steps'; nav.setAttribute('aria-label', 'Etapas da edição');
  const triggers = [button('1. Dados do acompanhamento', 'detail-tab'), button('2. Observações e histórico', 'detail-tab')];
  nav.append(...triggers); form.prepend(nav);
  let step = 0;
  const desktop = window.matchMedia('(min-width: 901px)');
  const show = index => {
    step = index; fields.hidden = !desktop.matches && index !== 0; notes.hidden = !desktop.matches && index !== 1;
    nav.hidden = desktop.matches;
    fieldsHeading.hidden = notesHeading.hidden = !desktop.matches;
    triggers.forEach((trigger, i) => { trigger.setAttribute('aria-current', i === index ? 'step' : 'false'); });
    previous.hidden = desktop.matches || index === 0; next.hidden = desktop.matches || index === 1;
  };
  const resize = () => show(step);
  desktop.addEventListener('change', resize);
  form.closest('dialog')?.addEventListener('close', () => desktop.removeEventListener('change', resize), { once: true });
  triggers.forEach((trigger, index) => trigger.addEventListener('click', () => show(index)));
  previous.addEventListener('click', () => show(0)); next.addEventListener('click', () => show(1));
  form.addEventListener('invalid', event => { show(notes.contains(event.target) ? 1 : 0); }, true);
  form.addEventListener('keydown', event => {
    if (event.key === 'Enter' && event.target instanceof HTMLInputElement && step === 0 && !desktop.matches) { event.preventDefault(); show(1); triggers[1].focus(); }
  });
  show(0);
}
