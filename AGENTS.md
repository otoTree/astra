# Astra AI 开发规则

本文件适用于整个仓库，指导 AI 和人工开发者生成、修改和审查生产代码。用户请求优先于本文件；架构与协议以 `docs/` 中的设计文档为准。若发现代码与设计冲突，先报告冲突并更新设计或 ADR，再继续实现。

## 开始工作前

1. 阅读 `docs/README.md`，再阅读与变更相关的架构、协议、数据、调度、Worker 或发布文档。
2. 检查 `git status` 和现有改动。不得覆盖、回滚或删除不是本次任务产生的改动。
3. 判断变更影响的边界：API、数据库、调度、Worker 合同、Provider、发布、安全或管理台。
4. 跨模块或高风险变更先写出简短实施计划；不确定的业务语义必须保留为显式配置或提出问题，不能猜测。
5. 修改前先定位现有抽象和测试，优先复用包的公开入口，不创建平行实现。

## 本地开发硬规则

- 本地开发默认禁止真实模型推理和真实 GPU 调用。Compose 中的 Model App 合同参考实现必须遵循同一 Worker Contract，返回可重复、可校验的图片/视频测试产物。
- 本地不得调用共绩或其他真实 Provider API。Provider Adapter 合同参考实现必须覆盖创建、预热、扩缩容、排空、回收、超时和错误响应，使接口和状态机可以端到端验证。
- 本地 Compose 使用真实的 PostgreSQL、Redis Cluster、Kafka 和 S3 兼容服务（MinIO），不能用进程内对象替代这些一致性边界。
- Compose 必须使用显式 project name（推荐 `astra-local`）、专用网络、前缀为 `astra-local-` 的 volume 和本地端口配置，禁止连接或复用其他项目的数据库、网络和 volume。
- 启动服务前检查端口和 Compose project 所属关系。端口属于本项目时可以使用带明确 `-p astra-local` 的 `docker compose down` 后重启；端口属于未知或其他项目时不得停止进程或执行全局 prune，改用其他端口并记录配置。
- 本地凭证只来自仓库外 `.env.local`；不得使用生产 API Key、OIDC 密钥、Provider 密钥或真实用户素材。
- 本地接口正确性通过 Schema/OpenAPI、Worker Agent、Provider Adapter 合同参考实现、Model App 合同参考实现和最小端到端 Task 流程验证；“没有真实模型”不是跳过合同测试的理由。
- 生产代码、组件、目录、脚本和开发文档必须采用正式领域名称；测试专用实现按具体技术特征或用途命名，例如 `InMemoryProviderAdapter`、`ManualClock` 和 `reference-model-app`。
- 真实 H3 或其他 GPU 模型只能作为显式、隔离、非默认的可选 profile，不能成为 `bun run dev` 或普通 Compose 启动的隐式依赖。

## 架构硬边界

- 运行时和包管理器使用 Bun；控制面 TypeScript 必须启用 strict mode。
- 后端使用 Hono、Drizzle 和 `packages/contracts`；管理台使用 React/Vite。
- `apps/api` 在代码层共享用例，但生产生成三个独立 Deployment：`public-api`、`admin-api`、`worker-control-api`。不得用路由参数切换信任域。
- `scheduler` 只生成不可变 `scheduling_decision` 和 `capacity_plan`，不直接调用 Provider。
- `provider-controller` 是唯一供应商 API 出口；共绩签名、DTO、重试和错误码只能位于 Provider Adapter。
- `event-relay` 只从 PostgreSQL Outbox 发布 Kafka/Redis 事件，不参与任务领取，也不是真源。
- PostgreSQL 是 Task、Attempt、Lease、策略、发布和审计的唯一真源。Redis 只保存可重建索引、限流和短缓存；Kafka 只做事件分发；S3 是二进制唯一存储。
- Model App 不得连接 PostgreSQL、Redis、Kafka、Provider 或管理 API。任意语言模型通过 localhost Worker Contract 接入。
- `packages/provider-core` 不得依赖共绩 DTO；`packages/queue` 不得拥有 Task 状态转换；数据库包不得依赖应用层。
- 应用之间使用数据库期望状态、Kafka 事件或已版本化 HTTP Contract 协作，不直接导入其他应用源码。

## 协议和 API

- 先更新 `packages/contracts` 的 JSON Schema/OpenAPI，再更新 Hono 路由、客户端和测试。
- 对外路径使用 `/v1`，管理台使用 `/admin/v1`，Worker 使用 `/internal/v1`。
- 视频和图片创建路径必须分开，Task 查询、取消和文件内容路径统一。
- 新字段必须可选并保持向后兼容；删除、改名、收紧校验或改变默认行为需要新版本或 ADR。
- 所有创建接口支持 `Idempotency-Key`。同项目同键同请求返回原 Task，不同请求返回 `409`。
- 外部 JSON 使用 `snake_case`；内部 `camelCase` 只在边界转换。时间使用 UTC，金额使用最小货币单位整数，禁止浮点金额。
- 未声明字段默认拒绝；模型特有参数只能进入注册 Release Schema 校验的命名空间。
- 错误必须使用统一错误 Envelope，不能把堆栈、供应商密钥、完整预签名 URL 或提示词敏感内容写入响应。
- 所有分页使用不透明游标；不得用 offset 分页替代规范游标。

## 数据和一致性

- 状态变化、Attempt、Lease、Outbox 和审计必须在同一 PostgreSQL 事务中提交。
- 领取任务必须使用带版本条件的 CAS；禁止相信 Redis 候选或 Worker 自报状态直接覆盖数据库。
- 任务、租约、Provider 操作、事件消费和文件上传都按至少一次交付设计，必须有幂等键或确定性操作 ID。
- 不在应用启动时自动执行生产数据库迁移。迁移使用独立 Job，应用只校验 schema 版本。
- 破坏性迁移采用 expand -> backfill -> contract；大表迁移说明锁、批量大小、回滚和监控。
- 原始提示词和敏感请求字段使用字段级信封加密，读取需要 RBAC 和审计。
- 不把 Redis、Kafka、Provider 状态或本地磁盘当作永久事实；必须能从 PostgreSQL/S3 重建。

## 调度和容量

- Task 状态、Attempt 状态和 Replica 状态必须遵循设计文档中的状态机，不新增隐式状态字符串。
- 槽位计算必须区分 `running`、`reserved`、`unknown` 和 `draining`；reservation 不是吞吐。
- 预测使用按 Release、GPU、尺寸、FPS、时长桶、质量和输入角色分桶的 P75/P95/EWMA；不得用视频输出时长代替 GPU 服务时间。
- 在线任务优先但必须保留批量最低份额；公平排序使用预计 GPU 秒和项目权重，不能只按任务数量。
- 扩缩容必须记录容量计划、成本、收益、ETA、抑制原因和策略版本。预算或库存不足时进入 admission control，不无限堆积或静默丢弃任务。
- 缩容只能通过 `draining`，不得终止运行中的 Attempt；Rollout 期间暂停普通缩容。
- 调度时间依赖注入 `Clock`，所有决策仿真必须是确定性的。

## Worker 和模型应用

- Worker Agent 领取、心跳、取消、结果上传和 `drained` 回报必须幂等，并校验 Worker、Replica、Release、Lease 绑定。
- Agent 失联时先进入 `unknown`，租约过期和 orphan grace period 结束前不得复用槽位。
- `drain` 只停止领取新 Attempt，已有任务继续完成；Agent 不得自行删除 Provider 实例。
- Model App 只实现 localhost HTTP Contract；不依赖 Bun、TypeScript 或平台数据库。
- 输出必须生成 manifest，上传前执行 MIME、哈希、完整解码、尺寸、FPS、时长、音频声道等 Release Schema 校验。
- Model App 的 `execution_key` 必须幂等；重复请求不得产生不可控的重复副作用。

## Provider 和模型发布

- 所有 Provider 操作经过 `provider-controller` 和显式 Adapter，必须支持超时、指数退避、熔断、幂等操作键和 reconcile。
- 实现共绩 Adapter 前必须阅读 [`docs/providers/gongji/README.md`](docs/providers/gongji/README.md)、接口索引和目标 `api/api-*.md`；供应商字段只能在 Adapter transport 层使用。
- 镜像 tag 创建 Release 时解析为固定 OCI digest；Rollout 中不得重新解析 mutable tag。
- 新镜像先用共绩临时算力预热并通过 readiness、capabilities、smoke 和资源门，再接收新 Task。
- 旧 Release 关闭 `accept_new_tasks` 后，允许切换前已创建的旧 Task 排空；队列清零后关闭 `accept_existing_tasks`，再 `drain` 和回收。
- 回滚先切 Alias，再预热稳定 digest；候选版本不得继续接收新任务。运行中任务默认完成，事故取消必须有审计。
- 发布暂停、回滚和回收都必须保留操作者、原因、digest、版本差异、成本和影响范围。

## 安全和可观测性

- 所有配置启动时用 Schema 校验；敏感配置只来自 Secret Manager/External Secret，禁止提交仓库或日志。
- 默认拒绝 NetworkPolicy；Model App 无外网，Worker 只访问许可的控制面、S3、DNS、时间和日志端点。
- 日志使用结构化字段和关联 ID；禁止记录 API Key、Token、完整预签名 URL、原始素材和未脱敏提示词。
- 新后台操作必须有 RBAC、审计事件和可回滚版本；策略发布必须经过 validate -> impact_preview -> publish。
- 新异步流程至少暴露 queue depth、wait time、attempt duration、lease expiry、error code、cost、capacity plan 和 reconcile 指标。
- 告警必须包含影响范围、当前状态、建议操作和自动恢复状态，不能只输出异常堆栈。

## 测试和交付门

每个变更按风险选择测试，但以下门不能省略：

1. 格式、lint、TypeScript strict、依赖边界和构建检查。
2. 单元测试；状态机、幂等、CAS、游标和错误映射必须覆盖边界条件。
3. 数据库迁移测试和事务回滚测试。
4. API Schema/OpenAPI 兼容性测试与错误 Envelope 测试。
5. Worker 黑盒合同测试，覆盖注册、心跳、领取、进度、取消、drain、`drained`、超时、输出 manifest 和重复执行。
6. Provider 录制响应合同测试、熔断/重试/重复消息测试；测试夹具不得含真实凭证。
7. 调度确定性仿真，覆盖长短任务、批量公平、无库存、预算封顶、冷启动、缩容迟滞和 Redis 重建。
8. Docker/镜像非 root、SBOM、漏洞扫描、Helm render 和最小端到端 smoke。

未经测试的 TODO、伪实现、永不触发的 fallback、吞异常、无限重试、`any`、硬编码生产密钥和“先上线再补校验”都不算完成。

## AI 交付格式

完成代码变更后，必须说明：修改文件、行为变化、数据库/协议影响、运行的检查、未运行的检查、残余风险和回滚方式。若无法运行某项检查，必须明确原因，不得声称测试通过。只修改完成任务所需的文件，不生成无关格式化或依赖升级噪音。

更详细的规范、示例和评审清单见 [`docs/09-development-standards.md`](docs/09-development-standards.md)。
