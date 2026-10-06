import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ProductCostReader } from './domain/product-costs.mjs';
import { ensureProductCostSchema, syncOrderCosts } from './domain/order-cost-ledger.mjs';
const root=fileURLToPath(new URL('../data/',import.meta.url));
const db=new DatabaseSync(path.join(root,'synthamazon.sqlite'));
try {
  db.exec('PRAGMA busy_timeout=10000;');
  ensureProductCostSchema(db);
  const result=syncOrderCosts(db,new ProductCostReader(root,db).read());
  console.log(JSON.stringify(result));
  if (result.skipped) process.exitCode=1;
} catch { console.error('PRODUCT_COST_SYNC_FAILED');process.exitCode=1; }
finally { db.close(); }
