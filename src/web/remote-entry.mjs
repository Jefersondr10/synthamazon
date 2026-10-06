import { randomBytes } from 'node:crypto';

export function remoteEntry(response, { status = 200, available = false, used = false, expired = false } = {}) {
  const nonce = randomBytes(18).toString('base64');
  response.setHeader('Content-Security-Policy', `default-src 'none'; style-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`);
  // Form POSTs need their real Origin. no-referrer makes browsers send Origin: null.
  // same-origin still prevents the secret entry path from reaching external sites.
  response.setHeader('Referrer-Policy', 'same-origin');
  const message = expired ? 'Este acesso temporário expirou. Solicite um novo link no computador principal.'
    : used ? 'Este link já foi ativado em outro navegador. Continue naquele navegador ou solicite um novo link no computador principal.'
      : available ? 'Confirme abaixo para abrir o sistema neste navegador.'
        : 'Abra o link de acesso completo recebido no computador principal.';
  const html = `<!doctype html><html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>SynthAmazon · Acesso ao sistema</title>
<style nonce="${nonce}">*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:#17181a;color:#f5f5f5;font:16px/1.6 system-ui,sans-serif}main{width:min(100%,480px);padding:36px;border:1px solid #424449;border-radius:18px;background:#232529}h1{font-size:28px;margin:6px 0 16px}p{color:#bdc0c7}.brand{color:#f5c461;font-weight:700;letter-spacing:.08em;font-size:13px}button{width:100%;margin-top:18px;padding:14px 20px;border:0;border-radius:9px;background:#f5c461;color:#211b10;font:700 16px system-ui;cursor:pointer}button:focus-visible{outline:3px solid white;outline-offset:4px}.note{font-size:13px;margin:20px 0 0}</style></head>
<body><main><div class="brand">SYNTHAMAZON</div><h1>${expired ? 'Acesso expirado' : available ? 'Acesso ao sistema' : 'Acesso protegido'}</h1><p>${message}</p>
${available ? '<form method="post"><button name="confirm" value="enter" type="submit">Entrar no sistema</button></form><p class="note">Acesso temporário. O computador principal precisa permanecer ligado e conectado.</p>' : ''}
</main></body></html>`;
  response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html) });
  response.end(html);
}

export async function confirmRemoteEntry(request) {
  if (!/^application\/x-www-form-urlencoded(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) return false;
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 128) return false;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8') === 'confirm=enter';
}
