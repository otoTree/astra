# 灾难恢复与演练手册

本手册只覆盖 Astra 控制面、数据库、事件系统、对象存储和 Worker 租约。模型镜像与权重属于人类模型团队管理的外部发布资产；恢复平台时不下载权重、不启动真实推理。

## 恢复目标

| 组件 | RPO | RTO | 权威事实 |
| --- | ---: | ---: | --- |
| PostgreSQL | 5 分钟 | 30 分钟 | Task、Attempt、Lease、策略、发布、Capacity Plan、审计 |
| S3 | 24 小时内输入/产物按生命周期保留 | 30 分钟 | 文件与产物字节 |
| Redis Cluster | 允许丢失 | 15 分钟 | PostgreSQL 可重建候选/限流索引 |
| Redis Streams | 允许延迟或重放 | 30 分钟 | PostgreSQL Outbox 可重放事件 |

## 恢复顺序

1. 冻结公共创建入口和 Capacity Plan 写循环，保留查询、健康与管理只读入口。
2. 恢复 KMS/Secret Manager、ExternalSecret 和 PostgreSQL 主库；校验 `schema_migrations` checksum，不执行降级迁移。
3. 以只读方式启动三类 API，验证组织/项目隔离、Task 状态和最近审计记录。
4. 启动 Provider Controller 的只读观察；按 `(provider, region, provider_resource_id)` 对账既有实例，禁止先扩容。
5. 从 PostgreSQL 分批重建 Redis generation；校验候选计数、Task 版本和重建高水位。
6. 恢复 Redis Cluster，启动 Event Relay，从 Outbox 发布并以事件 ID 去重；检查 stream pending、backlog、age、retry、DLQ。
7. 启动 Worker Control API。旧 Worker 可以重新注册，但在 Lease/Attempt 重新验证前不发新租约；过期租约保持 `unknown`，直到 orphan grace 结束。
8. 启动 Scheduler，先运行 shadow/只记录模式，确认没有重复决策、跨 Release 分配或旧 Worker 覆盖新状态。
9. 恢复新 Task 创建和 Capacity Plan；Provider 写操作只在库存快照新鲜、操作 key 可重放且预算检查通过后开放。

## 关键不变量

- PostgreSQL 是唯一状态真源，Redis/Provider 状态不得直接覆盖 Task、Attempt 或 Lease。
- 同一 Task 同时最多一个有效 Lease；迟到 Worker 结果必须被拒绝并保留审计。
- Capacity Plan 是不可变决策；恢复时生成新计划，不修改旧计划或历史成本。
- Provider 操作必须使用已有 operation key reconcile，禁止通过“重启即重建”创建重复计费实例。
- S3 对象只按对象元数据与哈希恢复；平台不转码模型原始产物。

## 演练记录

每季度至少完成：

- PostgreSQL 主从切换与最近备份恢复，记录 RPO/RTO、迁移版本和审计连续性。
- Redis 全量 namespace 清空，在线重建 generation，验证无重复调度。
- Redis Streams 延迟/重复消息，验证 Outbox 重放、Consumer 去重和 DLQ 恢复。
- Worker 全部失联，验证 `unknown -> orphan grace -> retry policy`，不终止仍可能恢复的执行。
- Provider Controller 重启和响应丢失，验证 operation key reconcile、库存过期抑制和自动回收。
- 运行中 Task 的控制面滚动升级，验证不改变 Lease、不抢占、不删除结果。

每次演练保存时间线、指标截图、影响范围、恢复动作、未覆盖项和回滚方式；演练资产不得包含真实用户素材、API Key、Provider 密钥或模型权重。
