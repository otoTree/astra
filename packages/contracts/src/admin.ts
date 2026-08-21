import { z } from "zod";

export const adminRoleSchema = z.enum(["viewer", "operator", "model_releaser", "security_auditor", "admin"]);

export const adminSessionExchangeSchema = z
  .object({
    organization_id: z.string().min(1).max(128),
    project_id: z.string().min(1).max(128),
  })
  .strict();

export const adminSessionSchema = z
  .object({
    id: z.string().min(1),
    object: z.literal("admin.session"),
    organization_id: z.string().min(1),
    project_id: z.string().min(1),
    subject: z.string().min(1),
    display_name: z.string().nullable(),
    email: z.string().email().nullable(),
    organization_roles: z.array(adminRoleSchema),
    project_roles: z.array(adminRoleSchema),
    permissions: z.array(z.string()),
    csrf_token: z.string().min(32).optional(),
    created_at: z.number().int().nonnegative(),
    expires_at: z.number().int().nonnegative(),
  })
  .strict();

export const sensitiveTaskRequestSchema = z
  .object({
    task_id: z.string().min(1),
    request: z.record(z.string(), z.unknown()),
    accessed_at: z.number().int().nonnegative(),
  })
  .strict();

export const adminListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    after: z.string().min(1).max(4096).optional(),
  })
  .strict();

export const versionedMutationSchema = z
  .object({
    expected_version: z.number().int().nonnegative(),
    reason: z.string().min(8).max(1000),
  })
  .strict();

export const releaseCreateSchema = z
  .object({
    model_id: z.string().min(1),
    source_image: z.string().min(1),
    workflow_hash: z.string().regex(/^[0-9a-f]{64}$/),
    manifest: z.record(z.string(), z.unknown()),
    reason: z.string().min(8).max(1000),
  })
  .strict();

export const policyValidationSchema = z
  .object({
    policy_type: z.enum(["capacity", "budget", "region", "retry"]),
    pool_id: z.string().min(1),
    configuration: z.record(z.string(), z.unknown()),
  })
  .strict();

export const rolloutCreateSchema = z
  .object({
    release_id: z.string().min(1),
    pool_id: z.string().min(1),
    preview_id: z.string().min(1),
    expected_pool_version: z.number().int().nonnegative(),
    reason: z.string().min(8).max(1000),
  })
  .strict();
