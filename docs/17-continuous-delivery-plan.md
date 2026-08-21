# Astra 持续开发与阶段验收计划

## 1. 执行规则

- 唯一顺序是：现有接口 -> 安全与管理面 -> 事件与最小调度 -> Worker -> 共绩 -> 发布 -> 高级算法 -> 生产验收 -> 真实模型。
- 每阶段必须独立可部署、可观测、可回滚；未通过退出条件不得启动依赖阶段。
- 每个合并批次必须包含合同、实现、迁移、正常/失败/幂等/恢复测试、指标和回滚说明。
- 本地只运行真实 PostgreSQL、Redis Cluster、Kafka/Redpanda、MinIO 与合同参考实现，不调用 GPU、真实模型或共绩。
- 阶段 0-13 不下载任何模型、VAE、LoRA 或文本编码器权重；阶段 14 也必须经显式授权后在隔离环境按哈希拉取，权重不进入开发机默认流程或 Git。
- PostgreSQL 是状态真源，S3 是二进制真源；Redis、Kafka、供应商状态和 Worker 本地磁盘不得成为永久事实。

## 2. 阶段状态

| 阶段 | 交付目标 | 状态 | 依赖 |
| --- | --- | --- | --- |
| 0 | 工程基线与 v1 合同 | 完成 | 无 |
| 1 | Public API 完整实现 | 完成 | 0 |
| 2 | API Key、配额、限流、审计 | 完成 | 1 |
| 3 | Admin API 与管理台只读能力 | 完成 | 2 |
| 4 | Model/Release/Pool/Policy 写能力 | 完成 | 3 |
| 5 | Outbox、Kafka、Redis 重建 | 完成 | 4 |
| 6 | 最小确定性调度与租约 | 完成 | 5 |
| 7 | Worker Control 与 Agent 执行环 | 完成 | 6 |
| 8 | 共绩 Transport 与只读快照 | 完成 | 7 |
| 9 | 共绩资源操作与 Reconcile | 完成 | 8 |
| 10 | 预热、滚动发布、排空、回滚 | 完成 | 9 |
| 11 | WFQ、耗时预测、Retry Policy | 完成 | 10 |
| 12 | 扩缩容、成本收益、跨区放置 | 完成 | 11 |
| 13 | 生产安全、灾备、10-50 GPU 验收 | 进行中 | 12 |
| 14 | H3/10Eros 真实 Model App | 未开始 | 13 |
| 15 | 图片模型与数百 GPU 扩展 | 未开始 | 14 |

状态变更必须与代码、测试证据和可部署版本在同一变更中提交，不能只修改表格。

## 3. 控制面阶段

### 阶段 0：工程基线与合同

交付：Bun workspace、strict TypeScript、Biome、依赖边界、CI、可校验的 Public/Admin/Worker OpenAPI、配置 Schema、错误 Envelope、请求 ID、加密请求、可注入时间/ID、迁移校验、固定 digest Compose，以及确定性 Model App/Provider Contract 参考实现。

退出条件：`bun run check`、`bun run test:integration:local`、Compose 配置和健康检查通过；Model App 返回字节保真的图片/视频 Manifest；数据库迁移可重复；建立 Git 基线。

### 阶段 1：Public API

交付：文件上传/确认/下载/过期，视频与图片 generation/edit，`GET /v1/models`，统一 Task get/list/cancel，完整时间与优先级过滤，稳定游标，幂等并发处理，Release/File/MIME/Role/TTL 校验。平台不得转码模型产物。

失败与恢复：上传不匹配删除对象并拒绝；重复确认返回同一 File；同幂等键不同请求返回 409；取消幂等；过期素材阻止新 Attempt；S3 暂时故障不得伪造完成。

退出条件：OpenAPI 与路由差异检查、PostgreSQL+MinIO 端到端、并发幂等、分页、取消、过期和错误 Envelope 测试全部通过。

阶段 1 验收证据（2026-08-21）：

- `bun run check` 通过：格式、lint、strict TypeScript、依赖边界、三份 OpenAPI、迁移 checksum、32 个常规测试和生产构建全部成功。
- `bun run test:integration:local` 通过：10 个 PostgreSQL 集成测试与 6 个 MinIO/严格媒体集成测试成功，覆盖并发幂等、Release/File/TTL、游标、取消、过期、Lease 保护、字节保真和验证故障分类。
- `bun run compose:check`、迁移重复执行、第一方容器非 root、Model App `/work` 权限及 Public API/Media Validator/File Sweeper 指标端点检查通过。
- 实际 HTTP 冒烟完成视频创建、幂等重放、统一查询、过滤列表和取消；每个 Task 响应通过共享 Schema，`resolved_parameters` 为 Release 解析值且未暴露系统 seed。

### 阶段 2：鉴权、配额与审计

交付：Argon2id API Key、轮换/吊销/scope、组织项目角色、OIDC、权威用量账本、Redis 限流、并发/预算 Admission Control、敏感读取审计。

退出条件：轮换、吊销、越权、跨项目、限流恢复、重复请求不重复占额和审计不可篡改测试通过。

阶段 2 当前进度（2026-08-21）：

- Public OpenAPI 已要求 Bearer API Key，并按 `generations:create`、`tasks:read`、`tasks:cancel`、
  `files:write`、`files:read`、`models:read` 执行细粒度 scope；调用方组织头不再参与身份决策。
- 已实现 Argon2id Key、前缀候选定位、默认/授权项目选择、过期、并行轮换、立即吊销、限频
  `last_used_at` 和带 HMAC 服务签名的认证拒绝审计。
- PostgreSQL 已落地组织、项目、Key、项目授权、成员角色、配额、reservation、只追加 usage
  ledger 和只追加 audit event。Task/File Admission 在配额行锁事务内执行，幂等重放不重复占额，
  取消、上传拒绝和资产过期幂等释放。
- Redis Cluster 原子 Token Bucket 已接入请求/Task 创建限流；Redis 不可用时 Public 写路径
  fail closed，readiness 同时检查 PostgreSQL 与 Redis。
- 本地使用显式 `identity-bootstrap` Job 从未跟踪 `.env.local` 读取 Key，只保存 Argon2id 哈希，
  不打印明文；Redis Cluster 初始化已支持重复启动。
- 当前测试证据：36 项普通单元/合同测试，14 项 PostgreSQL 集成、6 项 MinIO/严格媒体集成、
  4 项真实 HTTP 安全闭环均通过。HTTP 测试覆盖无凭证、跨项目、幂等 reservation、Redis
  `Retry-After`、吊销和拒绝审计。

本批回滚采用应用回滚而非数据库降级：`0005_identity_admission_audit.sql` 仅新增表、索引、触发器
和 Release 估算元数据，旧应用可以忽略这些结构。回滚时保留 Key 哈希、reservation、usage ledger
与 audit event，禁止删除或改写审计历史；Public API 旧版本只允许在已隔离入口中临时运行，避免恢复
到信任调用方身份头的旧行为。修复后重新部署本批镜像并运行显式 `identity-bootstrap` 即可恢复。

阶段 2 完成证据（2026-08-21）：

- 新增 RS256 OIDC issuer/audience/时间声明验证与 JWKS 缓存；ID Token 仅能交换一次。
- Admin API 使用数据库不透明会话、HttpOnly/SameSite Cookie、双提交 CSRF、即时吊销和独立信任域；生产强制 `Secure` 与 `__Host-` Cookie。
- 组织和项目成员角色在每次请求时重新读取并取权限交集；敏感 Task 请求要求 `tasks:read_sensitive` 与显式读取用途。
- 会话创建/吊销和成功审计在同一 PostgreSQL 事务提交；审计失败时状态变更回滚，会话记录禁止删除。
- 本地身份参考服务提供真实 RS256/JWKS 合同，不连接生产身份系统。41 项普通测试、17 项 PostgreSQL 集成测试和 6 项真实 HTTP 安全测试通过。

### 阶段 3：Admin 只读面

交付：Task 时间线、Attempt/Lease、Worker/Replica、队列、区域、库存、成本、Model/Release/Pool/Policy/Rollout/Provider Operation 查询；每个 Admin API 同批提供管理台页面和 RBAC。

退出条件：权限矩阵通过；任一 Task 可从创建追踪到终态；游标和查询索引通过执行计划审查。

阶段 3 完成证据（2026-08-21）：

- PostgreSQL 新增 Model、Pool、区域、库存、Replica、Worker、Provider Operation 与 Rollout 观察实体；Task、Attempt、Lease 与状态事件保留权威关联和有界索引。
- Admin API 提供 Task 时间线、Model/Release/Pool、Worker/Replica、区域库存、Provider Operation、Rollout、当日成本和不可变审计查询；列表统一使用绑定项目与资源类型的签名游标。
- 普通 Task 详情只返回请求哈希和执行时间线，不返回请求密文或解密提示词；敏感请求继续由独立权限接口和读取用途审计保护。
- Admin Web 已接入真实只读 API，覆盖概览、Task 排障、容量、发布和审计；本地开发通过短期 RS256 参考身份进入正式 Session Exchange，生产构建只保留企业 OIDC 入口。
- 验收通过 41 项普通测试、20 项 PostgreSQL、6 项 MinIO/媒体、7 项真实 HTTP；执行计划命中项目游标索引。浏览器验证 1440px 与 390px 视口无页面横向溢出，Task 抽屉可用且控制台无错误。

回滚使用应用回滚并保留 `0007_admin_observability.sql` 新增表。旧应用忽略这些结构；观察记录不得因回滚删除。恢复本批应用后从 PostgreSQL 与 Provider 快照重新填充可重建观察数据。

### 阶段 4：版本化管理写接口

交付：Model、Release、Alias、Pool、区域/预算/容量策略；镜像 tag 解析固定 digest；Release Manifest/Schema/权重/工作流/资源合同；`validate -> impact_preview -> publish`；审批与一键回滚。

退出条件：mutable tag 不改变既有 Release；缺策略版本不能接流量；所有写操作有 CAS、幂等、RBAC、审计和管理台差异预览。

阶段 4 完成证据（2026-08-21）：

- Admin Contract 与实现已覆盖 Model、Release、审批、Pool、四类策略、影响预览、发布、回滚和 Alias 切换；写请求统一要求管理权限、CSRF、`Idempotency-Key`、原因和适用的 `If-Match` 版本条件。
- Release 创建通过 OCI Distribution API 解析 tag，并校验 `Docker-Content-Digest` 与 Manifest 原始字节 SHA-256 一致后固定 digest；幂等重放直接返回首次结果，不再次解析 mutable tag。
- PostgreSQL 保存 source image、固定 digest、Manifest/Config digest、审批、Alias 版本、策略版本、不可变影响预览和管理幂等响应。数据库触发器禁止改写 Release 元数据、策略配置、审批、预览、Alias 历史和幂等历史。
- Pool 默认 disabled；Release 必须审批后才能建池，四类策略必须完成 `validate -> impact_preview -> publish` 后 Pool/Alias 才能激活生产流量。
- 本地 Registry Contract 提供标准 OCI Manifest 与 Config 响应，不包含镜像 layer、模型运行时或任何权重文件；Release Manifest 只登记权重逻辑名、大小和哈希元数据。
- Admin Web 已提供镜像地址输入、digest 结果、Model/Release/Pool、资源状态、审批、策略预览/发布/回滚和 Alias 切换操作面。桌面和 390px 浏览器验收无页面级横向溢出，管理写入成功，复查期控制台无错误。
- 验收通过 strict TypeScript、Biome、OpenAPI、迁移 checksum、OCI 摘要单元测试、22 项 PostgreSQL 集成测试与 8 项真实 HTTP 安全/管理合同测试。

本阶段新增并已应用迁移 `0008_admin_management.sql`（checksum `dc83e986c987430ef18cdb399742bfabb0e09abfc008053abce97acb207b4c21`）与 `0009_admin_history_guards.sql`（checksum `95f1ce786db6bc601480ba970dcb5290891d3361b7e1ab4534437ba2a3a5acb3`），后续禁止修改。回滚采用应用回滚：新增表和不可变历史继续保留，旧应用忽略新增字段；不得通过降级迁移删除审批、策略、Alias、幂等或审计历史。

## 4. 执行与 Provider 阶段

### 阶段 5：事件与重建

交付：PostgreSQL Outbox 到 Kafka、确定性事件去重/重放/死信、Redis 候选和限流索引、从 PostgreSQL 分批重建、backlog/age/retry 指标。

退出条件：Redis 全量丢失可在线重建；Kafka 停机、重复、乱序不改变数据库最终状态；业务写与 Outbox 同事务。

阶段 5 完成证据（2026-08-21）：

- `event_relay_deliveries` 对 Kafka/Redis 分别维护短租约、重试、目标元数据和死信；Outbox 插入与
  Task 状态在同一事务，供应商或消息系统调用不进入事务。
- Kafka 多实例领取阻止同聚合后继越过前序，message key 固定为 `aggregate_id`；消费者以
  `(consumer_name,event_id,payload_hash)` 在 PostgreSQL 事务内去重并拒绝 payload 冲突。
- Redis 候选只保存可重建数据。重建使用 PostgreSQL 独占短租约、Task 游标、Outbox 高水位增量回放、
  数量校验和 generation 指针切换；运行期指针丢失立即重建，稳定数量不一致触发受迟滞保护的重建。
- Compose 显式创建五个 Kafka topic，并提供独立 Event Relay、健康检查、backlog/age/retry/dead-letter/
  delivery duration/rebuild 指标；KafkaJS 在 Bun 下的空队列负 timeout 已通过最小依赖 patch 消除。
- `bun run check` 通过：50 项普通测试通过，strict TypeScript、依赖边界、三份 OpenAPI、迁移 checksum
  和生产构建均成功。事件合同容器 7 项真实集成测试通过，覆盖 PostgreSQL 并发 claim、租约接管、
  DLQ/replay、Consumer 去重、Redis 幂等与全量丢失重建、Redpanda 同聚合顺序。
- 实际故障演练中停止 `astra-local` Redpanda 后，Task 仍成功提交为 queued，Redis delivery 已完成而
  Kafka delivery 保持积压；Redpanda 恢复后同一事件收敛为双 sink delivered，Event Relay readiness
  恢复且未产生死信。
- 运行期完整性演练观测到 Redis 比 PostgreSQL 少 12 条候选：首轮只记录差异，第二轮自动创建新
  generation，并从 366 条恢复到权威的 378 条，`scanned/indexed` 指标均为 378，全程未把 Redis 当作
  Task 状态真源。

本阶段新增并已应用迁移 `0010_event_delivery_and_rebuild.sql`（checksum
`7ad4a1b9cb8cf9a900cda5202de826002a33758ef3580f51f88ede7ab3f5bd0b`），后续禁止修改。回滚采用应用
回滚并保留 delivery、死信、消费收据和 generation 历史；旧应用可继续只读取 `published_at`，但不得
删除新表或将 Redis/Kafka 提升为状态真源。

### 阶段 6：最小确定性调度

交付：不可变 `scheduling_decision`、Attempt、Reservation、Lease；按 Release/Pool/硬件/基本优先级分配；PostgreSQL CAS；`running/reserved/unknown/draining` 明确分离。Worker 只能领取预分配 Attempt。

退出条件：多 Scheduler 不重复分配；旧租约不覆盖新状态；相同快照与 Clock 产生相同决策。

阶段 6 完成证据（2026-08-21）：

- PostgreSQL 新增不可变 `scheduling_decisions`，完整保存 Task/Replica 版本、Release、Pool、Worker、
  槽位、策略版本、Clock 时间、输入快照、选择原因和结果；Attempt/Lease 保存 reservation 截止、状态、
  心跳和绑定版本。历史 Attempt 保留兼容读取，新式分配必须引用 decision。
- 活跃 Task 与 `(replica_id,slot_index)` 均有部分唯一索引。Scheduler 在单事务中锁定并复核 Task、
  Release、Pool、Replica、Worker 心跳与并发上限，再通过 Task version CAS 写 decision、Attempt、Lease、
  状态历史和 Outbox；Redis 候选从不决定分配结果。
- reservation 最长 30 秒，Task 对外仍为 `queued` 且 reservation 不计吞吐。预留时 Task version 递增并
  发布 `task.reserved` 从 Redis 移除；超时后 Lease/Attempt 原子转为 expired，再发布 `task.queued` 恢复候选。
- 纯调度核心按 Release、在线/批量基础优先级、创建时间、区域、Pool、Replica 和最低空槽稳定排序；相同
  快照不受输入数组顺序影响。高级公平、预测与跨区评分仍严格留在阶段 11-12。
- 独立 Scheduler 支持横向副本、短轮询、批量、reservation TTL 和 Worker 新鲜度配置，并暴露 readiness、
  迭代耗时、候选数、成功预留、CAS 冲突和过期指标。Task 排障接口同步展示 decision 和租约绑定详情。
- `bun run check` 通过 53 项普通测试；24 项真实 PostgreSQL 测试通过，其中覆盖双 Scheduler 并发收敛、
  stale Task/Replica CAS、decision 防篡改和 reservation 过期回队；7 项 Redis Cluster/Redpanda 事件测试通过。
  本地 Scheduler readiness 为 ready，在 100 个排队 Task、0 个新鲜 Replica 时保持 0 reservation。

本阶段新增并已应用迁移 `0011_deterministic_scheduling.sql`（checksum
`2ecc8d6906c119e825e521df92fdd83468ccec3c6be65f683c2c8c24e7b1ed33`），后续禁止修改。回滚采用应用
回滚并停止 Scheduler；保留 decision、Attempt、Lease 和状态历史，不执行降级删除。恢复本阶段应用后，
过期 reservation 由任一 Scheduler 从 PostgreSQL 收敛，Redis 可由 Event Relay 重建。

### 阶段 7：Worker 执行闭环

交付：注册、Token、预分配领取、心跳、续租、进度、取消、输出三阶段提交、`drain/drained`、失联 unknown/orphan grace；Agent 下载输入、调用 localhost、验证并原字节上传。

退出条件：语言无关黑盒合同、崩溃恢复、迟到结果、重复执行、运行中排空和上传失败测试通过。

阶段 7 完成证据（2026-08-22）：

- Worker Contract v1 已覆盖一次性 Bootstrap、短期 Session、Token 轮换、预分配领取、心跳续租、取消、
  `drain/drained`、三阶段输出提交和严格 Manifest；Worker OpenAPI 与实际路由差异检查通过。
- PostgreSQL 使用 CAS 绑定 Worker/Replica/Release/Attempt/Lease，支持 `unknown -> orphan grace -> requeue`、
  迟到结果拒绝、确定性不可执行 Task 收敛和并发 Session 轮换。迁移
  `0012_worker_execution_control.sql` checksum 固定为
  `0bbf37643ea050cecef114ad86129d7c0f5a1c6048d5810bdd1abaa0015589b1`。
- Worker Agent 已完成 Session 持久化、输入流式校验、localhost Model App、后台心跳、原始输出校验与上传、
  有限重试和终态回报。黑盒测试覆盖重启恢复、模型失败、控制面取消和运行任务排空；文件测试覆盖
  MIME/hash/size、部分文件清理、符号链接逃逸和临时存储故障。
- 本地真实链路完成 `Public API -> PostgreSQL -> Scheduler -> Worker -> Model App -> MinIO -> FFmpeg -> Task`。
  验收 Task `task_01a02542-6da0-7000-b22d-4d34d87ccab1` 为 `completed`，最终 Attempt 为
  `completed`、Lease 为 `released`、File 为 `available`；Worker 文件、S3 下载与 Manifest 的 SHA-256 均为
  `bffd27f216a33c487664b443b116c6d090974e7f663897728a23cdc161eb062f`，证明未发生平台转码或字节改写。
- `bun run check` 通过 65 项常规测试；完整本地门通过 27 项 PostgreSQL、6 项 MinIO/严格媒体、7 项
  Redis Cluster/Redpanda 和 8 项 HTTP 集成测试。Token 轮换外键顺序和 unknown 恢复门控均由回归测试固定。

回滚采用应用回滚并停止 Worker Agent/Worker Control；保留 `0012` 新增的 Session、Receipt、输出与状态历史，
不删除已上传对象或改写 Attempt。恢复本阶段应用后，仍在宽限期内的 Worker 通过原 Session/Attempt 恢复，
超出宽限期的 Attempt 由 Reconciler 回队。

### 阶段 8：共绩只读接入

交付：按本地供应商文档实现签名、DTO、错误映射、超时/退避/限流/熔断；同步区域、GPU、库存、价格、实例、Job、镜像与账单快照。共绩 DTO 不得离开 transport 包。

退出条件：使用到的每个接口都有脱敏录制合同；未知状态隔离告警；过期快照抑制调度和扩容。

阶段 8 完成证据（2026-08-22）：

- `provider-gongji` 已实现 RSA-SHA256/PKCS#1 v1.5 请求签名、动态凭证读取、有限指数退避、
  `Retry-After`、供应商错误映射和熔断；Transport 只读覆盖资源、Deployment、节点、Job、镜像预热区域、
  镜像预热任务和计费七类实际接口，共绩字段未进入 Provider Core、Scheduler 或公共 API。
- 每个接口均有基于本地 OpenAPI 示例裁剪并脱敏的合同夹具；测试验证签名、MiB 到 bytes、积分到人民币最小
  单位、递归敏感字段移除、鉴权熔断，以及全部七类路径无外部网络读取。运行时出现未声明字段、未知状态、
  重复对象或分页超过边界时整次快照进入隔离，不静默覆盖当前库存。
- PostgreSQL 新增不可变 Snapshot Run/Page/Object、可更新 Freshness State 和当前区域/库存原子发布。
  隔离或失败批次保留完整诊断证据，但继续使用未过期的最后成功快照；过期后 `usable=false`，供后续放置与
  扩缩容明确抑制。迁移 `0013_provider_read_snapshots.sql` checksum 固定为
  `8c9187de405d93f8f2e3b613f4ff75185229747933a33c6be8b3ee26bc902573`。
- Provider Controller 已加入 `astra-local` Compose，默认只使用确定性 `reference` 合同实现。实际运行发布
  `reference` 区域和 20 个 `reference-gpu` 库存，readiness 为 ready，快照可用指标为 1，隔离原因指标为 0；
  本批没有配置共绩凭证、没有请求真实供应商、没有创建算力或拉取镜像。
- `bun run check` 通过 70 项常规测试，完整 PostgreSQL 回归 28 项通过；集成测试验证发布原子性、隔离不污染
  当前库存、失败沿用未过期快照、过期抑制和不可变诊断记录。

回滚时停止 Provider Controller 并回滚应用，不删除 `0013` 表、快照或当前库存。阶段 7 及更早应用会忽略
这些新增结构；恢复阶段 8 应用后由下一轮只读同步生成新版本。禁止为回滚修改已应用迁移或清除供应商诊断历史。

### 阶段 9：共绩写操作

交付：Provider Controller 按数据库期望状态创建、启动、预热、停止、回收；确定性 operation key；操作成本和供应商 ID；漂移 Reconcile。

退出条件：响应丢失、重复消息、限流、无库存、签名错误和区域故障不创建重复计费资源；隔离真实验证有成本上限和自动回收。

阶段 9 完成证据（2026-08-22）：

- PostgreSQL Provider Operation 已扩展为期望状态账本，固定 operation key、请求摘要和目标载荷，并保存租约、
  最大尝试次数、下一次执行时间、供应商资源 ID、状态、响应摘要、费用和最后对账时间。身份字段由数据库触发器
  禁止修改；多 Controller 通过 `FOR UPDATE SKIP LOCKED` 与租约 CAS 领取，过期执行进入 `reconciling`。
- Provider Controller 现在是唯一资源操作出口，按 Provider 隔离激活、领取和指标。快照过期时 provision/prewarm
  写为 `suppressed`，新鲜快照恢复后自动激活；drain/terminate 不被库存快照阻塞，但只有 Worker 已 `drained`、
  Replica 没有活跃 Attempt 时才可领取，避免停止运行中任务。
- 共绩写 Transport 实现固定请求字节签名、超时、错误映射与熔断；创建 Deployment 和镜像预热只接受完整的
  `registry/repository@sha256:...` 引用。模糊超时不在 HTTP 层重放，下一轮按 operation key 派生的确定性任务名
  查询供应商后再决定创建，避免重复计费资源；暂停和停止前读取当前状态并保持幂等。
- 独立 `provider-reference` 实现同一资源操作合同。本地 Compose 继续只启用 reference，Operation Loop health 为
  ready，且没有配置真实凭证、没有请求共绩、没有创建外部算力或拉取镜像。
- 集成测试覆盖 operation key 冲突/重放、双 Controller 领取、创建成功但响应未持久化、旧租约迟到结果、活跃
  Replica 回收抑制、快照过期与恢复、限流退避、鉴权失败和确定性资源收敛。`bun run check` 通过 73 项常规
  测试，PostgreSQL 回归 29 项通过。

本阶段迁移 `0014_provider_operations_reconcile.sql` checksum 固定为
`83f88c304ab2859c668a99112217461c40b39a966d2d2b3de2bed4775df08177`。回滚时先停止 Provider Controller，
保留未终态 Operation、供应商资源 ID、重试和费用记录；旧应用忽略新增列。恢复后由租约过期和确定性任务名查询
继续 Reconcile，禁止删除 Operation 以“解决”不确定供应商状态。

### 阶段 10：镜像发布

交付：运维输入镜像地址后固定 digest、使用共绩临时算力预热、逐机替换；新 Replica 验收前 `rollout_reserved`；旧 Release 停止新任务并排空；持续排队时使用受预算保护的替换容量；暂停、恢复、自动暂停和反向 Rollout。

退出条件：带运行任务的滚动发布和候选故障回滚演练通过；不终止正常 Attempt；旧 digest 在保留窗口内可拉起。

阶段 10 完成证据（2026-08-22）：

- Admin Contract、API 和管理台已提供 Rollout 影响预览、创建、详情、暂停、恢复和回滚。写操作统一执行
  OIDC/RBAC、CSRF、`Idempotency-Key` 与 `If-Match`，同一 Pool 只允许一个活动 Rollout。
- Rollout Controller 通过 PostgreSQL HA 租约逐步执行固定 digest 预热、`rollout_reserved` 新 Replica、Worker
  readiness/capabilities/smoke/output contract 验证、Alias/双接单门切换、旧版本队列排空、Worker drain 和
  Provider 回收。运行中的 Attempt 不被发布流程终止，持续排队时使用受 `maximum_extra_cost_minor` 约束的独立
  替换容量。
- Worker bootstrap token 只以哈希保存在数据库；传给 Provider 的环境材料使用 AES-256-GCM 信封加密，
  Operation、日志、响应和 Provider 快照不出现明文。共绩 Adapter 按供应商文档生成稳定排序的 `env` 数组，
  本地仍只启用 reference Provider。
- 回滚先把 Alias 和新任务接单门切回 source Release，再执行反向逐机 Rollout；已固定到 candidate Release 的
  queued/running Task 仍由 candidate Worker 排空，不修改 Task 的 Release 身份。
- PostgreSQL 演练覆盖预热、验证、切流、带运行任务排空、`drained` 前禁止回收、最终回收和秘密不泄露；真实
  HTTP 演练覆盖 preview/create/detail/pause/resume/rollback 以及 RBAC、CSRF、幂等和版本条件。Provider
  Controller readiness 为 `rollout_reconcile=ready`，并暴露 reconcile、活动状态和最老 Rollout age 指标。
- 阶段验收时 `bun run check`、31 项 PostgreSQL 集成和 9 项真实 HTTP 集成通过。仓库扫描不存在
  `.safetensors`、`.ckpt`、`.pt`、`.pth`、`.gguf` 或 `.onnx` 权重文件；未调用真实共绩、GPU 或模型推理。

本阶段迁移 `0015_rollout_control.sql`、`0016_rollout_worker_validation.sql`、
`0017_provider_operation_secrets.sql` 和 `0018_rollout_controller_lease.sql` 已应用并固定 checksum，禁止修改。
回滚采用应用回滚：先暂停活动 Rollout，保持 Worker 心跳和运行 Attempt，切回已知稳定 Alias，再停止新版
Controller。保留 Rollout/Step/Event、Provider Operation、Replica 和加密引导材料，禁止通过删除状态记录解除
不确定性；恢复后由确定性 operation key 和数据库租约继续 Reconcile。操作步骤见
[`runbooks/model-rollout.md`](./runbooks/model-rollout.md)。

## 5. 算法、生产与模型阶段

### 阶段 11：公平与预测

交付：按 Release/GPU/尺寸/FPS/时长/质量/输入角色分桶的 P75/P95/EWMA；在线优先和批量最低份额；按预计 GPU 秒/项目权重排序；aging 和 Retry Policy。

退出条件：4-15 秒混合任务按 GPU 时间公平；突发在线不饿死批量；预测缺失与漂移不破坏队列。

阶段 11 完成证据（2026-08-22）：

- Task 创建时只持久化 Release、GPU、尺寸、FPS、时长、质量、输入角色和输出数等非敏感调度维度；
  Release 可声明 4-15 秒视频及图片输出的冷样本 GPU 秒基线。达到策略样本门后使用同维度桶的 P75 与
  EWMA 加权预测，P95 独立用于尾延迟和超时，禁止跨 Release 或跨维度猜测。
- 在线/批量双层队列按预计 GPU 秒维护启动份额，批量低于版本化最低份额时获得下一空闲槽；项目排序按
  `predicted_gpu_seconds / scheduling_weight` 计费，并在终态以实际 GPU 秒同事务修正。SJF 只在同层使用，
  aging 保证长任务最终提升，运行中任务不抢占。
- Retry Policy 统一为纯确定性判定，结合发布策略错误码、Attempt 上限、指数退避、Task/输入素材剩余 TTL
  和项目 GPU 预算。Worker 失联经过 orphan grace 后走同一策略；重试保留 Admission reservation，终态才释放，
  重复失败回报不会重复计费或重复写服务时间。
- PostgreSQL 永久保存成功/失败/取消/失联样本、P75/P95/EWMA Profile、项目虚拟 GPU 账本和 lane GPU 账本；
  Attempt 固定预测值与来源，Scheduler 指标暴露排队 GPU 秒、预测候选和分配原因。
- `bun run test:integration:postgres` 通过 34 项，覆盖冷样本、P75/EWMA、并发 CAS、公平账本、可重试/不可重试
  失败、终态幂等和 Worker 失联。纯算法测试覆盖输入顺序无关、批量最低份额、按权重 GPU 时间公平及 aging。

本阶段迁移 `0019_fair_scheduling_and_retry.sql` 已应用，checksum 为
`05c9a1769acc0c3ff3698d3c2afa66cdbea91edf22f070682050d462e37ca9db`，后续禁止修改。回滚采用应用回滚并
暂停 Scheduler 新分配；保留 Task 调度画像、Attempt 预测/重试字段、服务时间样本与公平账本。旧应用忽略新增
结构，恢复阶段 11 应用后继续从 PostgreSQL 权威状态收敛，不删除历史样本或回退已发生的实际 GPU 用量。

### 阶段 12：扩缩容与放置

交付：可版本化 min/max、SLO、利用率、预算、区域、步长、冷却、迟滞、空闲窗口；离散队列模拟；边际收益对 GPU/冷启动/传输成本；跨区域评分和 Admission Control。

初始默认：空闲窗口 15 分钟、缩容冷却 20 分钟、目标利用率 75%、单轮缩容不超过池容量 10%。缩容只对空闲 Worker 发 `drain`，Rollout 期间暂停普通缩容。

退出条件：300 并发、4-15 秒混合、无库存、价格变化、预算封顶、冷启动和缩容迟滞仿真通过；每个 Capacity Plan 保存输入、成本、收益、策略版本和抑制原因。

阶段 12 完成证据（2026-08-22）：

- `packages/queue/src/capacity.ts` 提供无副作用的队列离散模拟、工作量副本数、队列 SLO 副本数、边际成本/收益、
  预算与库存 Admission Control、空闲窗口缩容候选和跨区域确定性评分。计算使用预计 GPU 服务秒，不能用 4-15
  秒的视频输出时长替代；`max_concurrency` 仍受 Release/Worker 合同约束。
- Capacity Policy 扩展为 `automatic/protected/manual` 三种模式，覆盖目标队列、最大 ETA、积压清空窗口、扩缩步长、
  冷却、迟滞、空闲窗口、最小持有时间、收益阈值和等待/SLO 价值。默认起点为空闲 15 分钟、缩容冷却 20 分钟、
  目标利用率 75%、单轮缩容不超过池容量 10%，配置必须经过 `validate -> impact_preview -> publish`。
- Scheduler 每 5 秒从 PostgreSQL 读取活动 Pool、任务、运行 Attempt、Replica 和新鲜库存快照，写入不可变
  `capacity_plans`；Scheduler 不调用 Provider。计划记录当前/期望副本、工作量/SLO 结果、成本、收益、净收益、
  ETA、Placement、排空候选、库存/预算/Rollout 抑制和 Admission Control 原因。
- Admin API 新增 `GET /admin/v1/capacity-plans` 游标查询。Replica 保存 `idle_since`、`ready_at` 和
  `last_scale_action_at`，缩容过滤运行/预留槽、Rollout 所有权、空闲窗口、最小持有与冷却条件。
- 纯算法测试覆盖运行任务剩余时间、混合长短视频 GPU 工作量、库存/预算/Rollout 抑制和忙实例不排空；
  PostgreSQL 集成共 35 项，包含 Capacity Plan 不可变与 Admission 解释记录。

本阶段迁移 `0020_capacity_plans.sql` 已应用，checksum 为
`4f02707b76e833d58c2a951804b391ed44c221ccd262c3c6524c82248eb919b1`，后续禁止修改。回滚采用应用回滚：暂停
容量计划循环，保留已生成计划与 Replica 时间戳；不删除计划历史，不直接删除 Provider 资源。恢复后由 Scheduler
按最新 PostgreSQL 快照重新生成计划。

### 阶段 13：生产验收

交付：完整 Helm、独立三 API 信任域、Migration Job、PDB/HPA、默认拒绝 NetworkPolicy、External Secret、非 root/SBOM/签名/漏洞门、监控告警、备份恢复和值班手册。

退出条件：PostgreSQL 切换、Redis 丢失、Kafka 延迟、Worker 失联演练通过；10-50 GPU 容量满足 SLO。

阶段 13 当前进度（2026-08-22）：

- Helm 已提供三类 API、Scheduler、Provider Controller、Event Relay 的独立 Deployment/ServiceAccount/Service、Migration pre-install/pre-upgrade Job、PDB、控制面 HPA、ExternalSecret 选项和默认拒绝 NetworkPolicy。模板会在渲染时拒绝 mutable image tag，只接受 `sha256:<64 位十六进制>`；生产值示例见 `deploy/helm/astra/values.production.example.yaml`。
- 控制面六个 Deployment 均生成 HPA；启用 `monitoring.enabled` 后为六个服务生成 ServiceMonitor 和 PrometheusRule，覆盖控制面不可用、调度失败、Outbox backlog、供应商快照失效和容量 Admission Control 告警。
- 控制面镜像和本地参考镜像均使用非 root、RuntimeDefault、只读根文件系统、禁止提权和 `drop: ALL`；Compose 与 Helm 均不包含模型权重。
- `bun run model-artifacts:check` 已纳入全仓检查，扫描仓库、构建上下文和工作目录中的 `.safetensors`、`.ckpt`、`.pt`、`.pth`、`.gguf`、`.onnx` 文件；当前结果为 clear。CI 已加入 Helm render/dry-run 门。
- 灾备恢复顺序和值班动作已写入 [`docs/runbooks/disaster-recovery.md`](./runbooks/disaster-recovery.md)，容量验收脚本/报告模板已写入 [`docs/18-production-capacity-acceptance.md`](./18-production-capacity-acceptance.md)。
- `.github/workflows/production-supply-chain.yml` 提供手动生产门：对外部固定 digest 生成 CycloneDX SBOM、执行 Trivy 高危扫描、验证 Cosign 签名并做 Helm digest 渲染；不在开发机拉取模型权重。

阶段 13 尚未宣称完成的项目：真实 Kubernetes 集群 PostgreSQL 主从切换、真实 KMS/ExternalSecret、10-50 张 GPU 压测、真实 SBOM 签名和漏洞扫描报告。这些必须在隔离环境执行并附运行证据；当前仅完成模板、合同和无权重本地验证。

### 阶段 14：人类模型团队交接边界

平台交付：语言无关 Model App Contract、合同套件、原始产物保真、严格 FFmpeg 解码、Release Manifest 与镜像预热/灰度/回滚闭环。控制面仓库、CI 和默认开发环境不下载或执行任何权重。

人类模型团队交付：固定 ComfyUI/节点/工作流/权重/VAE/LoRA hash 的真实模型镜像；预加载、常驻权重、编译缓存、Attention 内核和 I/O 并行优化；GPU 资源与人工质量批准。平台只接收固定 OCI digest 和资产哈希清单。

平台退出条件：在无权重参考实现上完成执行、取消、超时、输出 Manifest、预热、灰度和回滚合同验收，并形成可由人类填写的 GPU/质量验收清单。真实 5090 推理、15 秒质量基准、T2VA/I2VA 与参考媒体矩阵由人类模型团队签署后，候选 Release 才可进入生产。

阶段 14 平台侧已完成无权重闭环：参考 Model App、Worker Agent、严格媒体验证、原始字节上传、Release Manifest、镜像 digest 发布、排空和回滚合同均可在本地验证。真实 H3/10Eros 镜像、权重、GPU 推理、质量和性能由人类模型团队独立完成；平台不会下载或接收权重文件。详细交接表见 [`docs/19-model-team-handoff-without-weights.md`](./19-model-team-handoff-without-weights.md)。

### 阶段 15：图片与规模扩展

交付：图片 Model App 复用 Task/Worker/Provider/发布/计费体系；图片能力仅位于 Release Schema；压测调度分片、数据库分区、Outbox、Redis 重建和 Provider 限流。

退出条件：图片和视频创建路径分离、查询统一；数百 GPU 压测无重复调度、租约冲突或状态丢失，并形成容量评审报告。

阶段 15 平台侧无权重验收证据（2026-08-22）：

- 图片生成、图片编辑、视频生成和视频编辑继续使用分开的创建路由；Task 查询、取消、文件下载、审计、计费和 Worker Contract 共享同一生命周期实现。图片 Release 特有字段只存在图片 Schema/Manifest 命名空间。
- 参考 Model App 已覆盖 PNG 图片产物、视频产物、取消、超时、重复 `execution_key` 和严格输出 manifest；没有加载模型权重。
- `packages/queue/src/scale-acceptance.test.ts` 使用 300 个混合在线/批量任务和 256 个单槽 Replica 验证确定性排序、单任务单槽位和无重复分配；同一输入反转顺序得到完全相同的计划。该测试验证平台算法，不替代真实 GPU 容量报告。

真实数百 GPU 压测、数据库分片/分区容量、Kafka/Redis/Provider 生产限流和模型质量仍需在隔离环境执行；平台仓库不下载或保存权重。
