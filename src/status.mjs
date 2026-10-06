import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export async function readPilotStatus({ rootDir, storeId }) {
  if (typeof storeId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(storeId)) throw new Error('Loja inválida.');
  const directory = path.join(rootDir, storeId, 'runs');
  let filenames;
  try { filenames = await readdir(directory); } catch (error) { if (error.code === 'ENOENT') return { lastSuccessfulApiReadAt: null, sources: [] }; throw error; }
  const bySource = new Map();
  for (const filename of filenames) {
    if (!/^[0-9a-f-]{36}\.json$/.test(filename)) continue;
    let run;
    try { run = JSON.parse(await readFile(path.join(directory, filename), 'utf8')); } catch { continue; }
    if (run.storeId !== storeId || !Array.isArray(run.sources)) continue;
    for (const source of run.sources) {
      if (source.status !== 'api-pages-complete' || !Array.isArray(source.pages) || !source.pages.length || !Number.isFinite(Date.parse(source.finishedAt))) continue;
      const previous = bySource.get(source.source);
      if (!previous || Date.parse(source.finishedAt) > Date.parse(previous.lastSuccessfulApiReadAt)) {
        bySource.set(source.source, { source: source.source, lastSuccessfulApiReadAt: source.finishedAt });
      }
    }
  }
  const sources = [...bySource.values()];
  const dates = sources.map(source => source.lastSuccessfulApiReadAt).sort();
  return { lastSuccessfulApiReadAt: dates.at(-1) ?? null, sources };
}
