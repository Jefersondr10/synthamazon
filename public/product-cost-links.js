const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[character]));
const normalize = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const money = cents => cents == null ? 'Custo não cadastrado' : new Intl.NumberFormat('pt-BR', { style:'currency', currency:'BRL' }).format(Number(cents) / 100);

export async function openProductCostLink(identity, { api, csrf, onSaved }) {
  if (document.querySelector('#product-cost-link-dialog')) return;
  const grouped=!!identity.asin, endpoint=grouped?'/api/product-cost-group':'/api/product-cost-link';
  const dialog = document.createElement('dialog');
  dialog.id = 'product-cost-link-dialog'; dialog.setAttribute('aria-labelledby', 'product-cost-link-title');
  dialog.innerHTML = `<div class="dialog-heading"><div><span class="eyebrow">CUSTOS DOS PRODUTOS</span><h2 id="product-cost-link-title">${grouped?'Vincular produto por ASIN':'Vincular produto'}</h2></div><button type="button" class="icon-button" data-link-close aria-label="Fechar vinculação">×</button></div><div class="cost-link-body"><div class="loading-state"><span class="spinner"></span>Consultando produtos do estoque…</div></div>`;
  document.body.append(dialog);
  let saving = false;
  const close = () => { if (!saving) dialog.close(); };
  dialog.querySelector('[data-link-close]').addEventListener('click', close);
  dialog.addEventListener('cancel', event => { if (saving) event.preventDefault(); });
  dialog.addEventListener('close', () => dialog.remove(), { once:true });
  dialog.showModal();
  const body = dialog.querySelector('.cost-link-body');
  try {
    const data = await api(`${endpoint}?${new URLSearchParams(identity)}`);
    if (!dialog.open) return;
    const external = grouped ? !data.editableCount && !data.stale : data.source === 'erp', selectedProduct = data.products.find(product => product.id === data.productId);
    let selected = data.productId || '';
    body.innerHTML = `<div class="cost-link-origin"><span class="eyebrow">PRODUTO NA AMAZON · ${grouped?`${data.skuCount} SKUs em ${data.stores.length} ${data.stores.length===1?'loja':'lojas'}`:escape(data.storeName)}</span><strong>${escape(data.title)}</strong><span>${grouped?`ASIN: ${escape(data.asin)}`:`SKU: ${escape(identity.sku)}`}</span></div>
      <div class="cost-link-current"><span>Vínculo atual</span><strong>${escape(selectedProduct?.name || (data.status==='conflict'?'Vínculos diferentes — escolha o produto para os SKUs editáveis':data.productId ? 'Produto indisponível no estoque' : 'Nenhum produto vinculado'))}</strong><small>${escape(({ erp:'Vinculado no estoque FBA', sku:'Identificado pelo mesmo SKU', synthamazon:'Vinculado no SynthAmazon', none:'Selecione o produto correspondente abaixo' })[data.source] || '')}</small></div>
      ${grouped?`<div class="cost-group-members"><strong>SKUs deste produto</strong><p>${data.editableCount} ${data.editableCount===1?'SKU receberá':'SKUs receberão'} o produto escolhido abaixo. A lista considera as lojas selecionadas e todos os canais.</p><div>${data.members.map(row=>`<article><div><strong>${escape(row.sku)}</strong><small>${escape(row.storeName)} · ${row.channels.map(mode=>({FBA:'FBA',DBA:'DBA',MFN:'Envio próprio'})[mode]).join(' / ')}</small><span>${escape(row.productName || (row.brokenLink?'Vínculo indisponível':'Sem vínculo'))}</span></div><span class="cost-group-action ${row.editable?'editable':''}">${row.editable?'Receberá o vínculo':row.source==='erp'?'Preservado · estoque FBA':row.status==='unavailable'?'Loja sem fonte':'Aguarde atualização'}</span></article>`).join('')}</div></div>`:''}
      ${external ? '<p class="notice">Este vínculo já vem do estoque FBA. Para alterá-lo, use a vinculação no sistema de estoque.</p>' : data.stale ? '<p class="notice warning">Os custos estão desatualizados. Aguarde a próxima atualização antes de vincular.</p>' : ''}
      <form class="cost-link-form"><label for="cost-link-search">${external ? 'Produto vinculado' : 'Escolha o produto do estoque'}</label>
      ${external ? '' : '<input id="cost-link-search" type="search" placeholder="Buscar pelo nome ou SKU do estoque" autocomplete="off"><p class="cost-link-count" aria-live="polite"></p>'}
      <div class="cost-link-options" role="radiogroup" aria-label="Produtos do estoque"></div>
      <div class="cost-link-selection" aria-live="polite"></div>
      <p class="cost-link-help">${escape(data.companyName)} · ${grouped?'O vínculo será aplicado aos SKUs editáveis listados acima. Vínculos do estoque FBA serão preservados.':'O vínculo vale para este SKU nesta loja, em FBA, DBA e envio próprio.'} Custos já registrados nos pedidos serão preservados.</p>
      <div class="notice error cost-link-error" role="alert" hidden></div>
      <div class="cost-link-actions"><button type="button" class="button" data-link-cancel>${external ? 'Fechar' : 'Cancelar'}</button>${external ? '' : `<button class="button primary" type="submit" data-link-save${!data.editable || !selected ? ' disabled' : ''}>${grouped?`Salvar para ${data.editableCount} ${data.editableCount===1?'SKU':'SKUs'}`:'Salvar vínculo'}</button>`}</div></form>`;
    const form = body.querySelector('form'), list = body.querySelector('.cost-link-options'), search = body.querySelector('input[type=search]');
    const save = body.querySelector('[data-link-save]'), error = body.querySelector('.cost-link-error'), summary = body.querySelector('.cost-link-selection');
    const renderSummary = () => {
      const product = data.products.find(product => product.id === selected);
      summary.innerHTML = product ? `<span>Produto escolhido</span><strong>${escape(product.name)}</strong><small>${escape(product.sku)} · ${escape(money(product.unitCostCents))}${product.unitCostCents == null ? ' — os pedidos continuarão com custo pendente.' : ' por unidade'}</small>` : '<span>Nenhum produto escolhido</span>';
      if (save) save.disabled = !data.editable || !product || saving;
    };
    const render = () => {
      const query = normalize(search?.value), matches = data.products.filter(product => external && !grouped ? product.id === selected : grouped && external ? data.members.some(row=>row.productId===product.id) : normalize(`${product.name} ${product.sku}`).includes(query));
      // Keep the editor responsive even when the source catalogue grows large.
      const shown = matches.slice(0, 80);
      const count = body.querySelector('.cost-link-count');
      if (count) count.textContent = `${matches.length} ${matches.length === 1 ? 'produto' : 'produtos'}${matches.length > shown.length ? ' · mostrando os primeiros 80; refine a busca' : ''}`;
      list.innerHTML = shown.map(product => `<label class="cost-link-option"><input type="radio" name="costProduct" value="${escape(product.id)}"${selected === product.id ? ' checked' : ''}${!data.editable ? ' disabled' : ''}><span><strong>${escape(product.name)}</strong><small>SKU: ${escape(product.sku)}</small></span><span class="cost-link-price">${escape(money(product.unitCostCents))}</span></label>`).join('') || '<p class="detail-info">Nenhum produto encontrado.</p>';
    };
    search?.addEventListener('input', render);
    list.addEventListener('change', event => { if (event.target.matches('input[type=radio]')) { selected = event.target.value; renderSummary(); } });
    body.querySelector('[data-link-cancel]').addEventListener('click', close);
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (saving || !data.editable || !data.products.some(product => product.id === selected)) return;
      saving = true; error.hidden = true; save.textContent = 'Salvando vínculo…';
      form.querySelectorAll('button,input').forEach(element => { element.disabled = true; });
      dialog.querySelector('[data-link-close]').disabled = true;
      let result;
      try {
        result = await api(endpoint, { method:'POST', headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},
          body:JSON.stringify({ ...identity, storeId:data.storeId, companyId:data.companyId, productId:selected, ...(grouped?{expectedRevision:data.expectedRevision}:{expectedVersion:data.version}) }) });
      } catch (failure) {
        saving = false; error.textContent = failure.message; error.hidden = false;
        form.querySelectorAll('button,input').forEach(element => { element.disabled = false; });
        dialog.querySelector('[data-link-close]').disabled = false; save.textContent = 'Salvar vínculo'; renderSummary(); return;
      }
      saving = false; dialog.close();
      // A failed screen refresh must never be reported as a failed save.
      await onSaved(result);
    });
    render(); renderSummary();
    search?.focus();
  } catch (error) { if (dialog.open) body.innerHTML = `<p class="notice error" role="alert">${escape(error.message)}</p>`; }
}
