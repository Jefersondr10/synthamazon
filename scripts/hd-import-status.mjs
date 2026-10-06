import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const db = new DatabaseSync(fileURLToPath(new URL('../data/synthamazon.sqlite', import.meta.url)), { readOnly:true });
try {
  const progress = JSON.parse(await readFile(new URL('../data/hd-comercio/history-import-status.json', import.meta.url),'utf8'));
  let running = false;
  if (Number.isSafeInteger(progress.pid) && progress.pid > 0) {
    try { process.kill(progress.pid,0); running = true; } catch {}
  }
  console.log(JSON.stringify({
    running, status:progress.status, lastSteps:progress.steps.slice(-3),
    entities:db.prepare('SELECT store_id AS store,source,count(*) AS records FROM entities WHERE active=1 GROUP BY store_id,source').all(),
    refunds:db.prepare('SELECT store_id AS store,count(*) AS orders FROM refund_management GROUP BY store_id').all(),
    reports:db.prepare("SELECT report_type,status,error_code,count(*) AS jobs FROM customer_return_report_jobs WHERE store_id='hd-comercio' GROUP BY report_type,status,error_code").all(),
  },null,2));
} finally { db.close(); }
