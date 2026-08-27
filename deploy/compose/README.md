# Astra 本地 Compose

本地依赖和控制面使用固定 Compose project `astra-local`、专用网络 `astra-local-network` 和显式 `astra-local-*` volume。默认启动 Model App 合同参考实现，不加载真实 GPU 权重，也不连接真实 Provider。

启动前先确认端口和项目归属：

`.env.local` 还必须提供 `ASTRA_LOCAL_ADMIN_BOOTSTRAP_USERNAME`、`ASTRA_LOCAL_ADMIN_BOOTSTRAP_PASSWORD`、`ASTRA_LOCAL_ADMIN_BOOTSTRAP_ORGANIZATION_ID`、`ASTRA_LOCAL_ADMIN_BOOTSTRAP_PROJECT_ID` 和独立的 256-bit `ASTRA_LOCAL_PROVIDER_CREDENTIAL_ENCRYPTION_KEY`。密码只在管理员不存在时初始化，数据库只保存 Argon2id 哈希。该凭证加密密钥必须跨重启保持不变；更换它之前必须先轮换或迁移已加密的 Provider Token。

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

## 四镜像测试部署

使用仓库外 PostgreSQL、Redis 和 S3 的集成测试环境可以把控制面收敛为四个长期运行的部署单元：

1. `astra-control-plane` 使用 `bun run scripts/run-local-control-plane-bundle.ts`，在一个容器中监管 Public API、Admin API、Worker Control API、Scheduler、Provider Controller、Event Relay 和 File Sweeper；统一入口 `CONTROL_PLANE_PORT=8080` 按 `/v1`、`/admin/v1`、`/internal/v1` 转发到三个隔离 API 进程。
2. `astra-media-validator` 只在内部网络监听 `4113`。
3. `astra-admin-web` 在 `8080` 提供页面。同源模式通过 `ADMIN_API_URL=http://astra-control-plane:4101` 代理 `/admin/v1`；Web 与 API 分域时设置 `ADMIN_API_PUBLIC_URL=https://<admin-api-domain>`，浏览器直接访问 Admin API。
4. `astra-h3-worker-bundle` 不开放入站端口，主动连接 Control Plane 的 Worker Control API。

Bundle 只允许 `ASTRA_ENV=local` 或 `test`。数据库迁移、测试调用方身份和测试 Worker 预登记均为显式开关：

```text
ASTRA_BUNDLE_RUN_MIGRATIONS=true
ASTRA_BUNDLE_BOOTSTRAP_IDENTITY=true
ASTRA_BUNDLE_BOOTSTRAP_WORKER=true
```

分域测试部署还必须在 Control Plane 设置 `ADMIN_WEB_ORIGIN=https://<admin-web-domain>` 和 `ADMIN_COOKIE_SAME_SITE=none`。CORS 只返回该精确 Origin 并允许凭证，不能设置为 `*`；两个域名都必须使用 HTTPS。

若外部测试 Redis 是单主/Sentinel 而非 Redis Cluster，Control Plane 必须显式设置
`REDIS_MODE=standalone`。生产和仓库默认 Compose 保持 `REDIS_MODE=cluster`。

生产环境仍使用独立信任域 Deployment 和独立凭证；不得把测试 Bundle 作为生产控制面启动方式。

本地/测试 Bundle 可以提供 `ASTRA_LOCAL_PROVIDER_CREDENTIAL_ENCRYPTION_KEY`，启动器会在拉起子进程前将它规范化为 `PROVIDER_CREDENTIAL_ENCRYPTION_KEY`；拆分部署和生产 External Secret 必须直接提供正式变量名。两者是同一用途的部署级 Secret，不得写入镜像、ConfigMap、日志或 Git。可以使用 `openssl rand -hex 32` 生成；部署后不能随 Pod 重建重新生成。
