-- A customer's phone must match the number WhatsApp sends, which carries the
-- country code. Peruvian mobiles typed as nine digits were stored without 51,
-- so they never matched their conversation. A row whose 51 form already
-- exists in the business keeps its old value rather than break the unique index.
UPDATE customers
SET phone = '51' || phone
WHERE phone GLOB '9[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'
  AND NOT EXISTS (
    SELECT 1 FROM customers AS other
    WHERE other.tenant_id = customers.tenant_id
      AND other.phone = '51' || customers.phone
  );
