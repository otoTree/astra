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
| 2 | API Key、配额、限流、审计 | 进行中 | 1 |
| 3 | Admin API 与管理台只读能力 | 未开始 | 2 |
| 4 | Model/Release/Pool/Policy 写能力 | 未开始 | 3 |
| 5 | Outbox、Kafka、Redis 重建 | 未开始 | 4 |
| 6 | 最小确定性调度与租约 | 未开始 | 5 |
| 7 | Worker Control 与 Agent 执行环 | 未开始 | 6 |
| 8 | 共绩 Transport 与只读快照 | 未开始 | 7 |
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

阶段 2 尚未完成：人员 OIDC 会话、组织/项目 RBAC 交集、CSRF 和敏感请求读取审计仍需接入
Admin API 并完成权限矩阵测试。在这些退出项通过前，阶段 2 不标记完成，也不启动阶段 3。

### 阶段 3：Admin 只读面

交付：Task 时间线、Attempt/Lease、Worker/Replica、队列、区域、库存、成本、Model/Release/Pool/Policy/Rollout/Provider Operation 查询；每个 Admin API 同批提供管理台页面和 RBAC。

退出条件：权限矩阵通过；任一 Task 可从创建追踪到终态；游标和查询索引通过执行计划审查。

### 阶段 4：版本化管理写接口

交付：Model、Release、Alias、Pool、区域/预算/容量策略；镜像 tag 解析固定 digest；Release Manifest/Schema/权重/工作流/资源合同；`validate -> impact_preview -> publish`；审批与一键回滚。

退出条件：mutable tag 不改变既有 Release；缺策略版本不能接流量；所有写操作有 CAS、幂等、RBAC、审计和管理台差异预览。

## 4. 执行与 Provider 阶段

### 阶段 5：事件与重建

交付：PostgreSQL Outbox 到 Kafka、确定性事件去重/重放/死信、Redis 候选和限流索引、从 PostgreSQL 分批重建、backlog/age/retry 指标。

退出条件：Redis 全量丢失可在线重建；Kafka 停机、重复、乱序不改变数据库最终状态；业务写与 Outbox 同事务。

### 阶段 6：最小确定性调度

交付：不可变 `scheduling_decision`、Attempt、Reservation、Lease；按 Release/Pool/硬件/基本优先级分配；PostgreSQL CAS；`running/reserved/unknown/draining` 明确分离。Worker 只能领取预分配 Attempt。

退出条件：多 Scheduler 不重复分配；旧租约不覆盖新状态；相同快照与 Clock 产生相同决策。

### 阶段 7：Worker 执行闭环

交付：注册、Token、预分配领取、心跳、续租、进度、取消、输出三阶段提交、`drain/drained`、失联 unknown/orphan grace；Agent 下载输入、调用 localhost、验证并原字节上传。

退出条件：语言无关黑盒合同、崩溃恢复、迟到结果、重复执行、运行中排空和上传失败测试通过。

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

### 阶段 14：真实 H3/10Eros

交付：固定 ComfyUI/节点/工作流/权重/VAE/LoRA hash 的独立 Model App；原始产物保真；严格 FFmpeg 解码；预加载、常驻权重、编译缓存、Attention 内核和 I/O 并行优化，不以降低 20 步采样换取默认加速。

退出条件：5090 单卡显存安全；15 秒质量基准不下降；T2VA、I2VA、首尾帧和参考媒体矩阵通过；预热、灰度、回滚和人工质量批准完成。

### 阶段 15：图片与规模扩展

交付：图片 Model App 复用 Task/Worker/Provider/发布/计费体系；图片能力仅位于 Release Schema；压测调度分片、数据库分区、Outbox、Redis 重建和 Provider 限流。

退出条件：图片和视频创建路径分离、查询统一；数百 GPU 压测无重复调度、租约冲突或状态丢失，并形成容量评审报告。
