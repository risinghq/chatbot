-- SQLite cannot change a CHECK in place, so the column is rebuilt with the
-- wider list: accessories, pets and services join the kinds of 0012.
ALTER TABLE tenants ADD COLUMN business_kind_next TEXT
    CHECK(business_kind_next IN ('clothing', 'accessories', 'beauty', 'electronics', 'pets', 'food', 'hardware', 'services', 'other'));
UPDATE tenants SET business_kind_next = business_kind;
ALTER TABLE tenants DROP COLUMN business_kind;
ALTER TABLE tenants RENAME COLUMN business_kind_next TO business_kind;
