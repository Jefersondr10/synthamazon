"""Publish a minimal, atomic, read-only cost snapshot from the existing ERP."""
import json, os, pathlib, re, subprocess, tempfile

ROOT = pathlib.Path('/docker/synthamazon')
CONFIG = ROOT / 'config/erp-costs.json'
TARGET = ROOT / 'data/erp-costs.json'

SQL = r"""
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout='20s';
SELECT json_build_object('version',1,'exportedAt',to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'companyId',c.id,'companyName',c.name,'storeIds',:'stores'::json,
 'products',(SELECT coalesce(json_agg(x),'[]') FROM (
   SELECT p.id,p.sku,p.name,CASE WHEN s.quantity>0 THEN round(s.value/s.quantity,10)::text
     WHEN s.initialized THEN s.last_cost::text ELSE NULL END AS "averageCost"
   FROM products p LEFT JOIN stock_balances s ON s.company_id=p.company_id AND s.product_id=p.id
   WHERE p.company_id=c.id AND p.deleted_at IS NULL ORDER BY p.id) x),
 'links',(SELECT coalesce(json_agg(x),'[]') FROM (
   SELECT store_id AS "storeId",seller_sku AS "sellerSku",product_id AS "productId"
   FROM amazon_fba_product_links WHERE company_id=c.id AND store_id IN (SELECT json_array_elements_text(:'stores'::json))
   ORDER BY store_id,seller_sku) x),
 'costHistory',(SELECT coalesce(json_agg(x),'[]') FROM (
   SELECT product_id AS "productId",stock_version AS "version",unit_cost::text AS "unitCost",
     to_char(effective_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "effectiveAt"
   FROM synthamazon_costs.history WHERE company_id=c.id ORDER BY product_id,effective_at,stock_version) x))
FROM companies c WHERE c.id=:'company';
ROLLBACK;
"""

def export():
    config = json.loads(CONFIG.read_text())
    company = config['companyId']
    stores = config['storeIds']
    assert re.fullmatch(r'[A-Za-z0-9_-]{1,128}', company)
    assert stores and len(stores) == len(set(stores)) and all(re.fullmatch(r'[a-z0-9-]{1,64}', s) for s in stores)
    # Fail closed if the existing connection is reassigned to another company.
    current = subprocess.check_output(['docker','exec','estoque_producao-app-1','node','-e',
        'process.stdout.write(process.env.AMAZON_FBA_COMPANY_ID || "")'], text=True, timeout=15).strip()
    assert current == company, 'ERP company configuration changed'
    args = ['docker','exec','-i','estoque_producao-postgres-1','psql','-X','-qAt','-v','ON_ERROR_STOP=1',
        '-v','company='+company,'-v','stores='+json.dumps(stores),'-U','erp_owner','-d','erp']
    result = subprocess.run(args,input=SQL,text=True,capture_output=True,timeout=35)
    if result.returncode: raise RuntimeError('ERP cost query failed')
    snapshot = json.loads(result.stdout)
    assert snapshot['companyId'] == company and snapshot['storeIds'] == stores
    payload = json.dumps(snapshot,ensure_ascii=False,separators=(',',':')).encode()
    assert len(payload) <= 20_000_000
    fd, name = tempfile.mkstemp(prefix='.erp-costs-', dir=TARGET.parent)
    try:
        with os.fdopen(fd,'wb') as output:
            output.write(payload); output.flush(); os.fsync(output.fileno())
        os.chown(name,1000,1000); os.chmod(name,0o600)
        os.replace(name,TARGET)
    finally:
        if os.path.exists(name): os.unlink(name)
    print(json.dumps({'products':len(snapshot['products']),'links':len(snapshot['links']),
        'costHistoryEntries':len(snapshot['costHistory']),'stores':len(stores),'exportedAt':snapshot['exportedAt']}))

if __name__ == '__main__':
    try: export()
    except Exception as error:
        print('Cost export failed; previous snapshot preserved ('+type(error).__name__+').')
        raise SystemExit(1)
