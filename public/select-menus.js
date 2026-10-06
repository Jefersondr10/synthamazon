const controls = new WeakMap();
let sequence = 0, active = null, settings = {};
const normalize = value => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR');
const svg = path => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
const chevron = svg('<path d="m6 9 6 6 6-6"/>'), check = svg('<path d="m5 12 4 4L19 6"/>');
function labelFor(select) {
  if (select.getAttribute('aria-label')) return select.getAttribute('aria-label');
  const label = select.labels?.[0]?.cloneNode(true);
  label?.querySelectorAll('select,input,textarea,button,small').forEach(node => node.remove());
  return label?.textContent.trim() || 'Selecionar opção';
}
function enhance(select) {
  if (controls.has(select) || select.hidden || select.multiple || select.dataset.filterMultiple === 'true') return;
  const label = labelFor(select), id = select.id || `choice-${++sequence}`;
  const host = document.createElement('span'); host.className = 'choice-control';
  const trigger = document.createElement('button'); trigger.type = 'button'; trigger.className = 'choice-trigger'; trigger.id = `${id}-trigger`;
  trigger.setAttribute('aria-haspopup', 'listbox'); trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-controls', `${id}-options`);
  if (select.getAttribute('aria-describedby')) trigger.setAttribute('aria-describedby', select.getAttribute('aria-describedby'));
  let popup = null, search = null, list = null, abort = null;
  const colorFor = option => {
    const supplied = option?.dataset.color || settings.colorForOption?.(select, option);
    const color = {neutral:'#64748b',blue:'#2563eb',amber:'#d97706',good:'#15803d',red:'#dc2626'}[supplied] || supplied;
    return /^#[0-9a-f]{6}$/i.test(color || '') ? color : null;
  };
  const dot = option => {
    const color = colorFor(option);
    if (!color) return null;
    const node = document.createElement('i'); node.className = 'choice-dot'; node.style.setProperty('--choice-color', color); node.setAttribute('aria-hidden', 'true'); return node;
  };
  const sync = () => {
    const selected = select.selectedOptions[0], value = selected?.dataset.label || selected?.textContent || 'Selecione';
    trigger.replaceChildren();
    const marker = dot(selected); if (marker) trigger.append(marker);
    const text = document.createElement('span'); text.className = 'choice-trigger-text';
    if (select.closest('.table-filters')) { const caption = document.createElement('small'); caption.textContent = label; text.append(caption); }
    const caption = document.createElement('span'); caption.textContent = value; text.append(caption); trigger.append(text);
    trigger.insertAdjacentHTML('beforeend', chevron);
    trigger.setAttribute('aria-label', `${label}: ${value}`); trigger.setAttribute('aria-required', String(select.required));
    trigger.disabled = select.disabled || Boolean(select.closest('fieldset[disabled]'));
    if (select.validity.valid) trigger.removeAttribute('aria-invalid');
  };
  const close = (focus = false) => {
    abort?.abort(); abort = null;
    if (popup?.matches(':popover-open')) popup.hidePopover();
    popup?.remove(); popup = null; trigger.setAttribute('aria-expanded', 'false');
    if (active?.select === select) active = null;
    if (focus && trigger.isConnected) trigger.focus({preventScroll:true});
  };
  const position = () => {
    if (!popup || !trigger.isConnected) { close(); return; }
    const box = trigger.getBoundingClientRect(), viewport = window.visualViewport;
    const leftEdge = viewport?.offsetLeft || 0, topEdge = viewport?.offsetTop || 0;
    const width = viewport?.width || innerWidth, height = viewport?.height || innerHeight;
    const roomBelow = topEdge + height - box.bottom - 18, roomAbove = box.top - topEdge - 18;
    const below = roomBelow >= Math.min(360, roomAbove), room = Math.max(100, below ? roomBelow : roomAbove);
    popup.style.width = `${Math.min(Math.max(box.width, 290), 520, width - 24)}px`;
    popup.style.maxHeight = `${Math.min(460, room)}px`;
    popup.style.left = `${Math.max(leftEdge+12, Math.min(box.left, leftEdge+width-popup.getBoundingClientRect().width-12))}px`;
    popup.style.top = `${below ? box.bottom+8 : Math.max(topEdge+12, box.top-popup.getBoundingClientRect().height-8)}px`;
  };
  const options = () => [...list.querySelectorAll('[role="option"]:not(:disabled)')];
  const renderOptions = () => {
    list.replaceChildren();
    const query = normalize(search?.value.trim() || '');
    for (const option of select.options) {
      if (option.hidden || query && !normalize(option.textContent).includes(query)) continue;
      const button = document.createElement('button'); button.type = 'button'; button.className = 'choice-option'; button.tabIndex = -1;
      button.setAttribute('role', 'option'); button.setAttribute('aria-selected', String(option.selected));
      button.disabled = option.disabled || option.parentElement?.disabled === true;
      const marker = dot(option); if (marker) button.append(marker);
      const caption = document.createElement('span'); caption.textContent = option.textContent; button.append(caption); button.insertAdjacentHTML('beforeend', check);
      button.addEventListener('click', () => {
        const changed = select.value !== option.value; select.value = option.value; sync(); close(true);
        if (changed) { settings.beforeChange?.(select, trigger); select.dispatchEvent(new Event('input', {bubbles:true})); select.dispatchEvent(new Event('change', {bubbles:true})); }
      });
      list.append(button);
    }
    if (!list.children.length) { const empty = document.createElement('p'); empty.className = 'choice-empty'; empty.textContent = 'Nenhuma opção encontrada'; empty.setAttribute('role', 'status'); list.append(empty); }
    position();
  };
  const open = (keyboard = false, last = false) => {
    if (trigger.disabled || !trigger.isConnected) return;
    active?.close(); sync(); abort = new AbortController();
    popup = document.createElement('div'); popup.className = 'choice-popup'; popup.setAttribute('popover', 'manual');
    const header = document.createElement('div'); header.className = 'choice-heading'; header.textContent = label; popup.append(header);
    search = null;
    if (select.options.length > 7) {
      const wrapper = document.createElement('div'); wrapper.className = 'choice-search'; wrapper.innerHTML = svg('<circle cx="10" cy="10" r="6.5"/><path d="m15 15 5 5"/>');
      search = document.createElement('input'); search.type = 'search'; search.placeholder = 'Buscar opção…'; search.setAttribute('aria-label', `Buscar em ${label}`); search.autocomplete = 'off';
      search.addEventListener('input', renderOptions); wrapper.append(search); popup.append(wrapper);
    }
    list = document.createElement('div'); list.className = 'choice-options'; list.id = `${id}-options`; list.setAttribute('role', 'listbox'); list.setAttribute('aria-label', label); popup.append(list);
    (select.closest('dialog') || document.body).append(popup); popup.showPopover();
    active = {select, close}; trigger.setAttribute('aria-expanded', 'true'); renderOptions();
    const choices = options(), selected = list.querySelector('[aria-selected="true"]:not(:disabled)');
    (keyboard ? last ? choices.at(-1) : selected || choices[0] : search || selected || choices[0])?.focus({preventScroll:true});
    selected?.scrollIntoView({block:'nearest'});
    const signal = abort.signal;
    document.addEventListener('pointerdown', event => { if (!host.contains(event.target) && !popup?.contains(event.target)) close(); }, {capture:true,signal});
    document.addEventListener('focusin', event => { if (!host.contains(event.target) && !popup?.contains(event.target)) close(); }, {signal});
    // Escape closes the menu first, keeping the surrounding editing dialog open.
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); close(true); }
    }, {capture:true,signal});
    popup.addEventListener('keydown', event => {
      const choices = options(), index = choices.indexOf(document.activeElement);
      if (event.key === 'Tab') { close(true); return; }
      if (['ArrowDown','ArrowUp','Home','End'].includes(event.key) && (event.target !== search || ['ArrowDown','ArrowUp'].includes(event.key))) {
        event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? choices.length-1 : index < 0 ? event.key === 'ArrowUp' ? choices.length-1 : 0 : (index+(event.key === 'ArrowDown'?1:-1)+choices.length)%choices.length;
        choices[next]?.focus({preventScroll:true}); choices[next]?.scrollIntoView({block:'nearest'});
      } else if (event.key === 'Enter' && event.target === search) { event.preventDefault(); choices[0]?.click(); }
      else if (event.target !== search && event.key.length === 1 && event.key !== ' ' && !event.ctrlKey && !event.metaKey) {
        const next = [...choices.slice(index+1),...choices.slice(0,index+1)].find(button => normalize(button.textContent).startsWith(normalize(event.key)));
        next?.focus({preventScroll:true}); next?.scrollIntoView({block:'nearest'});
      }
    });
    window.addEventListener('resize', position, {signal});
    document.addEventListener('scroll', event => { if (!popup?.contains(event.target)) position(); }, {capture:true,signal});
    select.closest('dialog')?.addEventListener('close', () => close(), {signal});
  };
  select.before(host); host.append(select, trigger); select.hidden = true; select.tabIndex = -1;
  select.addEventListener('focus', () => trigger.focus());
  select.addEventListener('change', sync);
  select.addEventListener('invalid', event => { event.preventDefault(); trigger.setAttribute('aria-invalid','true'); trigger.focus(); open(); });
  select.form?.addEventListener('reset', () => queueMicrotask(sync));
  trigger.addEventListener('click', () => popup ? close(true) : open());
  trigger.addEventListener('keydown', event => { if (['ArrowDown','ArrowUp'].includes(event.key)) { event.preventDefault(); open(true,event.key==='ArrowUp'); } });
  controls.set(select, {sync}); sync();
}
export function enhanceSelectMenus(root = document) {
  if (root.matches?.('select')) enhance(root);
  root.querySelectorAll('select').forEach(enhance);
}
export function observeSelectMenus(root, options = {}) {
  settings = options; enhanceSelectMenus(root);
  const observer = new MutationObserver(records => {
    if (active && (!active.select.isConnected || active.select.closest('dialog:not([open])'))) active.close();
    for (const record of records) {
      const select = record.target.matches?.('select') ? record.target : record.target.closest?.('select');
      if (select) controls.get(select)?.sync();
      for (const node of record.addedNodes) if (node.nodeType === 1 && !node.closest('.choice-control,.choice-popup')) enhanceSelectMenus(node);
    }
  });
  observer.observe(root, {childList:true,subtree:true,attributes:true,attributeFilter:['disabled','required','selected']});
  return () => { observer.disconnect(); active?.close(); };
}
