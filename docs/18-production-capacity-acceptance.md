# 生产容量与安全验收

本文档是阶段 13 的执行清单。它验证控制面和 Worker/Provider 合同，不要求下载模型权重或执行真实 H3/10Eros 推理。

## Helm 与供应链门

```bash
helm template astra deploy/helm/astra \
  --set image.repository=registry.internal/astra/control-plane \
  --set image.tag=sha256:<64-hex-digest> > /tmp/astra-rendered.yaml
kubectl apply --dry-run=client -f /tmp/astra-rendered.yaml
```

- 所有第一方镜像使用固定 digest；mutable tag 在 CI 直接失败。
- 容器 `runAsNonRoot=true`、RuntimeDefault、只读根文件系统、禁止提权、drop `ALL` capabilities。
- 三 API、Scheduler、Provider Controller、Event Relay 使用独立 Deployment/ServiceAccount；PDB 至少保留一个副本。
- 数据库迁移只通过 pre-install/pre-upgrade Job，应用启动不自动迁移。
- ExternalSecret 默认关闭；生产启用后 Secret 只来自 SecretStore，不进入 values/Git/日志。
- 默认拒绝 NetworkPolicy 后，三个 API 按信任域/端口分别放行；控制面指标只允许观测命名空间；DNS、PostgreSQL、Redis Streams、S3、Provider 和监控端点必须显式配置。Model App 无外网。
- CI 生成 SBOM、签名、漏洞报告并在准入层验证 digest、签名和严重漏洞阈值。
- 生产手动工作流 `.github/workflows/production-supply-chain.yml` 以外部镜像 digest 为输入，输出 `astra-sbom.cdx.json` 和 `astra-trivy.sarif`，并要求部署方提供 Cosign 公钥；工作流不构建、不下载模型权重。

## 故障验收

| 演练 | 预期结果 |
| --- | --- |
| PostgreSQL 主从切换 | Task/Attempt/Lease/审计连续；应用只校验 schema 版本，不执行隐式迁移 |
| Redis 全量丢失 | 从 PostgreSQL 重建 generation；不重复领取，不丢 queued Task |
| Redis Streams 延迟/重复/乱序 | Outbox 保留，Consumer 按事件 ID 去重，状态仍由 PostgreSQL 决定 |
| Worker 失联 | 先 `unknown`，等待 orphan grace；可恢复则续租，否则按 Retry Policy 回队 |
| Provider 超时 | operation key reconcile；不因响应丢失创建重复实例 |
| S3 上传失败 | 文件保持可重试状态；Task 不伪造 completed |
| Rollout 与缩容并发 | Rollout 暂停普通缩容；运行 Attempt 完成后才 drain/reclaim |

## 10-50 GPU 容量验收

以参考 Model App 和可重复媒体产物进行控制面压测，不执行真实模型：

1. 10、25、50 个单槽 Replica，分别注入 4/8/12/15 秒视频的服务时间基线和图片任务。
2. 注入 300 个并发 Task，验证 Scheduler 在 PostgreSQL CAS 下无重复 Attempt/Lease，批量最低份额和项目 GPU 时间公平成立。
3. 逐步停止空闲 Replica，验证空闲窗口 15 分钟、缩容冷却 20 分钟、迟滞和 Rollout 保护；运行任务不能被终止。
4. 将库存设为 0、价格变化、预算封顶和区域故障，验证 Capacity Plan 记录可解释抑制和 Admission Control，不无限排队。
5. 观察 API P95、Scheduler 循环耗时、Capacity Plan backlog、Outbox age、Redis rebuild、Worker lease expiry、Provider reconcile 和 S3 错误。

验收报告至少记录：输入快照、策略版本、计划 ID、期望/实际副本、队列 P50/P95、GPU 秒、成本、收益、抑制原因、错误率、恢复时间和残余风险。

## 权重边界

该验收目录不得出现 `.safetensors`、`.ckpt`、`.pt`、`.pth`、`.gguf`、`.onnx` 等权重文件；Release 只登记镜像 digest、工作流 hash、权重 hash/大小元数据。真实镜像、权重、GPU 推理与质量批准由人类模型团队在隔离环境完成。
