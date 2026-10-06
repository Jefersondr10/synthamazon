import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.mjs';
import { Repository } from '../domain/repository.mjs';
import { startWebServer } from './server.mjs';

// Opt-in, temporary access. The normal local server and its session stay untouched.
const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const runtime = path.join(projectRoot, 'data', 'runtime');
const statePath = path.join(runtime, 'remote-access.json');
const expiresAt = process.env.SYNTHAMAZON_REMOTE_EXPIRES_AT ? Date.parse(process.env.SYNTHAMAZON_REMOTE_EXPIRES_AT) : Date.now() + 12 * 60 * 60 * 1000;
let repository, application, tunnel, expiryTimer, closing;

async function close() {
  if (closing) return closing;
  closing = (async () => {
    clearTimeout(expiryTimer);
    tunnel?.kill();
    if (application) {
      const stopped = new Promise(resolve => application.server.close(resolve));
      application.server.closeAllConnections();
      await stopped;
    }
    repository?.close();
  })();
  return closing;
}

async function freePort() {
  const reservation = net.createServer();
  await new Promise((resolve, reject) => {
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', resolve);
  });
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  return port;
}

async function openTunnel(port) {
  const binary = path.join(projectRoot, 'data', 'tools', process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
  tunnel = spawn(binary, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`, '--protocol', 'http2', '--loglevel', 'info'], {
    cwd: projectRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    let tail = '', found = false;
    const timeout = setTimeout(() => reject(new Error('Tunnel startup timed out.')), 45_000);
    const read = chunk => {
      // Info-level connector logs have no application requests, cookies or capability paths.
      process.stderr.write(chunk);
      tail = (tail + chunk.toString()).slice(-16_384);
      const match = tail.match(/https:\/\/[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com\b/);
      if (!found && match) { found = true; clearTimeout(timeout); resolve(match[0]); }
    };
    tunnel.stdout.on('data', read);
    tunnel.stderr.on('data', read);
    tunnel.once('error', error => { clearTimeout(timeout); reject(error); });
    tunnel.once('exit', () => {
      clearTimeout(timeout);
      if (!found) reject(new Error('Tunnel stopped before startup.'));
      else if (!closing) { process.exitCode = 1; close().catch(() => {}); }
    });
  });
}

try {
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + 12 * 60 * 60 * 1000) throw new TypeError('Invalid remote expiry.');
  const config = await loadConfig();
  const port = await freePort();
  const publicOrigin = await openTunnel(port);
  repository = new Repository({ rootDir: path.join(projectRoot, 'data'), dbPath: path.join(projectRoot, 'data', 'synthamazon.sqlite'), stores: [config] });
  application = await startWebServer({ repository, config, rootDir: projectRoot, port, publicOrigin, expiresAt, storeScope: config.storeId });
  await mkdir(runtime, { recursive: true });
  await writeFile(statePath, JSON.stringify({ pid: process.pid, tunnelPid: tunnel.pid, port, url: application.url, origin: publicOrigin, expiresAt: new Date(expiresAt).toISOString() }, null, 2));
  expiryTimer = setTimeout(() => close().catch(() => { process.exitCode = 1; }), Math.max(1, expiresAt - Date.now()));
  process.once('SIGINT', () => close().catch(() => { process.exitCode = 1; }));
  process.once('SIGTERM', () => close().catch(() => { process.exitCode = 1; }));
  console.log(`Acesso remoto pronto. Link privado salvo em ${statePath}`);
  console.log(`Encerramento automático: ${new Date(expiresAt).toISOString()}`);
} catch {
  console.error('Não foi possível iniciar o acesso remoto temporário.');
  process.exitCode = 1;
  await close().catch(() => {});
}
