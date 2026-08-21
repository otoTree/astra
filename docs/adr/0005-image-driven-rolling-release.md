# ADR-0005：镜像地址驱动的逐机滚动发布

- 状态：Accepted
- 日期：2026-08-19

## 背景

模型以容器镜像交付。运维希望在后台填写模型镜像地址后，由平台自动把每台 GPU 机器逐步更新到新镜像，而不是手工录入工作流、权重哈希或逐台操作供应商资源。

## 决策

- Admin Web 以模型 Alias、镜像地址、目标池和滚动参数作为主要发布输入。
- 平台提交时将 tag 解析为 OCI digest，并从镜像读取 Release Manifest；同一次 Release/Rollout 永远使用固定 digest。
- 先启动探测 Replica 核对签名、Manifest、Worker Contract、capabilities、健康和最小推理。
- 默认 `max_surge=1`、`max_unavailable=0`、`batch_size=1`，逐台执行创建/更新、就绪、排空旧实例和继续。
- Provider 支持单机更新时原地替换；不支持时以逐台蓝绿替换提供相同语义。
- 通过共绩 Provider Adapter 先预热固定 digest；预热 Replica 在 readiness、capabilities 和 smoke 校验通过前不接收公共任务。
- 新 Release 接管新建 Task 后，旧 Release 设置 `accept_new_tasks=false`；切换前已创建的旧 Task 仍可在旧 Worker 上排空。旧队列清零后关闭 `accept_existing_tasks`，旧 Worker 通过 `drained` 回报确认任务和租约归零，Provider Controller 再幂等回收旧 Replica。
- 任一机器验证失败时自动暂停。回滚使用上一稳定 digest 执行反向滚动。
- 多容器环境只更新 Model App；单镜像供应商使用包含 Agent 与 Model App 的 bundle image。

## 结果

运维流程保持为“填写镜像地址并确认滚动”，同时平台拥有可复现 digest、逐机状态、容量保护和失败暂停。默认策略需要临时多一台 GPU；预算不允许时可以显式接受一台不可用的滚动方式。

## 未选择方案

- 每台机器在后台手工更新：不可审计、容易版本漂移，也无法自动暂停和回滚。
- 所有机器同时更新：速度快，但会造成整体不可用并放大坏镜像风险。
- 运行时始终拉取 mutable tag：同一 Rollout 可能得到不同镜像，无法复现或可靠回滚。
