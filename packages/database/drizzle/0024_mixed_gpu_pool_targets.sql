ALTER TABLE model_pools ADD COLUMN gpu_targets jsonb NOT NULL DEFAULT '[]'::jsonb;

UPDATE model_pools
SET gpu_targets = jsonb_build_array(jsonb_build_object(
  'provider', provider,
  'region_id', region_id,
  'gpu_sku', gpu_sku
))
WHERE gpu_targets = '[]'::jsonb;

ALTER TABLE model_pools
  ADD CONSTRAINT model_pools_gpu_targets_array CHECK (jsonb_typeof(gpu_targets) = 'array');
