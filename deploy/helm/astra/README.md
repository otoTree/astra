# Astra Helm 骨架

这是生产 Kubernetes Chart 的边界骨架。API 按 `public-api`、`admin-api`、`worker-control-api` 分成独立 Deployment；镜像值必须是已经解析的 OCI digest，不能在 Rollout 中使用 mutable tag。

数据库迁移、Model App GPU Deployment、Worker Agent sidecar、Secret/ExternalSecret、NetworkPolicy allowlist、HPA 和 Provider-specific 资源应在对应 Release 实现后补齐，并经过 `helm template`、非 root、SBOM、漏洞和故障演练检查。
