# Database migrations

SQL 迁移按文件名顺序由 `bun run db:migrate` 执行，并在 `schema_migrations` 中保存 SHA-256；已执行文件发生变化时拒绝继续。生产迁移由独立 migration Job 执行，应用启动时只校验 schema version，不自动执行迁移。

迁移必须遵循 `expand -> backfill -> contract`，为大表写明锁、批量大小、回滚和监控。`src/schema.ts` 是 Drizzle schema 边界，`drizzle/*.sql` 是可执行数据库变更记录；本地与生产使用同一个迁移运行器。
