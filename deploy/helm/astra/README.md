# Astra Helm Chart

这是 Astra 控制面的生产 Chart。API 按 `public-api`、`admin-api`、`worker-control-api` 分成独立 Deployment、ServiceAccount、PDB 和 HPA；镜像值必须是已经解析的 OCI digest，不能在 Rollout 中使用 mutable tag。

Chart 包含：

- pre-install/pre-upgrade 数据库迁移 Job。应用不会在启动时自动迁移。
- 非 root、RuntimeDefault、只读根文件系统、禁止提权和丢弃 Linux capabilities。
- 默认拒绝入站/出站 NetworkPolicy，DNS、数据库、Redis、Kafka 和配置的 TLS 出站目标必须显式放行。
- 每个信任域独立 ServiceAccount、PDB 和 HPA；migration Job 使用单独的受限 ServiceAccount。
- 可选 ExternalSecret。生产 Secret 不写入 values 或 Git，`externalSecret.enabled=true` 时由集群 SecretStore 提供。

渲染与门禁：

```bash
helm template astra ./deploy/helm/astra \
  --set image.repository=registry.internal/astra/control-plane \
  --set image.tag=sha256:<64-hex-digest> > /tmp/astra.yaml
kubectl apply --dry-run=client -f /tmp/astra.yaml
```

Chart 模板会拒绝 `latest`、版本号或其他 mutable tag；`image.tag` 必须是完整的
`sha256:<64 位小写十六进制>`。生产值示例见
[`values.production.example.yaml`](./values.production.example.yaml)，其中不包含 Secret。

Model App GPU Deployment、Worker Agent sidecar、Provider-specific 资源不由本 Chart 自动创建；它们必须在模型
Release/Provider 合同完成后以独立 digest、ServiceAccount、NetworkPolicy 和 PDB 发布。Chart 不包含模型权重。
