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
| 8 | 共绩 Transport 与只读快照 | 进行中 | 7 |
| 9 | 共绩资源操作与 Reconcile | 未开始 | 8 |
| 10 | 预热、滚动发布、排空、回滚 | 未开始 | 9 |
| 11 | WFQ、耗时预测、Retry Policy | 未开始 | 10 |
| 12 | 扩缩容、成本收益、跨区放置 | 未开始 | 11 |
| 13 | 生产安全、灾备、10-50 GPU 验收 | 未开始 | 12 |
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

### 阶段 9：共绩写操作

交付：Provider Controller 按数据库期望状态创建、启动、预热、停止、回收；确定性 operation key；操作成本和供应商 ID；漂移 Reconcile。

退出条件：响应丢失、重复消息、限流、无库存、签名错误和区域故障不创建重复计费资源；隔离真实验证有成本上限和自动回收。

### 阶段 10：镜像发布

交付：运维输入镜像地址后固定 digest、使用共绩临时算力预热、逐机替换；新 Replica 验收前 `rollout_reserved`；旧 Release 停止新任务并排空；持续排队时使用受预算保护的替换容量；暂停、恢复、自动暂停和反向 Rollout。

退出条件：带运行任务的滚动发布和候选故障回滚演练通过；不终止正常 Attempt；旧 digest 在保留窗口内可拉起。

## 5. 算法、生产与模型阶段

### 阶段 11：公平与预测

交付：按 Release/GPU/尺寸/FPS/时长/质量/输入角色分桶的 P75/P95/EWMA；在线优先和批量最低份额；按预计 GPU 秒/项目权重排序；aging 和 Retry Policy。

退出条件：4-15 秒混合任务按 GPU 时间公平；突发在线不饿死批量；预测缺失与漂移不破坏队列。

### 阶段 12：扩缩容与放置

交付：可版本化 min/max、SLO、利用率、预算、区域、步长、冷却、迟滞、空闲窗口；离散队列模拟；边际收益对 GPU/冷启动/传输成本；跨区域评分和 Admission Control。

初始默认：空闲窗口 15 分钟、缩容冷却 20 分钟、目标利用率 75%、单轮缩容不超过池容量 10%。缩容只对空闲 Worker 发 `drain`，Rollout 期间暂停普通缩容。

退出条件：300 并发、4-15 秒混合、无库存、价格变化、预算封顶、冷启动和缩容迟滞仿真通过；每个 Capacity Plan 保存输入、成本、收益、策略版本和抑制原因。

### 阶段 13：生产验收

交付：完整 Helm、独立三 API 信任域、Migration Job、PDB/HPA、默认拒绝 NetworkPolicy、External Secret、非 root/SBOM/签名/漏洞门、监控告警、备份恢复和值班手册。

退出条件：PostgreSQL 切换、Redis 丢失、Kafka 延迟、Worker 失联演练通过；10-50 GPU 容量满足 SLO。

### 阶段 14：人类模型团队交接边界

平台交付：语言无关 Model App Contract、合同套件、原始产物保真、严格 FFmpeg 解码、Release Manifest 与镜像预热/灰度/回滚闭环。控制面仓库、CI 和默认开发环境不下载或执行任何权重。

人类模型团队交付：固定 ComfyUI/节点/工作流/权重/VAE/LoRA hash 的真实模型镜像；预加载、常驻权重、编译缓存、Attention 内核和 I/O 并行优化；GPU 资源与人工质量批准。平台只接收固定 OCI digest 和资产哈希清单。

平台退出条件：在无权重参考实现上完成执行、取消、超时、输出 Manifest、预热、灰度和回滚合同验收，并形成可由人类填写的 GPU/质量验收清单。真实 5090 推理、15 秒质量基准、T2VA/I2VA 与参考媒体矩阵由人类模型团队签署后，候选 Release 才可进入生产。

### 阶段 15：图片与规模扩展

交付：图片 Model App 复用 Task/Worker/Provider/发布/计费体系；图片能力仅位于 Release Schema；压测调度分片、数据库分区、Outbox、Redis 重建和 Provider 限流。

退出条件：图片和视频创建路径分离、查询统一；数百 GPU 压测无重复调度、租约冲突或状态丢失，并形成容量评审报告。
