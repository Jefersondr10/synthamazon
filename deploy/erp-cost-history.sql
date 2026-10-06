-- Passive cost history. Does not change stock, products or financial entries.
-- Run with psql -v company=<the configured ERP company>.
BEGIN;
CREATE SCHEMA IF NOT EXISTS synthamazon_costs;
REVOKE ALL ON SCHEMA synthamazon_costs FROM PUBLIC;
CREATE TABLE IF NOT EXISTS synthamazon_costs.companies (company_id text PRIMARY KEY);
INSERT INTO synthamazon_costs.companies VALUES (:'company') ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS synthamazon_costs.history (
  company_id text NOT NULL, product_id text NOT NULL, stock_version bigint NOT NULL,
  effective_at timestamptz NOT NULL DEFAULT clock_timestamp(), unit_cost numeric(30,10),
  PRIMARY KEY(company_id,product_id,stock_version)
);
CREATE OR REPLACE FUNCTION synthamazon_costs.capture() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE price numeric(30,10); previous_price numeric(30,10);
BEGIN
  IF NOT EXISTS (SELECT 1 FROM synthamazon_costs.companies WHERE company_id=NEW.company_id) THEN RETURN NEW; END IF;
  price := CASE WHEN NEW.quantity>0 THEN round(NEW.value/NEW.quantity,10) WHEN NEW.initialized THEN NEW.last_cost ELSE NULL END;
  IF TG_OP='UPDATE' THEN
    previous_price := CASE WHEN OLD.quantity>0 THEN round(OLD.value/OLD.quantity,10) WHEN OLD.initialized THEN OLD.last_cost ELSE NULL END;
    IF price IS NOT DISTINCT FROM previous_price THEN RETURN NEW; END IF;
  END IF;
  INSERT INTO synthamazon_costs.history(company_id,product_id,stock_version,unit_cost)
    VALUES(NEW.company_id,NEW.product_id,NEW.version,price) ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION synthamazon_costs.capture() FROM PUBLIC;
DROP TRIGGER IF EXISTS synthamazon_capture_cost ON public.stock_balances;
CREATE TRIGGER synthamazon_capture_cost AFTER INSERT OR UPDATE ON public.stock_balances
  FOR EACH ROW EXECUTE FUNCTION synthamazon_costs.capture();
INSERT INTO synthamazon_costs.history(company_id,product_id,stock_version,unit_cost)
 SELECT s.company_id,s.product_id,s.version,
   CASE WHEN s.quantity>0 THEN round(s.value/s.quantity,10) WHEN s.initialized THEN s.last_cost ELSE NULL END
 FROM public.stock_balances s WHERE s.company_id=:'company'
 AND NOT EXISTS (SELECT 1 FROM synthamazon_costs.history h WHERE h.company_id=s.company_id AND h.product_id=s.product_id)
 ON CONFLICT DO NOTHING;
COMMIT;
