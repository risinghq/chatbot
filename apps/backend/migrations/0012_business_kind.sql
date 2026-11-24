-- What a business sells. It shapes the catalog forms (sizes and colours for
-- clothing, weights for food). Null until the owner answers the welcome step.
ALTER TABLE tenants ADD COLUMN business_kind TEXT
    CHECK(business_kind IN ('clothing', 'electronics', 'food', 'hardware', 'beauty', 'other'));
