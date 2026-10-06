import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { protectCredentials } from './credentials.mjs';

const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

export async function startCredentialSetup({ save = protectCredentials, autoClose = true, storeName = 'ORIGEM COMERCIO' } = {}) {
  if (typeof storeName !== 'string' || !storeName.trim() || storeName.length > 120) throw new Error('Nome da loja inválido.');
  const storeLabel = escape(storeName.trim());
  const nonce = randomBytes(32).toString('hex');
  const session = randomBytes(32).toString('hex');
  const route = `/setup/${nonce}`;
  let origin;
  let busy = false;
  let saved = false;
  const server = createServer(async (request, response) => {
    const headers = {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'same-origin',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    };
    const reply = (status, html, extra = {}) => { response.writeHead(status, { ...headers, ...extra }); response.end(html); };
    if (request.headers.host !== origin?.slice(7) || request.url !== route) {
      reply(404, 'Página não encontrada.'); return;
    }
    if (saved) { reply(410, page('Configuração concluída', '<p>As credenciais já foram protegidas neste computador. Esta página foi encerrada.</p>')); return; }
    if (request.method === 'GET') {
      reply(200, page(`Conectar ${storeName.trim()}`, `
        <p class="label">SYNTHAMAZON · AMAZON BRASIL</p>
        <h1>Conectar ${storeLabel}</h1>
        <p>Os dados de acesso serão protegidos para seu usuário do Windows, neste computador.</p>
        <form method="post" action="${route}" autocomplete="off">
          <input type="hidden" name="csrf" value="${nonce}">
          <label for="clientId">Client ID do aplicativo de produção</label>
          <input id="clientId" name="clientId" required maxlength="4096" spellcheck="false" autocomplete="off">
          <label for="clientSecret">Client secret</label>
          <input id="clientSecret" name="clientSecret" type="password" required maxlength="4096" autocomplete="new-password">
          <label for="refreshToken">Token de atualização da ${storeLabel} — Brasil</label>
          <input id="refreshToken" name="refreshToken" type="password" required maxlength="8192" autocomplete="new-password">
          <label for="sellerId">Identificador do vendedor (opcional neste piloto)</label>
          <input id="sellerId" name="sellerId" maxlength="128" autocomplete="off" spellcheck="false">
          <button type="submit">Proteger credenciais neste computador</button>
        </form>
        <p class="note">Este passo guarda o acesso. A primeira consulta e a conferência dos dados serão feitas em seguida.</p>
      `), { 'set-cookie': `synth_setup=${session}; HttpOnly; SameSite=Strict; Path=${route}` });
      return;
    }
    if (request.method !== 'POST') { reply(405, 'Método não permitido.', { allow: 'GET, POST' }); return; }
    if (request.headers.origin !== origin || !request.headers.cookie?.split(';').some(item => item.trim() === `synth_setup=${session}`) || !/^application\/x-www-form-urlencoded(?:;|$)/i.test(request.headers['content-type'] ?? '')) {
      reply(403, 'Solicitação não autorizada. Abra a página de configuração original.'); request.resume(); return;
    }
    if (busy) { reply(409, 'Uma gravação já está em andamento.'); request.resume(); return; }
    busy = true;
    try {
      let bytes = 0;
      const chunks = [];
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 32768) { reply(413, 'Dados maiores que o limite permitido.'); request.destroy(); return; }
        chunks.push(chunk);
      }
      const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
      if (form.get('csrf') !== nonce) { reply(403, 'Solicitação não autorizada.'); return; }
      const expected = ['csrf', 'clientId', 'clientSecret', 'refreshToken', 'sellerId'];
      if ([...form.keys()].some(key => !expected.includes(key)) || expected.some(key => form.getAll(key).length > 1)) { reply(400, 'Campos inválidos.'); return; }
      const credentials = {
        clientId: form.get('clientId')?.trim(), clientSecret: form.get('clientSecret')?.trim(), refreshToken: form.get('refreshToken')?.trim(),
        ...(form.get('sellerId')?.trim() ? { sellerId: form.get('sellerId').trim() } : {}),
      };
      if (!credentials.clientId || !credentials.clientSecret || !credentials.refreshToken) { reply(400, 'Preencha os três campos obrigatórios.'); return; }
      await save(credentials);
      saved = true;
      reply(200, page('Credenciais protegidas', '<p class="label">SYNTHAMAZON · AMAZON BRASIL</p><h1>Credenciais protegidas</h1><p>O acesso foi salvo para seu usuário do Windows. Os valores não são exibidos aqui.</p><p>A conexão com a Amazon ainda precisa ser testada.</p>'), { 'set-cookie': `synth_setup=; Max-Age=0; HttpOnly; SameSite=Strict; Path=${route}` });
      if (autoClose) setTimeout(() => server.close(), 1000).unref();
    } catch (error) {
      reply(error?.code === 'CREDENTIALS_EXISTS' ? 409 : 500, page('Configuração não concluída', '<h1>Não foi possível salvar</h1><p>Confira se já existe um acesso configurado ou se este usuário consegue gravar o arquivo protegido. Nenhum valor de acesso foi registrado na mensagem de erro.</p>'));
    } finally { busy = false; }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.timeout = 15000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  const expiry = setTimeout(() => server.close(), 30 * 60 * 1000);
  expiry.unref();
  server.on('close', () => clearTimeout(expiry));
  return { url: `${origin}${route}`, server };
}

function page(title, content) {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)} · SynthAmazon</title><style>body{margin:0;background:#f3f6fa;color:#16233a;font:16px/1.55 system-ui,sans-serif}main{max-width:620px;margin:48px auto;padding:32px;background:white;border:1px solid #d9e1ec;border-radius:16px}h1{font-size:28px;line-height:1.2}.label{color:#275aaf;font-weight:700;font-size:12px;letter-spacing:.09em}label{display:block;margin:20px 0 6px;font-weight:650}input{box-sizing:border-box;width:100%;padding:12px;font:inherit;border:1px solid #acbace;border-radius:7px}button{margin-top:26px;padding:13px 18px;background:#2454a4;border:0;border-radius:8px;color:white;font:inherit;font-weight:650;cursor:pointer}.note{font-size:14px;color:#52627b}@media(max-width:700px){main{margin:16px;padding:22px}}</style></head><body><main>${content}</main></body></html>`;
}
