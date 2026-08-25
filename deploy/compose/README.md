# Astra 本地 Compose

本地依赖和控制面使用固定 Compose project `astra-local`、专用网络 `astra-local-network` 和显式 `astra-local-*` volume。默认启动 Model App 合同参考实现，不加载真实 GPU 权重，也不连接真实 Provider。

启动前先确认端口和项目归属：

`.env.local` 还必须提供 `ASTRA_LOCAL_ADMIN_BOOTSTRAP_USERNAME`、`ASTRA_LOCAL_ADMIN_BOOTSTRAP_PASSWORD`、`ASTRA_LOCAL_ADMIN_BOOTSTRAP_ORGANIZATION_ID` 和 `ASTRA_LOCAL_ADMIN_BOOTSTRAP_PROJECT_ID`。密码只在管理员不存在时初始化，数据库只保存 Argon2id 哈希。

```bash
docker compose --env-file .env.local -p astra-local -f deploy/compose/docker-compose.yml ps
docker compose --env-file .env.local -p astra-local -f deploy/compose/docker-compose.yml up -d
```

当前映射：

- Public API: `http://127.0.0.1:54100`
- Admin API: `http://127.0.0.1:54101`
- Worker Control API: `http://127.0.0.1:54102`
- Model App: `http://127.0.0.1:49000`
- Media Validator: `http://127.0.0.1:54103`
- Event Relay health/metrics: `http://127.0.0.1:54112`
- Provider Controller health/metrics: `http://127.0.0.1:54111`
- PostgreSQL: `localhost:55432`
- Redis Cluster seed: `localhost:56379`
- Redis Streams: `redis://localhost:<ASTRA_LOCAL_REDIS_PORT>`
- MinIO API/Console: `localhost:59000` / `localhost:59001`

未知进程占用端口时不要停止它；应改 `.env.local` 或 Compose 端口映射。只允许对明确属于 `astra-local` 的服务执行：

```bash
docker compose --env-file .env.local -p astra-local -f deploy/compose/docker-compose.yml down
```

事件合同测试在 `test` profile 的一次性容器中运行，以便在专用网络内连接真实 Redis Cluster 全部节点：

```bash
bun run test:integration:events
```

该命令使用临时 PostgreSQL schema、独立 Redis namespace 和 Redis Stream consumer group，结束后精确清理
临时资源；不会执行 `FLUSHALL`、复用其他项目网络或访问真实 Provider/模型。
