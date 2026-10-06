import { readFile } from 'node:fs/promises';

export const configUrl = new URL('../config/pilot.json', import.meta.url);
const safeId = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function monitorIntervalMinutes(config = {}) {
  const minutes = config.plannedSyncMinutes ?? 15;
  if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > 1440) {
    throw Object.assign(new Error('Intervalo de coleta inválido.'), { code: 'INVALID_CONFIG' });
  }
  return minutes;
}

export async function loadConfig(url = configUrl) {
  const config = JSON.parse(await readFile(url, 'utf8'));
  if (typeof config.storeId !== 'string' || !safeId.test(config.storeId) || config.marketplaceId !== 'A2Q3Y263D00KWC' || config.region !== 'NA') {
    throw new Error('Configuração de loja ou marketplace inválida para este piloto Brasil.');
  }
  if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(config.credentialEnvPrefix)) throw new Error('Prefixo de configuração inválido.');
  monitorIntervalMinutes(config);
  return config;
}

export function getCredentials(config, env = process.env) {
  const keys = { clientId: 'CLIENT_ID', clientSecret: 'CLIENT_SECRET', refreshToken: 'REFRESH_TOKEN' };
  const credentials = {};
  const missing = [];
  for (const [property, suffix] of Object.entries(keys)) {
    const name = `${config.credentialEnvPrefix}_${suffix}`;
    const value = env[name]?.trim();
    if (!value) missing.push(name);
    else credentials[property] = value;
  }
  if (env[`${config.credentialEnvPrefix}_SELLER_ID`]?.trim()) credentials.sellerId = env[`${config.credentialEnvPrefix}_SELLER_ID`].trim();
  return { credentials, missing };
}

export function makeWindow({ from, to, now = new Date(), historyStart }) {
  // A folga de cinco minutos atende às APIs que exigem uma data anterior em pelo menos dois minutos.
  const safeEnd = new Date(now.getTime() - 5 * 60 * 1000);
  const start = from ? parseInstant(from) : new Date(Math.max(new Date(historyStart).getTime(), safeEnd.getTime() - 7 * 86400000));
  const end = to ? parseInstant(to) : safeEnd;
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start >= end) throw new Error('Período inválido: início deve ser anterior ao fim.');
  if (start < new Date(historyStart)) throw new Error('O piloto começa em 01/01/2026.');
  if (end > safeEnd) throw new Error('Fim do período deve ficar pelo menos cinco minutos antes do horário atual.');
  if (end - start > 30 * 86400000) throw new Error('Use uma janela de até 30 dias por execução do piloto.');
  return { from: start.toISOString(), to: end.toISOString() };
}

function parseInstant(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) {
    throw new Error('Use data e horário completos com fuso, por exemplo 2026-01-01T00:00:00-03:00.');
  }
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  const maxDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (month < 1 || month > 12 || day < 1 || day > maxDay || hour > 23 || minute > 59 || second > 59) throw new Error('Data ou horário inexistente.');
  return new Date(value);
}
