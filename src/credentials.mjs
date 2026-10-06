import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultVaultPath = fileURLToPath(new URL('../data/credentials/origem-comercio.dpapi', import.meta.url));
const scriptPath = fileURLToPath(new URL('../scripts/dpapi.py', import.meta.url));
const MAX_BLOB_BYTES = 1024 * 1024;
const requiredFields = ['clientId', 'clientSecret', 'refreshToken'];
const allowedFields = [...requiredFields, 'sellerId'];

function failure(code = 'CREDENTIALS_UNAVAILABLE') {
  const messages = {
    INVALID_CREDENTIALS: 'Os campos de acesso informados são inválidos.',
    CREDENTIALS_NOT_FOUND: 'O acesso protegido ainda não foi configurado.',
    CREDENTIALS_EXISTS: 'Já existe uma configuração protegida. A substituição deve ser explícita.',
    CREDENTIALS_BUSY: 'Outra gravação do acesso protegido está em andamento.',
    CREDENTIALS_UNAVAILABLE: 'Não foi possível acessar a configuração protegida neste usuário do Windows.',
  };
  return Object.assign(new Error(messages[code]), { code });
}

function validateCredentials(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowedFields.includes(key))) {
    throw failure('INVALID_CREDENTIALS');
  }
  const credentials = {};
  for (const key of allowedFields) {
    const value = input[key];
    if (key === 'sellerId' && (value === undefined || value === null || value === '')) continue;
    if (typeof value !== 'string' || !value.trim() || value.length > 16_384 || /[\u0000-\u001f\u007f]/u.test(value.trim())) {
      throw failure('INVALID_CREDENTIALS');
    }
    credentials[key] = value.trim();
  }
  return credentials;
}

function resolveVault(value) {
  if (value === undefined) return defaultVaultPath;
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw failure('INVALID_CREDENTIALS');
  return path.resolve(value);
}

async function existingFile(filename) {
  try {
    const info = await lstat(filename);
    if (!info.isFile() || info.isSymbolicLink()) throw failure();
    return info;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw failure();
  }
}

function dpapi(mode, input) {
  if (process.platform !== 'win32') return Promise.reject(failure());
  return new Promise((resolve, reject) => {
    let settled = false;
    let output = '';
    let outputBytes = 0;
    let timer;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(failure());
      else resolve(result);
    };
    // Keep credentials out of command arguments, inherited environment and stderr.
    const env = {};
    for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'ProgramData']) {
      if (process.env[key]) env[key] = process.env[key];
    }
    const python = 'C:\\Python314\\python.exe';
    let child;
    try {
      child = spawn(python, ['-I', scriptPath, '--mode', mode], {
        windowsHide: true,
        shell: false,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      finish(true);
      return;
    }
    timer = setTimeout(() => { child.kill(); finish(true); }, 30_000);
    child.on('error', () => finish(true));
    child.stdin.on('error', () => { child.kill(); finish(true); });
    child.stderr.resume();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      outputBytes += Buffer.byteLength(chunk, 'utf8');
      if (outputBytes > MAX_BLOB_BYTES) { child.kill(); finish(true); return; }
      output += chunk;
    });
    child.on('close', code => {
      if (code !== 0 || !output.trim()) { finish(true); return; }
      finish(false, output.trim());
    });
    child.stdin.end(input, 'utf8');
  });
}

/** Protects access for the current Windows user. Existing vaults require allowReplace. */
export async function protectCredentials(input, { vaultPath, allowReplace = false } = {}) {
  const credentials = validateCredentials(input);
  const target = resolveVault(vaultPath);
  if (typeof allowReplace !== 'boolean') throw failure('INVALID_CREDENTIALS');
  const encrypted = await dpapi('protect', JSON.stringify(credentials));
  if (!/^[a-f0-9]+$/i.test(encrypted)) throw failure();
  const directory = path.dirname(target);
  const lockPath = `${target}.lock`;
  const temporary = path.join(directory, `.${path.basename(target)}.${randomUUID()}.tmp`);
  let lock;
  let tempFile;
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      lock = await open(lockPath, 'wx', 0o600);
    } catch (error) {
      if (error.code === 'EEXIST') throw failure('CREDENTIALS_BUSY');
      throw error;
    }
    if (await existingFile(target) && !allowReplace) throw failure('CREDENTIALS_EXISTS');
    tempFile = await open(temporary, 'wx', 0o600);
    await tempFile.writeFile(`${encrypted}\n`, 'utf8');
    await tempFile.sync();
    await tempFile.close();
    tempFile = undefined;
    // The exclusive lock serializes writers; rename publishes only complete ciphertext.
    await rename(temporary, target);
    return { vaultPath: target };
  } catch (error) {
    if (['CREDENTIALS_EXISTS', 'CREDENTIALS_BUSY'].includes(error.code)) throw failure(error.code);
    throw failure();
  } finally {
    await tempFile?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    if (lock) {
      await lock.close().catch(() => {});
      await unlink(lockPath).catch(() => {});
    }
  }
}

/** Returns credentials in memory; no plaintext is persisted or logged. */
export async function loadCredentials({ vaultPath } = {}) {
  const target = resolveVault(vaultPath);
  try {
    const info = await existingFile(target);
    if (!info) throw failure('CREDENTIALS_NOT_FOUND');
    if (info.size === 0 || info.size > MAX_BLOB_BYTES) throw failure();
    const encrypted = (await readFile(target, 'utf8')).trim();
    if (!/^[a-f0-9]+$/i.test(encrypted)) throw failure();
    const plaintext = await dpapi('unprotect', encrypted);
    return validateCredentials(JSON.parse(plaintext));
  } catch (error) {
    if (error.code === 'CREDENTIALS_NOT_FOUND') throw failure(error.code);
    throw failure();
  }
}
