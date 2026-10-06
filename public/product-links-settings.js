import { openProductCostLink } from './product-cost-links.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const number = value => new Intl.NumberFormat('pt-BR').format(value || 0);
const money = value => value == null ? '—' : new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(Number(value)/100);
const channelNames = {FBA:'FBA',DBA:'DBA',MFN:'Envio próprio'};
const sourceNames = {erp:'Estoque FBA',sku:'Mesmo SKU',synthamazon:'SynthAmazon'};
const filterNames = {all:'Todos',unlinked:'Sem vínculo',partial:'Vínculo parcial',conflict:'Vínculos diferentes',linked:'Vinculados','missing-cost':'Sem custo',unavailable:'Loja sem fonte'};

export function productLinksSettingsMarkup() {
  return `<section class="panel sku-links-settings" id="product-links-settings"><div class="panel-head"><div><span class="eyebrow">CATÁLOGO DE PRODUTOS</span><h2>Vinculação de produtos</h2></div><span class="sku-list-scope">Produtos agrupados por ASIN</span></div><div data-sku-workspace></div></section>`;
}

export function mountProductLinksSettings(root, state, {api,csrf,storeId,isCurrent}) {
  let stopped=false, request=0, timer, currentData=null;
  if (state.storeId!==storeId) {state.storeId=storeId;state.offset=0;}
  const active=()=>!stopped && root.isConnected && isCurrent();
  root.innerHTML=`<div class="sku-links-toolbar"><label class="sku-links-search"><span>Buscar produto ou SKU</span><input type="search" data-sku-search placeholder="SKU, ASIN, nome ou produto do estoque" autocomplete="off" value="${escape(state.query)}"></label><div class="sku-channel-filter" role="group" aria-label="Canal dos SKUs">${Object.entries({ALL:'Todos os canais',...channelNames}).map(([value,label])=>`<button type="button" data-sku-channel="${value}" aria-pressed="${state.mode===value}">${label}</button>`).join('')}</div></div>
    <div class="sku-link-filters" role="group" aria-label="Situação dos vínculos">${Object.entries(filterNames).map(([value,label])=>`<button type="button" data-sku-status="${value}" aria-pressed="${state.linkStatus===value}"><span>${label}</span><strong data-sku-count="${value}">—</strong></button>`).join('')}</div>
    <div class="sku-list-notice" role="status" aria-live="polite" hidden></div><div class="sku-source-notice" hidden></div>
    <div class="sku-list-results" aria-busy="true"><div class="loading-state"><span class="spinner"></span>Agrupando produtos por ASIN…</div></div>`;
  const result=root.querySelector('.sku-list-results'), notice=root.querySelector('.sku-list-notice'), sourceNotice=root.querySelector('.sku-source-notice');
  const message=(text,error=false)=>{notice.textContent=text;notice.hidden=!text;notice.classList.toggle('error',error);};
  const pressed=()=>{
    root.querySelectorAll('[data-sku-status]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.skuStatus===state.linkStatus)));
    root.querySelectorAll('[data-sku-channel]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.skuChannel===state.mode)));
  };
  function render(data) {
    currentData=data;state.offset=data.offset;
    for (const [key,value] of Object.entries(data.counts)) root.querySelector(`[data-sku-count="${key}"]`).textContent=number(value);
    const sourceText=!data.source.connected ? 'A conexão de custos está indisponível. Os SKUs continuam visíveis; tente atualizar a lista.' : data.source.stale ? 'Os custos estão desatualizados. A vinculação será liberada após a próxima atualização.' : data.counts.unavailable ? 'Algumas lojas ainda não têm uma fonte de custos configurada. Elas aparecem como “Loja sem fonte”.' : '';
    sourceNotice.textContent=sourceText;sourceNotice.hidden=!sourceText;
    result.innerHTML=data.items.length ? `<div class="sku-links-table-wrap"><table class="sku-links-table"><thead><tr><th>Produto / ASIN</th><th>Lojas / SKUs</th><th>Situação</th><th>Produto no estoque</th><th>Custo atual</th><th>Vinculação</th></tr></thead><tbody>${data.items.map((item,index)=>{
      const missingCost=item.missingCostCount>0;
      const status=item.status==='unavailable'?(item.sourceUnavailable?'Fonte indisponível':'Loja sem fonte'):item.status==='linked'&&missingCost?'Vinculado · sem custo':({linked:'Vinculado',unlinked:'Sem vínculo',partial:'Vínculo parcial',conflict:'Vínculos diferentes'})[item.status];
      const label=!item.canOpen?'Aguardando configuração':!item.editableCount?'Ver vínculos':item.status==='linked'?'Gerenciar vínculo':item.skuCount>1?'Vincular grupo':'Vincular produto';
      const memberText=row=>`${row.storeName} · ${row.sku}`;
      return `<tr><td data-column="Produto / ASIN"><strong class="sku-amazon-title" title="${escape(item.title)}">${escape(item.title)}</strong><span class="sku-identity">${item.asin?`ASIN ${escape(item.asin)}`:escape(item.members[0].sku)}</span>${!item.asin?'<small>Sem ASIN · mantido separado</small>':''}<div class="sku-channel-tags">${item.channels.map(mode=>`<span class="sku-channel ${mode.toLowerCase()}">${channelNames[mode]}</span>`).join('')}</div></td>
      <td data-column="Lojas / SKUs"><strong>${number(item.skuCount)} ${item.skuCount===1?'SKU':'SKUs'} · ${number(item.stores.length)} ${item.stores.length===1?'loja':'lojas'}</strong><small>${item.stores.map(store=>escape(store.name)).join(' · ')}</small><details class="asin-members"><summary>Ver ${item.skuCount===1?'SKU':'SKUs do produto'}</summary><div>${item.members.map(row=>`<article><strong>${escape(memberText(row))}</strong><span>${row.status==='linked'?escape(row.productName):row.status==='unavailable'?'Loja sem fonte de custos':row.brokenLink?'Vínculo indisponível':'Sem vínculo'}</span><small>${row.source==='erp'?'Vínculo do estoque FBA':sourceNames[row.source]||''}</small></article>`).join('')}</div></details></td>
      <td data-column="Situação"><span class="sku-link-status ${item.status}${missingCost?' missing-cost':''}"><i></i>${status}</span><small>${number(item.linkedCount)} de ${number(item.skuCount)} ${item.skuCount===1?'SKU vinculado':'SKUs vinculados'}</small>${item.unavailableCount?`<small>${number(item.unavailableCount)} sem fonte de custos</small>`:''}</td>
      <td data-column="Produto no estoque">${item.productId?`<strong>${escape(item.productName)}</strong><small>SKU: ${escape(item.productSku)}</small>${item.status==='partial'?'<small>Vinculado a parte do grupo</small>':''}`:`<span class="muted">${item.status==='conflict'?'Produtos diferentes no grupo':'Nenhum produto vinculado'}</span>`}</td>
      <td data-column="Custo atual"><strong class="sku-cost-value">${money(item.unitCostCents)}</strong><small>${item.status==='conflict'?'Consulte os vínculos':missingCost?'Cadastrar custo no estoque':item.unitCostCents!=null?'por unidade vinculada':'Custo pendente'}</small></td>
      <td data-column="Vinculação">${item.canOpen?`<button type="button" class="button compact ${item.editableCount&&item.status!=='linked'?'primary':''}" data-sku-link="${index}">${label}</button>`:`<span class="muted">${label}</span>`}</td></tr>`;
    }).join('')}</tbody></table></div>`:`<div class="sku-list-empty"><strong>${state.linkStatus==='unlinked' && !state.query?'Nenhum produto sem vínculo neste filtro':'Nenhum produto encontrado'}</strong><p>${state.query?'Tente outro nome, SKU ou ASIN.':'Confira os outros filtros e as lojas selecionadas.'}</p></div>`;
    const page=Math.floor(data.offset/data.limit)+1,totalPages=Math.max(1,Math.ceil(data.total/data.limit));
    result.insertAdjacentHTML('beforeend',`<div class="sku-list-footer"><span>${data.total?`${number(data.offset+1)}–${number(data.offset+data.items.length)} de ${number(data.total)} produtos`:'0 produtos'}${data.total?' · Pendentes primeiro':''}</span><div><button type="button" class="button compact" data-sku-prev${!data.offset?' disabled':''}>Anterior</button><span>Página ${page} de ${totalPages}</span><button type="button" class="button compact" data-sku-next${!data.hasMore?' disabled':''}>Próxima</button></div></div>`);
    result.querySelector('[data-sku-prev]').addEventListener('click',()=>{state.offset=Math.max(0,state.offset-state.limit);reload();});
    result.querySelector('[data-sku-next]').addEventListener('click',()=>{state.offset+=state.limit;reload();});
    result.querySelectorAll('[data-sku-link]').forEach(button=>button.addEventListener('click',async()=>{
      if (!active() || result.getAttribute('aria-busy')==='true') return;
      const item=currentData.items[Number(button.dataset.skuLink)];button.disabled=true;
      try {await openProductCostLink(item.asin?{storeId:data.storeId,asin:item.asin}:{storeId:item.members[0].storeId,sku:item.members[0].sku},{api,csrf,onSaved:async saved=>{
        if (!active()) return;
        message(`${item.asin?`Vínculo salvo para ${saved.matched} ${saved.matched===1?'SKU':'SKUs'} do ASIN ${item.asin}`:`Vínculo salvo para ${item.members[0].sku}`}.${saved.syncPending?' Os custos pendentes serão preenchidos na próxima atualização.':''}`);
        await reload({keepMessage:true});
      }});} catch(error) {if(active())message(error.message,true);}
      finally {button.disabled=false;}
    }));
  }
  async function reload({keepMessage=false}={}) {
    clearTimeout(timer);const version=++request;if(!active())return;
    pressed();if(!keepMessage)message('');result.setAttribute('aria-busy','true');
    try {
      const params=new URLSearchParams({storeId,groupBy:'asin',query:state.query,mode:state.mode,linkStatus:state.linkStatus,limit:state.limit,offset:state.offset});
      const data=await api(`/api/settings/product-links?${params}`);
      if(active()&&version===request)render(data);
    } catch(error) {if(active()&&version===request){message(error.message,true);if(!currentData)result.innerHTML='<div class="sku-list-empty">A lista não pôde ser carregada. Use Atualizar painel para tentar novamente.</div>';}}
    finally {if(active()&&version===request)result.setAttribute('aria-busy','false');}
  }
  root.querySelector('[data-sku-search]').addEventListener('input',event=>{state.query=event.target.value;state.offset=0;request++;clearTimeout(timer);timer=setTimeout(reload,250);});
  root.querySelectorAll('[data-sku-status]').forEach(button=>button.addEventListener('click',()=>{state.linkStatus=button.dataset.skuStatus;state.offset=0;reload();}));
  root.querySelectorAll('[data-sku-channel]').forEach(button=>button.addEventListener('click',()=>{state.mode=button.dataset.skuChannel;state.offset=0;reload();}));
  reload();
  return ()=>{stopped=true;request++;clearTimeout(timer);};
}
