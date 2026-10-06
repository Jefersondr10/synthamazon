import { canonicalStoreSelection } from '../../public/store-selection.js';
import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { normalizeReviewStatusColor } from '../domain/review-statuses.mjs';
import { validateManagementAction } from '../domain/refund-management-actions.mjs';
import { validateReturnedAction } from '../domain/returned-management.mjs';
import { remoteEntry, confirmRemoteEntry } from './remote-entry.mjs';
import { scopeRepository } from './store-scope.mjs';
import { productionAccess } from './production-access.mjs';
import { validateSalesAlertAction } from '../domain/sales-alerts.mjs';
import { validateProductCostLink, validateProductCostGroup } from '../domain/product-cost-links.mjs';
import { validateProductSkuFilters } from '../domain/product-sku-list.mjs';

const ASSETS = new Map([
  ['/product-cost-links.js', ['product-cost-links.js', 'text/javascript; charset=utf-8']],
  ['/product-links-settings.js', ['product-links-settings.js', 'text/javascript; charset=utf-8']],
  ['/store-selection.js', ['store-selection.js', 'text/javascript; charset=utf-8']],
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/layout.js', ['layout.js', 'text/javascript; charset=utf-8']],
  ['/list-data.js', ['list-data.js', 'text/javascript; charset=utf-8']],
  ['/inventory-planning.js', ['inventory-planning.js', 'text/javascript; charset=utf-8']],
  ['/inventory-report.js', ['inventory-report.js', 'text/javascript; charset=utf-8']],
  ['/inventory-quantities.js', ['inventory-quantities.js', 'text/javascript; charset=utf-8']],
    ['/product-sales.js', ['product-sales.js', 'text/javascript; charset=utf-8']],
    ['/select-menus.js', ['select-menus.js', 'text/javascript; charset=utf-8']],
  ['/product-panel.js', ['product-panel.js', 'text/javascript; charset=utf-8']],
  ['/product-panel.css', ['product-panel.css', 'text/css; charset=utf-8']],
  ['/product-sales.css', ['product-sales.css', 'text/css; charset=utf-8']],
  ['/sales-alerts.js', ['sales-alerts.js', 'text/javascript; charset=utf-8']],
  ['/sales-alerts.css', ['sales-alerts.css', 'text/css; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/design.css', ['design.css', 'text/css; charset=utf-8']],
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml']],
  ['/refund-management.js', ['refund-management.js', 'text/javascript; charset=utf-8']],
  ['/refund-management.css', ['refund-management.css', 'text/css; charset=utf-8']],
  ['/returned-management.js', ['returned-management.js', 'text/javascript; charset=utf-8']],
]);
const FILTER_KEYS = new Set(['storeId', 'from', 'to', 'query', 'mode', 'status', 'limit', 'offset']);
const STORE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ORDER_ID = /^[A-Za-z0-9-]{1,80}$/;
const CASE_ID = /^[A-Za-z0-9_-]{1,80}$/;
const REVIEW_STATUSES = new Set(['pending', 'in_review', 'request_safe_t', 'waiting_amazon', 'resolved']);
const reviewCode = value => typeof value === 'string' && (REVIEW_STATUSES.has(value) || /^custom_[a-f0-9]{32}$/.test(value));
const REVIEW_MENUS = new Set(['orders', 'refunds', 'charges', 'customer-returns', 'returns', 'refund-management']);
const managementStatusCode = value => reviewCode(value) || /^rm_(new|analysis|request_safe_t|safe_t_received|easy_ship_received|concluded|safe_t_granted|return_received|customer_return_wait)$/.test(value ?? '');
const MANAGEMENT_FILTERS = new Set(['storeId','from','to','query','mode','status','orderStatus','workflow','returnFilter','payment','deadline','sort','direction','limit','offset']);
const LOCAL_REVIEW_MENUS = new Set(['orders', 'customer-returns', 'returns']);
const FINANCIAL_FILTERS = new Set(['storeId', 'from', 'to', 'query', 'status', 'type', 'limit', 'offset']);
const REFUND_FILTERS = new Set([...FINANCIAL_FILTERS, 'reimbursement']);
const REIMBURSEMENT_FILTERS = new Set(['all', 'identified', 'unidentified', 'safe_t', 'easy_ship']);
const ERROR_MESSAGES = {
  COST_LINK_CONFLICT: 'O vínculo mudou em outra janela. Feche e reabra a vinculação antes de salvar.',
  COST_LINK_EXTERNAL: 'Este vínculo vem do estoque FBA. Altere o produto no sistema de estoque.',
  COST_SOURCE_UNAVAILABLE: 'Os custos do estoque estão temporariamente indisponíveis ou desatualizados. Tente novamente após a próxima atualização.',
  COST_STORE_UNLINKED: 'A origem dos custos desta loja ainda não foi configurada.',
  BAD_REQUEST: 'Pedido inválido.', FORBIDDEN: 'Acesso local não autorizado.',
  NOT_FOUND: 'Conteúdo não encontrado.', METHOD_NOT_ALLOWED: 'Método não permitido.',
  RELOAD_BUSY: 'A atualização dos dados locais já está em andamento.',
  REVIEW_CONFLICT: 'Este acompanhamento foi atualizado em outra janela. Reabra os detalhes antes de salvar.',
  STATUS_CONFLICT: 'Este status foi atualizado em outra janela. Reabra o cadastro antes de salvar.',
  DUPLICATE_STATUS: 'Já existe um status com esse nome. Edite o cadastro existente.',
  WORKFLOW_CONFLICT: 'A situação da fila mudou. Atualize a lista e confira a seleção.',
  FINALIZATION_STATUS_REQUIRED: 'Escolha um status diferente do atual para todos os pedidos selecionados.',
  FINALIZATION_REASON_REQUIRED: 'Informe o motivo operacional para os pedidos sem crédito novo a confirmar.',
  PAYMENT_VARIANCE_REQUIRED: 'Confirme a ciência das diferenças importantes de valor antes de finalizar.',
  INTERNAL_ERROR: 'Não foi possível concluir a operação local.',
};

function equalSecret(actual, expected) {
  if (typeof actual !== 'string') return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function hasSession(request, cookieName, session) {
  const matches = String(request.headers.cookie ?? '').split(';').map(part => part.trim())
    .filter(part => part.startsWith(`${cookieName}=`));
  return matches.length === 1 && equalSecret(matches[0].slice(cookieName.length + 1), session);
}

function invalid() { throw new TypeError('Invalid request.'); }
function validDate(value) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const parsed = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value));
}

function validSelections(value, validCode, limit, ignoreCase = false) {
  const values = value.split(',');
  const keys = ignoreCase ? values.map(code => code.toLowerCase()) : values;
  return values.length <= limit && values.every(validCode) && new Set(keys).size === keys.length
    && (values.length === 1 || !keys.includes('all'));
}

function filtersFrom(searchParams, permitted = FILTER_KEYS, { multipleStores = false, multipleStatus = false, statusPattern = /^[A-Za-z_]{1,50}$/ } = {}) {
  const result = {};
  for (const [key, value] of searchParams) {
    if (!permitted.has(key) || Object.hasOwn(result, key)) invalid();
    if (key === 'storeId') { if (multipleStores) canonicalStoreSelection(value); else if (!STORE_ID.test(value)) invalid(); }
    if ((key === 'from' || key === 'to') && !validDate(value)) invalid();
    if (key === 'query' && (value.length > 200 || /[\u0000-\u001f]/.test(value))) invalid();
    if (key === 'mode' && !['ALL', 'FBA', 'DBA', 'MFN', 'UNKNOWN'].includes(value.toUpperCase())) invalid();
    if (key === 'channels' && !validSelections(value, code => ['FBA','DBA','MFN'].includes(code), 3)) invalid();
    if (key === 'status' && !(multipleStatus ? validSelections(value, code => statusPattern.test(code), 50, true) : /^[A-Za-z_][A-Za-z0-9_]{0,49}$/.test(value))) invalid();
    if (key === 'orderStatus' && !validSelections(value, code => /^[A-Za-z_]{1,50}$/.test(code), 50, true)) invalid();
    if (key === 'reviewStatus' && value !== 'all' && !managementStatusCode(value)) invalid();
    if (key === 'type' && (!value || value.length > 100 || /[\u0000-\u001f]/.test(value))) invalid();
    if (key === 'reimbursement' && !validSelections(value, code => REIMBURSEMENT_FILTERS.has(code), 4)) invalid();
    if (key === 'refund' && !['all', 'recorded', 'not_found'].includes(value)) invalid();
    if (key === 'net' && !['all', 'positive', 'receivable'].includes(value)) invalid();
    if (key === 'forecast' && value !== 'true') invalid();
    if (key === 'workflow' && !['all','active','finalized'].includes(value)) invalid();
    if (key === 'returnFilter' && !['all','withReturn','withoutReturn'].includes(value)) invalid();
    if (key === 'payment' && !['all','pending','paid','unpaid','variance'].includes(value)) invalid();
    if (key === 'deadline' && !['all','upcoming','overdue'].includes(value)) invalid();
    if (key === 'sort' && !['refundDate','safeTDate'].includes(value)) invalid();
    if (key === 'direction' && !['asc','desc'].includes(value)) invalid();
    if (key === 'limit' || key === 'offset') {
      if (!/^\d+$/.test(value)) invalid();
      const number = Number(value);
      if (!Number.isSafeInteger(number) || number < (key === 'limit' ? 1 : 0) || number > (key === 'limit' ? 500 : 1_000_000)) invalid();
      result[key] = number;
    } else result[key] = value;
  }
  if (result.from && result.to && Date.parse(result.from) > Date.parse(result.to)) invalid();
  return result;
}

async function readJsonInput(request, maxBytes = 16_384) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) invalid();
  const expectedLength = request.headers['content-length'];
  if (expectedLength !== undefined && (!/^\d+$/.test(expectedLength) || Number(expectedLength) > maxBytes)) invalid();
  const chunks = []; let size = 0;
  for await (const chunk of request) { size += chunk.length; if (size > maxBytes) invalid(); chunks.push(chunk); }
  let input; try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { invalid(); }
  return input;
}

async function readBulkReviewInput(request) {
  const input = await readJsonInput(request, 65_536);
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['kind', 'items', 'status'].includes(key))
    || input.kind !== 'refunds' || !reviewCode(input.status) || !Array.isArray(input.items) || input.items.length < 1 || input.items.length > 100) invalid();
  const seen = new Set();
  for (const item of input.items) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(key => !['storeId', 'caseId', 'expectedVersion'].includes(key))
      || typeof item.storeId !== 'string' || !STORE_ID.test(item.storeId) || item.storeId === 'all'
      || typeof item.caseId !== 'string' || !/^refunds-[a-f0-9]{64}$/.test(item.caseId)
      || !Number.isSafeInteger(item.expectedVersion) || item.expectedVersion < 0) invalid();
    const identity = JSON.stringify([item.storeId, item.caseId]);
    if (seen.has(identity)) invalid(); seen.add(identity);
  }
  return input;
}

async function readReviewInput(request) {
  const input = await readJsonInput(request);
  const keys = new Set(['kind', 'storeId', 'caseId', 'status', 'notes', 'expectedVersion']);
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !keys.has(key))) invalid();
  if (!['refunds', 'charges'].includes(input.kind) || typeof input.storeId !== 'string' || !STORE_ID.test(input.storeId) || input.storeId === 'all'
    || typeof input.caseId !== 'string' || !CASE_ID.test(input.caseId) || !reviewCode(input.status)
    || typeof input.notes !== 'string' || input.notes.length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(input.notes)
    || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) invalid();
  return input;
}

function localReviewIdentity(input) {
  if (!input || !LOCAL_REVIEW_MENUS.has(input.menu) || typeof input.storeId !== 'string' || !STORE_ID.test(input.storeId) || input.storeId === 'all'
    || typeof input.entityId !== 'string' || !(input.menu === 'customer-returns' ? /^return-[a-f0-9]{64}$/ : ORDER_ID).test(input.entityId)) invalid();
  return input;
}

async function readLocalReviewInput(request) {
  const input = await readJsonInput(request);
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['menu', 'storeId', 'entityId', 'status', 'notes', 'expectedVersion'].includes(key))) invalid();
  localReviewIdentity(input);
  if (!reviewCode(input.status) || typeof input.notes !== 'string' || input.notes.length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(input.notes)
    || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) invalid();
  return input;
}

async function readStatusInput(request) {
  const input = await readJsonInput(request);
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['code', 'label', 'color', 'menus', 'active', 'closesCase', 'expectedVersion'].includes(key))
    || Object.hasOwn(input, 'code') && !managementStatusCode(input.code)
    || typeof input.label !== 'string' || !input.label.trim() || input.label.length > 60 || /[\u0000-\u001f\u007f]/.test(input.label)
    || normalizeReviewStatusColor(input.color) === null
    || typeof input.active !== 'boolean' || typeof input.closesCase !== 'boolean'
    || !Array.isArray(input.menus) || input.menus.length > REVIEW_MENUS.size || new Set(input.menus).size !== input.menus.length
    || input.menus.some(menu => !REVIEW_MENUS.has(menu)) || input.active && input.menus.length === 0
    || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) invalid();
  return input;
}

function headers(response) {
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'same-origin');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
}

function json(response, status, body) {
  const text = JSON.stringify(body, (_key, value) => typeof value === 'bigint' ? value.toString() : value);
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text) });
  response.end(text);
}

function fail(response, status, code) {
  if (response.headersSent) { response.destroy(); return; }
  json(response, status, { error: { code, message: ERROR_MESSAGES[code] } });
}

/** Starts an isolated loopback session. Does not collect Amazon data or read credentials.
 * An explicit HTTPS publicOrigin enables a trusted loopback tunnel, with mandatory expiry.
 * rootDir is the project directory containing public/; repository is already loaded.
 * Open the returned capability URL once, then use the HttpOnly session cookie.
 * Close the returned Node server before closing the repository.
 */
export async function startWebServer({ repository, config = {}, rootDir, port = 0, publicOrigin = null, expiresAt = null, storeScope = null, production = null } = {}) {
  if (production !== null && (publicOrigin !== null || expiresAt !== null || storeScope !== null)) throw new TypeError('Production cannot use a temporary invitation.');
  const access = production === null ? null : productionAccess(production);
  if (storeScope !== null) repository = scopeRepository(repository, storeScope);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError('Invalid local port.');
  if (publicOrigin !== null) {
    const parsed = new URL(publicOrigin);
    if (parsed.protocol !== 'https:' || parsed.origin !== publicOrigin || parsed.username || parsed.password
      || !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + 86_400_000) {
      throw new TypeError('Remote access requires an exact HTTPS origin and an expiry within 24 hours.');
    }
  } else if (expiresAt !== null) throw new TypeError('Expiry requires a public origin.');
  if (access) publicOrigin = access.origin;
  for (const method of ['getBootstrap', 'dashboard', 'dashboardTransactions', 'orders', 'orderDetail', 'inventory', 'returns', 'financialCases', 'financialCaseDetail', 'saveFinancialReview', 'saveFinancialReviews', 'customerReturns', 'safeTCases', 'refundManagement', 'refundManagementDetail', 'syncRefundManagement', 'saveRefundManagement', 'reviewStatusSettings', 'saveReviewStatus', 'localReview', 'saveLocalReview', 'loadWorkspace']) {
    if (typeof repository?.[method] !== 'function') throw new TypeError('Repository interface is incomplete.');
  }
  if (typeof rootDir !== 'string' || !rootDir) throw new TypeError('Project directory is required.');
  const publicDir = path.resolve(rootDir, 'public');
  const capability = randomBytes(32).toString('base64url');
  const session = randomBytes(32).toString('base64url');
  const csrfToken = randomBytes(32).toString('base64url');
  const cookieName = `synthamazon_${randomBytes(8).toString('hex')}`;
  let connected = false;
  let reloading = false;
  let origin;
  let host;
  const bootstrap = async () => ({
    ...await repository.getBootstrap(),
    meta: {
      appName: 'SynthAmazon', localOnly: publicOrigin === null, csrfToken,
      ...(publicOrigin && !access ? { accessExpiresAt: new Date(expiresAt).toISOString() } : {}),
      ...(access ? { accountEmail: access.ownerEmail, logoutUrl: '/oauth2/sign_out?rd=/oauth2/sign_in' } : {}),
      reloadLabel: access ? 'Atualizar painel' : 'Recarregar dados locais',
      ...(typeof config.historyStart === 'string' && validDate(config.historyStart) ? { historyStart: config.historyStart } : {}),
    },
  });

  const server = http.createServer(async (request, response) => {
    headers(response);
    let requestMetric;
    if (publicOrigin) response.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
    try {
      // The tunnel terminates HTTPS; never infer the allowed origin from forwarded headers.
      if (publicOrigin && request.headers['x-forwarded-proto'] !== 'https') {
        fail(response, 403, 'FORBIDDEN'); return;
      }
      const hosts = request.rawHeaders.filter((_value, index) => index % 2 === 0 && request.rawHeaders[index].toLowerCase() === 'host');
      if (hosts.length !== 1 || request.headers.host !== host) { fail(response, 403, 'FORBIDDEN'); return; }
      if (typeof request.url !== 'string' || request.url.length > 8_192 || !request.url.startsWith('/') || request.url.startsWith('//')) {
        fail(response, 400, 'BAD_REQUEST'); return;
      }
      // Check the raw path before URL normalization can erase a traversal segment.
      const rawPath = request.url.split('?')[0];
      let pathname;
      try { pathname = decodeURIComponent(rawPath); } catch { fail(response, 400, 'BAD_REQUEST'); return; }
      if (pathname.includes('\\') || pathname.includes('\0') || pathname.split('/').some(part => part === '..' || part === '.')) {
        fail(response, 404, 'NOT_FOUND'); return;
      }
      const url = new URL(request.url, origin);
      if (publicOrigin && !access && Date.now() >= expiresAt) {
        if (request.method === 'GET' && (pathname === '/' || pathname.startsWith('/connect/'))) remoteEntry(response, { status: 403, expired: true });
        else fail(response, 403, 'FORBIDDEN');
        return;
      }
      if (pathname.startsWith('/connect/')) {
        if (access) { fail(response, 403, 'FORBIDDEN'); return; }
        const validKey = !url.search && equalSecret(pathname.slice('/connect/'.length), capability);
        const used = connected && !hasSession(request, cookieName, session);
        if (publicOrigin) {
          if (request.method === 'GET') {
            // A preview/prefetch must never consume the invitation or create a session.
            remoteEntry(response, { status: validKey && !used ? 200 : 403, available: validKey && !used, used: validKey && used });
            return;
          }
          if (request.method !== 'POST') { fail(response, 405, 'METHOD_NOT_ALLOWED'); return; }
          const originMatches = request.headers.origin === origin;
          const formConfirmed = validKey && !used && originMatches && await confirmRemoteEntry(request);
          if (!validKey || used || !originMatches || !formConfirmed) {
            remoteEntry(response, { status: 403, used: validKey && used }); return;
          }
          // Recheck after reading the body: concurrent submissions cannot create two sessions.
          if (Date.now() >= expiresAt || connected && !hasSession(request, cookieName, session)) {
            remoteEntry(response, { status: 403, used: true }); return;
          }
        } else {
          if (request.method !== 'GET') { fail(response, 405, 'METHOD_NOT_ALLOWED'); return; }
          if (!validKey || used) { fail(response, 403, 'FORBIDDEN'); return; }
        }
        connected = true;
        const remoteCookie = publicOrigin ? `; Secure; Max-Age=${Math.max(1, Math.floor((expiresAt - Date.now()) / 1000))}` : '';
        response.setHeader('Set-Cookie', `${cookieName}=${session}; Path=/; HttpOnly; SameSite=Strict${remoteCookie}`);
        response.setHeader('Referrer-Policy', 'no-referrer');
        response.writeHead(303, { Location: '/' });
        response.end();
        return;
      }
      if (access ? !access.authorize(request) : !hasSession(request, cookieName, session)) {
        if (publicOrigin && !access && request.method === 'GET' && pathname === '/') remoteEntry(response, { status: 403 });
        else fail(response, 403, 'FORBIDDEN');
        return;
      }
      if (request.headers.origin && request.headers.origin !== origin) { fail(response, 403, 'FORBIDDEN'); return; }

      if (access && pathname.startsWith('/api/')) {
        const segments = pathname.split('/').filter(Boolean);
        const category = ['bootstrap','reload','settings','local-reviews','dashboard','orders','inventory','product-panel','product-sales','sales-alerts','returns','refunds','charges','reviews','customer-returns','safe-t','refund-management'].includes(segments[1]) ? segments[1] : 'unknown';
        requestMetric = { event:'API_REQUEST', requestId:randomBytes(8).toString('hex'), method:request.method,
          route:`/api/${category}${segments.length>2?'/:detail':''}` };
        response.setHeader('X-Request-Id',requestMetric.requestId);
        const started = performance.now(); let recorded = false;
        const record = () => {
          if (recorded) return; recorded = true;
          const elapsedMs = Math.round(performance.now()-started), status = response.writableFinished ? response.statusCode : 499;
          // Operational diagnostics only: no query strings, order IDs, cookies,
          // emails, authorization headers or response bodies enter the log.
          if (elapsedMs >= 5000 || status >= 500 || status === 499) console.warn(JSON.stringify({ ...requestMetric,status,elapsedMs }));
        };
        response.once('finish',record); response.once('close',record);
      }

      if (pathname === '/api/refund-management' || pathname.startsWith('/api/refund-management/')) {
        const sync = pathname === '/api/refund-management/sync';
        if (request.method === 'POST' && (pathname === '/api/refund-management' || sync)) {
          if (request.headers.origin !== origin || !equalSecret(request.headers['x-csrf-token'], csrfToken)) { fail(response, 403, 'FORBIDDEN'); return; }
          if (url.search) invalid();
          const body = await readJsonInput(request, 65_536);
          try {
            if (sync) {
              if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'storeId')
                || body.storeId !== undefined && typeof body.storeId !== 'string') invalid();
              if (body.storeId !== undefined) canonicalStoreSelection(body.storeId);
              json(response, 200, await repository.syncRefundManagement(body));
            } else json(response, 200, await repository.saveRefundManagement(validateManagementAction(body)));
          } catch (error) {
            if (['REVIEW_CONFLICT','WORKFLOW_CONFLICT','FINALIZATION_STATUS_REQUIRED','FINALIZATION_REASON_REQUIRED','PAYMENT_VARIANCE_REQUIRED'].includes(error.code)) fail(response, 409, error.code);
            else if (error.code === 'CASE_NOT_FOUND') fail(response, 404, 'NOT_FOUND');
            else if (error.code === 'INVALID_MANAGEMENT') fail(response, 400, 'BAD_REQUEST');
            else throw error;
          }
        } else if (request.method === 'GET' && !sync) {
          if (pathname === '/api/refund-management') json(response, 200, await repository.refundManagement(filtersFrom(url.searchParams, MANAGEMENT_FILTERS, { multipleStores: true })));
          else {
            const id = pathname.slice('/api/refund-management/'.length), filters = filtersFrom(url.searchParams, new Set(['storeId']));
            if (!/^management-[a-f0-9]{64}$/.test(id) || !filters.storeId || filters.storeId === 'all') invalid();
            const result = await repository.refundManagementDetail(filters.storeId, id);
            if (result === null) fail(response, 404, 'NOT_FOUND'); else json(response, 200, result);
          }
        } else fail(response, 405, 'METHOD_NOT_ALLOWED');
        return;
      }

      if (pathname === '/api/settings/product-links') {
        if (request.method !== 'GET') { fail(response,405,'METHOD_NOT_ALLOWED'); return; }
        const filters = validateProductSkuFilters(filtersFrom(url.searchParams,new Set(['storeId','query','mode','linkStatus','limit','offset','groupBy']),{multipleStores:true}));
        json(response,200,await repository.productSkuList(filters));
        return;
      }

      if (pathname === '/api/product-cost-link' || pathname === '/api/product-cost-group') {
        const grouped=pathname === '/api/product-cost-group';
        try {
          if (request.method === 'GET') {
            const input = grouped ? validateProductCostGroup(filtersFrom(url.searchParams,new Set(['storeId','asin']),{multipleStores:true}))
              : validateProductCostLink(filtersFrom(url.searchParams, new Set(['storeId','orderId','sku'])));
            json(response, 200, await repository[grouped?'productCostGroup':'productCostLink'](input));
          } else if (request.method === 'POST') {
            if (request.headers.origin !== origin || !equalSecret(request.headers['x-csrf-token'], csrfToken)) { fail(response,403,'FORBIDDEN'); return; }
            if (url.search) invalid();
            json(response, 200, await repository[grouped?'saveProductCostGroup':'saveProductCostLink']((grouped?validateProductCostGroup:validateProductCostLink)(await readJsonInput(request), true)));
          } else fail(response,405,'METHOD_NOT_ALLOWED');
        } catch (error) {
          if (['COST_LINK_CONFLICT','COST_LINK_EXTERNAL'].includes(error.code)) fail(response,409,error.code);
          else if (error.code === 'COST_SOURCE_UNAVAILABLE') fail(response,503,error.code);
          else if (error.code === 'COST_STORE_UNLINKED') fail(response,400,error.code);
          else if (error.code === 'CASE_NOT_FOUND') fail(response,404,'NOT_FOUND');
          else throw error;
        }
        return;
      }

      if (pathname === '/api/sales-alerts') {
        if(request.method==='GET') {
          const filters=filtersFrom(url.searchParams,new Set(['storeId','status','mode','type','query','limit','offset']),{ multipleStores:true });
          if(filters.status&&!['new','seen','snoozed','resolved'].includes(filters.status) || filters.type&&!['all','stopped','drop','surge'].includes(filters.type) || filters.mode&&!['all','FBA','DBA','MFN'].includes(filters.mode))invalid();
          json(response,200,await repository.salesAlerts(filters));
        } else if(request.method==='POST') {
          if(request.headers.origin!==origin||!equalSecret(request.headers['x-csrf-token'],csrfToken)){fail(response,403,'FORBIDDEN');return;}
          if(url.search)invalid();
          try {json(response,200,await repository.saveSalesAlert(validateSalesAlertAction(await readJsonInput(request))));}
          catch(error){if(error.code==='REVIEW_CONFLICT')fail(response,409,error.code);else if(error.code==='CASE_NOT_FOUND')fail(response,404,'NOT_FOUND');else throw error;}
        } else fail(response,405,'METHOD_NOT_ALLOWED');
        return;
      }

      if (pathname === '/api/returns/manage') {
        if (request.method !== 'POST') { fail(response, 405, 'METHOD_NOT_ALLOWED'); return; }
        if (request.headers.origin !== origin || !equalSecret(request.headers['x-csrf-token'], csrfToken)) { fail(response, 403, 'FORBIDDEN'); return; }
        if (url.search) invalid();
        try {
          const input = validateReturnedAction(await readJsonInput(request, 65536));
          json(response, 200, await repository.saveReturnedManagement(input));
        } catch (error) {
          if (['REVIEW_CONFLICT', 'WORKFLOW_CONFLICT'].includes(error.code)) fail(response, 409, error.code);
          else if (error.code === 'CASE_NOT_FOUND') fail(response, 404, 'NOT_FOUND');
          else if (error.code === 'FINALIZATION_STATUS_REQUIRED') fail(response, 400, error.code);
          else if (['INVALID_REVIEW', 'INVALID_STATUS'].includes(error.code)) fail(response, 400, 'BAD_REQUEST');
          else throw error;
        }
        return;
      }

      if (pathname === '/api/settings/statuses' || pathname === '/api/local-reviews') {
        const settings = pathname === '/api/settings/statuses';
        if (!['GET', 'POST'].includes(request.method)) { fail(response, 405, 'METHOD_NOT_ALLOWED'); return; }
        if (request.method === 'GET') {
          if (settings) { filtersFrom(url.searchParams, new Set()); json(response, 200, await repository.reviewStatusSettings()); }
          else {
            const input = filtersFrom(url.searchParams, new Set(['menu', 'storeId', 'entityId']));
            localReviewIdentity(input);
            try { json(response, 200, await repository.localReview(input)); }
            catch (error) { if (error.code === 'CASE_NOT_FOUND') fail(response, 404, 'NOT_FOUND'); else throw error; }
          }
        } else {
          if (request.headers.origin !== origin || !equalSecret(request.headers['x-csrf-token'], csrfToken)) { fail(response, 403, 'FORBIDDEN'); return; }
          if (url.search) invalid();
          const input = await (settings ? readStatusInput(request) : readLocalReviewInput(request));
          try { json(response, 200, settings ? await repository.saveReviewStatus(input) : { review: await repository.saveLocalReview(input) }); }
          catch (error) {
            if (['REVIEW_CONFLICT', 'STATUS_CONFLICT', 'DUPLICATE_STATUS'].includes(error.code)) fail(response, 409, error.code);
            else if (error.code === 'CASE_NOT_FOUND') fail(response, 404, 'NOT_FOUND');
            else if (['INVALID_REVIEW', 'INVALID_STATUS'].includes(error.code)) fail(response, 400, 'BAD_REQUEST');
            else throw error;
          }
        }
        return;
      }

      if (pathname === '/api/reviews' || pathname === '/api/reviews/bulk') {
        if (request.method !== 'POST') { fail(response, 405, 'METHOD_NOT_ALLOWED'); return; }
        if (request.headers.origin !== origin || !equalSecret(request.headers['x-csrf-token'], csrfToken)) { fail(response, 403, 'FORBIDDEN'); return; }
        if (url.search) invalid();
        const bulk = pathname.endsWith('/bulk');
        const input = await (bulk ? readBulkReviewInput(request) : readReviewInput(request));
        try { json(response, 200, bulk ? await repository.saveFinancialReviews(input) : { review: await repository.saveFinancialReview(input) }); }
        catch (error) {
          if (error.code === 'REVIEW_CONFLICT') fail(response, 409, 'REVIEW_CONFLICT');
          else if (error.code === 'CASE_NOT_FOUND') fail(response, 404, 'NOT_FOUND');
          else if (error.code === 'INVALID_REVIEW') fail(response, 400, 'BAD_REQUEST');
          else throw error;
        }
        return;
      }

      if (pathname === '/api/reload') {
        if (request.method !== 'POST') { fail(response, 405, 'METHOD_NOT_ALLOWED'); return; }
        if (request.headers.origin !== origin || !equalSecret(request.headers['x-csrf-token'], csrfToken)) {
          fail(response, 403, 'FORBIDDEN'); return;
        }
        if (url.search || request.headers['transfer-encoding'] || Number(request.headers['content-length'] ?? 0) !== 0) {
          fail(response, 400, 'BAD_REQUEST'); return;
        }
        if (reloading) { fail(response, 409, 'RELOAD_BUSY'); return; }
        reloading = true;
        try {
          // Production collectors import snapshots independently of HTTP requests.
          const imported = access ? null : await repository.loadWorkspace();
          const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
          const reload = { imported: count(imported?.imported), skipped: count(imported?.skipped), errorCount: Array.isArray(imported?.errors) ? imported.errors.length : 0 };
          json(response, 200, { ok: reload.errorCount === 0, reload, bootstrap: await bootstrap() });
        } finally { reloading = false; }
        return;
      }

      if (pathname.startsWith('/api/')) {
        if (request.method !== 'GET') { fail(response, 405, 'METHOD_NOT_ALLOWED'); return; }
        if (pathname === '/api/bootstrap') {
          filtersFrom(url.searchParams, new Set());
          json(response, 200, await bootstrap());
        } else if (pathname === '/api/dashboard') {
          json(response, 200, await repository.dashboard(filtersFrom(url.searchParams, FILTER_KEYS, { multipleStores: true })));
        } else if (pathname === '/api/dashboard/transactions') {
          const filters = filtersFrom(url.searchParams, new Set([...FILTER_KEYS, 'type', 'currency', 'bucket']), { multipleStores: true, multipleStatus: true });
          if (!['type', 'net', 'released', 'deferred'].includes(filters.bucket ?? 'net')
            || (filters.currency !== undefined && !/^[A-Z]{3}$/.test(filters.currency))
            || (filters.bucket === 'type' ? !filters.type : filters.type !== undefined)) invalid();
          json(response, 200, await repository.dashboardTransactions(filters));
        } else if (pathname === '/api/orders') {
          json(response, 200, await repository.orders(filtersFrom(url.searchParams, new Set([...FILTER_KEYS, 'reviewStatus', 'net']), { multipleStores: true, multipleStatus: true })));
        } else if (pathname === '/api/product-sales' || pathname === '/api/product-panel') {
          const filters=filtersFrom(url.searchParams, new Set(['storeId','channels','from','to']), { multipleStores:true });
          if ((filters.from===undefined)!==(filters.to===undefined) || filters.from!==undefined&&(!/^\d{4}-\d{2}-\d{2}$/.test(filters.from)||!/^\d{4}-\d{2}-\d{2}$/.test(filters.to))) invalid();
          json(response, 200, await repository[pathname === '/api/product-panel' ? 'productPanel' : 'productSales'](filters));
        } else if (pathname === '/api/inventory') {
          json(response, 200, await repository.inventory(filtersFrom(url.searchParams, new Set([...FILTER_KEYS, 'forecast']), { multipleStores:true })));
        } else if (pathname === '/api/returns') {
          const filters = filtersFrom(url.searchParams, new Set(['storeId', 'query', 'status', 'from', 'to', 'limit', 'offset', 'reviewStatus', 'workflow', 'card']), { multipleStores:true });
          if (filters.status && !['all', 'refunded', 'without_refund'].includes(filters.status)) invalid();
          if (filters.card !== undefined && !['all', 'refunded', 'reimbursed', 'already_returned'].includes(filters.card)) invalid();
          json(response, 200, await repository.returns(filters));
        } else if (pathname === '/api/customer-returns') {
          const filters = filtersFrom(url.searchParams, new Set(['storeId', 'from', 'to', 'query', 'mode', 'refund', 'limit', 'offset', 'reviewStatus']), { multipleStores:true });
          if (filters.mode && !['all', 'FBA', 'DBA', 'MFN', 'unknown'].includes(filters.mode)) invalid();
          json(response, 200, await repository.customerReturns(filters));
        } else if (pathname === '/api/safe-t') {
          json(response, 200, await repository.safeTCases(filtersFrom(url.searchParams, FILTER_KEYS,
            { multipleStores: true, multipleStatus: true, statusPattern: /^[A-Za-z_][A-Za-z0-9_]{0,79}$/ })));
        } else if (pathname.startsWith('/api/customer-returns/')) {
          const returnId = pathname.slice('/api/customer-returns/'.length);
          const filters = filtersFrom(url.searchParams, new Set(['storeId']));
          if (!filters.storeId || filters.storeId === 'all' || !/^return-[a-f0-9]{64}$/.test(returnId)) invalid();
          const detail = await repository.customerReturns(filters, returnId);
          if (detail === null || detail === undefined) fail(response, 404, 'NOT_FOUND'); else json(response, 200, detail);
        } else if (pathname === '/api/refunds' || pathname === '/api/charges') {
          const kind = pathname.slice('/api/'.length);
          const filters = filtersFrom(url.searchParams, kind === 'refunds' ? REFUND_FILTERS : FINANCIAL_FILTERS, { multipleStores:true });
          if (filters.status && filters.status !== 'all' && !reviewCode(filters.status)) invalid();
          json(response, 200, await repository.financialCases(kind, filters));
        } else if (pathname.startsWith('/api/refunds/') || pathname.startsWith('/api/charges/')) {
          const [, , kind, caseId, ...extra] = pathname.split('/');
          const filters = filtersFrom(url.searchParams, new Set(['storeId']));
          if (extra.length || !CASE_ID.test(caseId ?? '') || !filters.storeId || filters.storeId === 'all') invalid();
          const detail = await repository.financialCaseDetail(kind, filters.storeId, caseId);
          if (detail === null || detail === undefined) fail(response, 404, 'NOT_FOUND');
          else json(response, 200, detail);
        } else if (pathname.startsWith('/api/orders/')) {
          const orderId = pathname.slice('/api/orders/'.length);
          const filters = filtersFrom(url.searchParams, new Set(['storeId']));
          if (!ORDER_ID.test(orderId) || !filters.storeId || filters.storeId === 'all') invalid();
          const order = await repository.orderDetail(filters.storeId, orderId);
          if (order === null || order === undefined) fail(response, 404, 'NOT_FOUND');
          else json(response, 200, order);
        } else fail(response, 404, 'NOT_FOUND');
        return;
      }

      if (request.method !== 'GET' && request.method !== 'HEAD') { fail(response, 405, 'METHOD_NOT_ALLOWED'); return; }
      const asset = ASSETS.get(pathname);
      if (!asset || url.search) { fail(response, 404, 'NOT_FOUND'); return; }
      try {
        const filename = path.join(publicDir, asset[0]);
        // Refuse file symlinks that leave public/ even for a whitelisted asset name.
        const resolved = await realpath(filename);
        if (!resolved.startsWith(publicDir + path.sep)) { fail(response, 404, 'NOT_FOUND'); return; }
        const body = await readFile(resolved);
        response.writeHead(200, { 'Content-Type': asset[1], 'Content-Length': body.length });
        response.end(request.method === 'HEAD' ? undefined : body);
      } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') fail(response, 404, 'NOT_FOUND');
        else fail(response, 500, 'INTERNAL_ERROR');
      }
    } catch (error) {
      if (requestMetric) requestMetric.errorCode = /^[A-Z_]{1,60}$/.test(error.code || '') ? error.code : 'INTERNAL_ERROR';
      if (error.code === 'FORBIDDEN') { fail(response, 403, 'FORBIDDEN'); return; }
      if (['REPOSITORY_BUSY','REPOSITORY_UNAVAILABLE'].includes(error.code)) { fail(response, 503, 'TEMPORARILY_UNAVAILABLE'); return; }
      const invalidInput = error instanceof TypeError || ['INVALID_PARAMETERS', 'INVALID_REVIEW', 'INVALID_STATUS', 'INVALID_MANAGEMENT'].includes(error.code);
      fail(response, invalidInput ? 400 : 500, invalidInput ? 'BAD_REQUEST' : 'INTERNAL_ERROR');
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 2_000;
  server.maxHeadersCount = 40;
  server.maxRequestsPerSocket = 100;
  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });
  await new Promise((resolve, reject) => {
    const onError = error => { server.off('listening', onListen); reject(error); };
    const onListen = () => { server.off('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListen);
    server.listen(port, access ? '0.0.0.0' : '127.0.0.1');
  });
  origin = publicOrigin ?? `http://127.0.0.1:${server.address().port}`;
  host = new URL(origin).host;
  return { server, url: access ? origin : `${origin}/connect/${capability}` };
}
