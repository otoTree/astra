# Astra 本地 Compose

本地依赖和控制面使用固定 Compose project `astra-local`、专用网络 `astra-local-network` 和显式 `astra-local-*` volume。默认启动 Model App 合同参考实现，不加载真实 GPU 权重，也不连接真实 Provider。

启动前先确认端口和项目归属：

```bash
docker compose -p astra-local -f deploy/compose/docker-compose.yml ps
docker compose -p astra-local -f deploy/compose/docker-compose.yml up -d
```

当前映射：

- Public API: `http://127.0.0.1:54100`
- Admin API: `http://127.0.0.1:54101`
- Worker Control API: `http://127.0.0.1:54102`
- Model App: `http://127.0.0.1:49000`
- PostgreSQL: `localhost:55432`
- Redis Cluster seed: `localhost:56379`
- Kafka-compatible Redpanda: `localhost:59092`
- MinIO API/Console: `localhost:59000` / `localhost:59001`

未知进程占用端口时不要停止它；应改 `.env.local` 或 Compose 端口映射。只允许对明确属于 `astra-local` 的服务执行：

```bash
docker compose -p astra-local -f deploy/compose/docker-compose.yml down
```
