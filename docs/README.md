# Astra 内部多媒体模型集群平台

本文档集定义 Astra 的第一版生产架构。Astra 是仅供内部使用的图片与视频生成平台，向调用方提供 OpenAI 风格但不承诺 OpenAI SDK 兼容的 HTTP API，并统一管理任务、模型版本、GPU 算力、素材、成本和审计。

## 目标与边界

第一阶段目标：

- 支持视频与图片两类异步生成任务，创建路径分离，查询路径统一。
- 支持 MiniMax H3/ComfyUI 联合音画工作流，并允许任意语言实现模型应用。
- 生产控制面运行在 Kubernetes，本地使用 Docker Compose 验证。
- 首期管理 10-50 张 GPU，并保证架构可以水平扩展至数百卡。
- 同时承载在线和批量任务，在排队体验、公平性与成本之间提供可配置策略。
- 首期接入共绩算力，但不让供应商协议进入平台核心领域模型。

第一阶段明确不包含：

- 文本模型推理。
- 同步等待生成结果。
- OpenAI SDK 的二进制或完整行为兼容。
- Webhook；调用方通过统一任务接口查询结果。
- 自动内容拦截；平台只做完整审计。
- 强制指定 H3 模型应用的实现语言。

## 设计原则

1. **PostgreSQL 是唯一真源**：任务状态、租约、策略、发布记录和审计均以数据库为准。Redis 与 Kafka 都可以重建或重放，不能决定最终业务状态。
2. **创建分模态，生命周期统一**：图片和视频有独立请求 Schema，但创建后都转化为相同 Task 状态机。
3. **控制面与模型隔离**：模型进程只和同实例的 Worker Agent 通信，不直接访问数据库、消息系统或供应商 API。
4. **供应商可替换**：调度器只依赖 Provider Contract；共绩签名、状态码和资源标识封装在适配器内。
5. **异步且幂等**：所有生成请求、队列投递、Worker 执行、事件发布和结果上传都按至少一次交付设计，并依靠幂等键收敛。
6. **策略显式化**：生产模型必须显式配置容量、排队、预算和区域策略，不使用不可见的全局热池默认值。
7. **资产短存、记录长存**：输入和输出二进制保存 24 小时；完整请求、状态与审计永久保存并加密。
8. **吞吐基于真实服务时间**：视频时长不是 GPU 服务时间；任务分配受 Release 声明的并发槽位约束，扩容由排队收益与 GPU 成本共同决定。
9. **实验不等于生产**：ComfyUI 工作流、节点和加速方式必须固定版本并通过机械、资源和人工质量门后才能接入稳定流量。
10. **原始产物保真**：Model App 生成的文件字节是交付事实。Worker Agent 只验证、搬运和登记，不在平台路径中转码、裁切、重采样或重新封装；任何派生格式都必须由模型镜像内部显式生成并作为独立 Release 验收。

## 文档索引

| 文档 | 内容 | 主要读者 |
| --- | --- | --- |
| [01-system-architecture.md](./01-system-architecture.md) | 系统上下文、服务、网络、任务全链路与故障边界 | 架构师、后端、SRE |
| [02-monorepo-design.md](./02-monorepo-design.md) | Bun monorepo 目录、模块依赖与工程约束 | 全体研发 |
| [03-api-protocol.md](./03-api-protocol.md) | 文件、图片、视频、统一任务和管理 API | API 调用方、后端 |
| [04-task-scheduling-and-autoscaling.md](./04-task-scheduling-and-autoscaling.md) | 公平队列、放置决策、扩缩容公式与伪代码 | 调度研发、SRE |
| [05-model-worker-contract.md](./05-model-worker-contract.md) | Worker Agent 和任意语言模型应用的 HTTP 合同 | 模型工程、平台研发 |
| [06-data-and-event-architecture.md](./06-data-and-event-architecture.md) | PostgreSQL、Redis、Kafka、S3 与一致性 | 后端、数据、SRE |
| [07-deployment-security-observability.md](./07-deployment-security-observability.md) | K8s、Compose、安全、监控、告警与恢复 | SRE、安全、后端 |
| [08-model-release-and-roadmap.md](./08-model-release-and-roadmap.md) | 模型发布、灰度、回滚、阶段路线与验收 | 模型工程、QA、产品 |
| [09-development-standards.md](./09-development-standards.md) | AI 代码生成、工程边界、测试、审查和生产质量门 | 全体研发、AI Agent、SRE |
| [10-h3-ref2va-workflow-research.md](./10-h3-ref2va-workflow-research.md) | 10Eros-Max V3 BF16 H3 Ref2VA 工作流的协议、实现、性能和上线阻断项 | 模型工程、平台研发、QA、SRE |
| [11-10eros-comfyui-deployment.md](./11-10eros-comfyui-deployment.md) | 10Eros 权重、存储、预热和 ComfyUI 内部 API 部署规范 | 模型工程、平台研发、SRE |
| [12-10eros-asset-sources.md](./12-10eros-asset-sources.md) | 10Eros 权重、官方地址、自定义节点源码和来源审计登记 | 模型工程、供应链、安全、SRE |
| [13-10eros-h3-face-refine-research.md](./13-10eros-h3-face-refine-research.md) | H3-FaceRefine 节点源码、二次推理链路、10Eros 兼容性和实验发布边界 | 模型工程、平台研发、QA、SRE |
| [14-huggingface-mirror-and-weight-supply-chain.md](./14-huggingface-mirror-and-weight-supply-chain.md) | hf-mirror 下载加速、权重校验、内部 Artifact 入库和生产网络边界 | 模型工程、供应链、安全、SRE |
| [15-5090-scale-economics.md](./15-5090-scale-economics.md) | 5090 单卡单 Worker 的 300 并发吞吐、GPU 成本、收益敏感性和扩缩容测算 | 产品、调度、SRE、财务 |
| [16-model-app-implementation.md](./16-model-app-implementation.md) | 从 ComfyUI 工作流编写生产 Model App：运行时边界、HTTP 合同、预热、取消、产物和测试 | 模型工程、平台研发、QA、SRE |
| [17-continuous-delivery-plan.md](./17-continuous-delivery-plan.md) | 持续开发顺序、阶段依赖、当前状态、逐阶段交付与退出条件 | 全体研发、QA、SRE、项目负责人 |
| [providers/gongji/README.md](./providers/gongji/README.md) | 共绩算力 67 个 Open API 的本地原始文档、接口索引和 Adapter 说明 | Provider、调度、SRE |
| [workflows/README.md](./workflows/README.md) | ComfyUI 工作流 JSON 资料及哈希 | 模型工程、平台研发、QA |
| [third-party/README.md](./third-party/README.md) | ComfyUI 上游源码快照及版本说明 | 模型工程、平台研发 |

关键决策记录：

- [ADR-0001：分模态创建与统一任务协议](./adr/0001-modality-specific-create-unified-task.md)
- [ADR-0002：PostgreSQL 为真源，Redis 为可重建执行索引](./adr/0002-postgres-source-of-truth.md)
- [ADR-0003：Worker 出站拉取与本地模型合同](./adr/0003-worker-outbound-pull.md)
- [ADR-0004：通用 Provider Contract 与共绩适配器](./adr/0004-provider-adapter.md)
- [ADR-0005：镜像地址驱动的逐机滚动发布](./adr/0005-image-driven-rolling-release.md)
- [ADR-0006：模型输出字节保真与显式后处理](./adr/0006-model-output-byte-preservation.md)
- [ADR-0007：独立媒体验证与文件过期协调](./adr/0007-isolated-media-validation-and-expiration.md)

## 核心术语

| 术语 | 定义 |
| --- | --- |
| Task | 一次图片或视频生成的永久业务记录，也是统一查询对象。 |
| Attempt | Task 的一次实际执行尝试；重试会创建新的 Attempt，不复用执行身份。 |
| Model Release | 不可变的模型、镜像、工作流、节点、权重和能力 Schema 组合。 |
| Model Pool | 同一 Model Release 与硬件规格形成的调度和扩缩容单元。 |
| Replica | 可领取一个或多个任务的运行中 Worker Agent 与模型应用实例。 |
| Worker Agent | 平台提供的 Bun 代理，负责领取任务、素材传输、租约和状态上报。 |
| Model App | 任意语言实现的模型进程，通过 localhost HTTP 合同接受推理。 |
| Provider | 提供 GPU、Deployment、Batch Job、存储或计费能力的算力系统。 |
| Placement | 为新增容量选择 Provider、区域和硬件规格的过程。 |
| Lease | PostgreSQL 中带过期时间的任务执行所有权。 |
| Artifact | 输入素材或生成结果的元数据记录；二进制保存在 S3，生成结果默认保留 Model App 原始字节。 |

## 约定

- 外部 API 使用 `/v1`，管理 API 使用 `/admin/v1`，Worker 控制协议使用 `/internal/v1`。
- 对外 JSON 字段使用 `snake_case`；TypeScript 内部可使用 `camelCase`，在边界显式转换。
- ID 使用带资源前缀的 UUIDv7 文本，例如 `task_...`、`file_...`、`model_...`。
- 时间戳对外使用 Unix 秒；内部数据库使用 UTC `timestamptz`。
- 所有金额在内部使用最小货币单位整数与 ISO 4217 币种，禁止浮点金额。
- 所有哈希使用 SHA-256。运维可以输入镜像 tag，但平台必须在发布事务中解析并固定 digest；同一次 Rollout 禁止再次解析可变 tag。
- Mermaid 图描述逻辑关系，不代替 Kubernetes 或数据库的机器可读配置。

## 推荐阅读顺序

新接入调用方先阅读协议文档；模型工程先阅读 Worker 合同和发布文档；平台研发按架构、monorepo、数据、调度顺序阅读；SRE 重点阅读架构、调度和部署文档。
