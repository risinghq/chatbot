-- Which variants a photo shows. A photo of the red polo shows every size in
-- red. A photo with no rows here shows the product as a whole and goes with
-- every variant. The service checks the variant and the photo share a product.
CREATE TABLE product_image_variants (
    image_id TEXT NOT NULL REFERENCES product_images(id) ON DELETE CASCADE,
    variant_id TEXT NOT NULL,
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    PRIMARY KEY (image_id, variant_id),
    FOREIGN KEY (variant_id, tenant_id)
        REFERENCES product_variants(id, tenant_id) ON DELETE CASCADE
);

CREATE INDEX idx_product_image_variants_variant
    ON product_image_variants(tenant_id, variant_id);
