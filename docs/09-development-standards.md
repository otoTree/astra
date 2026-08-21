# 开发规范与生产质量门

## 1. 目的和规范等级

本文档定义 Astra 控制面、Worker Agent、管理台和 Provider Adapter 的实现、测试、审查和发布标准。规范关键词含义如下：

- **必须**：不满足则不能合并或发布。
- **应该**：除非有记录的技术原因，否则必须遵守。
- **可以**：实现者可在不破坏合同的前提下选择。

根目录 `AGENTS.md` 是 AI 代码生成时的执行清单；本文档是团队评审和扩展规范。用户明确要求、已批准 ADR 和协议版本优先级高于默认实现偏好。

## 2. 本地开发和接口验证

Mac 或没有 GPU 的开发机不运行真实模型。默认本地运行模式必须是：

```text
真实 API/Task/数据库/队列/文件流
              |
Provider Adapter 参考实现 + Worker Agent + Model App 参考实现
```

约束如下：

- Model App 合同参考实现遵循与 GPU Model App 相同的 localhost Worker Contract，支持能力发现、接受任务、进度、取消、超时、输出 manifest、幂等执行和可控失败；输出使用确定性小型图片/视频样本，接口字段和媒体校验仍走生产路径。
- Provider Adapter 合同参考实现遵循共绩 Adapter 的通用 Provider Contract，覆盖预热、创建 Replica、扩容、缩容、drain、回收、库存耗尽、限流、超时和回滚；本地不发送任何真实供应商请求。
- PostgreSQL、Redis Cluster、Kafka 和 MinIO 必须通过 Docker Compose 启动，不能用应用内内存对象代替数据库、队列或对象存储一致性边界。
- Compose 使用显式项目名（推荐 `astra-local`）、隔离网络、`astra-local-` volume 前缀和专用端口。所有连接串、端口和本地运行配置来自仓库外 `.env.local`，不得引用其他项目或生产配置。
- 启动前先检查 `docker compose -p astra-local ps` 和端口占用。只有确认端口属于本项目时，才允许 `docker compose -p astra-local down` 后重新启动；未知占用改端口，不执行全局 `docker compose down`、`docker system prune` 或 `docker volume prune`。
- 允许 AI 在本地启动开发服务、Compose 依赖和测试进程，但必须使用可识别的 project name，并在交付说明中报告启动、停止和端口变更。
- 真实 GPU/H3 profile 只能显式启用，不能成为默认 `dev`、合同测试或 CI 依赖；接口正确性由 Model App 合同参考实现、Worker Agent、Schema 和端到端 Task 流程证明。
- 组件、目录、脚本和文档采用正式领域名称；测试专用实现必须按具体技术特征或用途命名，不能让测试属性取代领域名称。

## 3. 代码组织和依赖方向

目标结构：

```text
apps/
  api/                    # public/admin/worker-control 三种运行模式
  scheduler/              # 调度和容量决策
  provider-controller/    # 供应商 reconcile、预热、回收和发布
  event-relay/            # Outbox 到 Kafka/Redis
  worker-agent/           # 标准 Bun Agent
  admin-web/              # React/Vite 管理台
packages/
  contracts/ database/ auth/ queue/ provider/
  observability/ config/ testkit/
model-workers/            # 任意语言，只实现 Worker Contract
```

依赖方向必须保持单向：

```text
contracts <- database <- apps
contracts <- provider-core <- provider-controller
contracts <- queue <- scheduler
testkit -> all test targets
```

具体边界：

- `apps/api` 可以共享用例，但 `public-api`、`admin-api`、`worker-control-api` 是三个独立生产 Deployment。它们分别拥有认证、ServiceAccount、NetworkPolicy、限流和 HPA。
- `scheduler` 不调用供应商 API；它写入 PostgreSQL 期望状态和 Capacity Plan。
- `provider-controller` 是唯一供应商出口；共绩协议只能在 `provider-gongji` 内部出现。
- `event-relay` 不参与任务领取，Kafka 不是真源。
- `database` 不依赖应用层；事务函数接受明确 command 对象，返回领域结果。
- 应用之间不得源码互相导入业务实现，只能通过共享包、数据库期望状态、Kafka 事件或版本化 HTTP 合同协作。

## 4. TypeScript、Bun 和实现风格

- 使用 Bun workspace、TypeScript strict、Hono、Drizzle、React/Vite；新增运行时、框架或基础设施必须先有 ADR。
- 禁止 `any`、隐式 `unknown` 转型、非空断言逃避校验和空 catch。第三方输入先解析为未知值，再通过 Schema 转为领域类型。
- 领域函数优先纯函数和不可变输入；时间、随机数、UUID、Provider Client 和数据库连接通过依赖注入提供，便于仿真和测试。
- 业务错误使用带 code、category、retryable、safe_message 和 metadata 的结构化错误；HTTP、Kafka 和日志边界分别映射，不能透传异常文本。
- 每个包只从公开入口导入；禁止跨包深层路径和循环依赖。
- 公共函数明确输入、输出、错误和幂等语义；复杂算法必须有短注释解释不变量和边界，不写叙述性废话。
- 配置分为静态环境配置和数据库版本化策略。生产业务默认值不得藏在代码、环境变量或 Helm 模板中。

## 5. API 和合同优先

### 5.1 变更流程

1. 先修改 `packages/contracts` 中的 JSON Schema/OpenAPI。
2. 运行兼容性检查，确认旧客户端和旧 Worker 的行为。
3. 更新 Hono 路由、边界转换、错误映射和生成类型。
4. 更新合同测试、示例和变更说明。

### 5.2 兼容规则

- `/v1` 只能增加可选字段或协商后的枚举值；删除、改名、收紧输入和改变默认行为需要新版本或 ADR。
- 所有生成接口返回 `202` Task；不要在 HTTP 请求内等待 GPU 结果。
- `Idempotency-Key` 必须绑定组织/项目、方法、路径和请求哈希；同键不同请求返回 `409`。
- 文件上传必须经历预签名上传和完成确认；API 不接收任意 URL 作为素材来源。
- 对外 JSON 使用 `snake_case`、统一错误 Envelope、不透明游标和 UTC 时间。金额使用最小货币单位整数。
- `model_options` 只能接受当前 Release 注册 Schema 允许的命名空间，禁止把模型特有字段加入公共字段。

## 6. 数据库、事务和事件

- PostgreSQL 是 Task、Attempt、Lease、策略、Release、Capacity Plan、费用和审计的唯一真源。
- 状态变更、租约 CAS、状态历史和 Outbox 必须在同一事务中完成。
- Scheduler 领取任务必须使用版本条件 CAS；Redis 候选失效时删除索引并重新选择，不能盲目重试。
- 所有异步消费者按至少一次交付实现：事件 ID、操作 ID、消费游标和业务幂等键必须可追踪。
- Schema 迁移采用 expand -> backfill -> contract；不得在应用启动时隐式执行生产迁移。
- 大表操作说明索引、锁等待、批量大小、回滚方案和监控；查询必须有执行计划意识，禁止无界全表扫描。
- Redis 数据必须可由 PostgreSQL 重建；Kafka 延迟或重复不能改变业务最终状态；S3 只保存二进制和可校验 manifest。

## 7. 调度器和扩缩容实现

- 任务状态、Attempt、Lease、Replica 和 Rollout 状态必须使用文档定义的枚举和状态转移。
- 槽位严格区分 `running`、`reserved`、`unknown`、`draining`；单槽 Worker 不得预派第二个任务。
- 公平队列使用预计 GPU 秒，而非任务数量；服务时间按 Release、GPU、尺寸、FPS、时长桶、质量和输入角色分桶。
- 扩容同时考虑队列目标、工作量、P75/P95 服务时间、Provider 冷启动、预算和边际收益。
- 缩容必须满足在线队列为空、未来窗口容量安全、低负载观察、冷却、最小热池和净节省；批量队列需要满足排空 ETA 与最低份额。
- 缩容只发送 `drain`，不终止运行 Attempt；Rollout 期间暂停普通缩容，避免两个控制器竞争删除 Replica。
- 所有调度计算使用注入 Clock、固定输入快照和确定性排序；输出保存策略版本、候选方案、成本、收益和抑制原因。

## 8. Worker、模型和媒体产物

- Worker Agent 负责领取、租约、心跳、取消、素材下载、结果上传、清理和 `drained` 回报；Model App 只负责本地推理。
- Agent Token 绑定 Worker、Replica、Pool、Release 和实例指纹；租约过期前不复用槽位，旧 Attempt 结果不得覆盖新 Attempt。
- `drain` 后不领取新 Attempt；`drained` 回报必须经控制面 CAS 验证没有有效 Lease/Reservation。
- Model App 可以使用 Python、C++、Rust 或其他语言，只实现版本化 localhost HTTP Worker Contract。
- 输入和输出使用 manifest、SHA-256、MIME、大小和角色校验；视频执行严格 FFmpeg 解码、时长/FPS/音频校验，图片执行完整解码和尺寸/色彩校验。
- 输出上传完成、S3 校验和数据库确认必须幂等；临时文件使用权限 0700、原子重命名和租约保护清理。

## 9. Provider、镜像和发布

- Provider Adapter 只实现通用资源、Deployment、Batch Job、预热、删除、账单和状态接口；共绩签名和 DTO 不得泄漏到 Scheduler。
- Provider 操作必须有超时、指数退避、Retry-After、熔断、幂等操作键和 reconcile；签名错误不能无限重试。
- 模型镜像地址创建 Release 时解析并固定 OCI digest，记录签名、SBOM、Manifest、工作流/节点/权重 hash 和能力 Schema。
- 共绩预热实例通过 readiness、capabilities、smoke、显存余量和媒体验收后才接收新任务。
- 旧 Release 先关闭 `accept_new_tasks`，允许切换前已创建任务排空；队列清零后关闭 `accept_existing_tasks`、发送 drain、接收 `drained`，再回收。
- 回滚先切 Alias、再预热上一稳定 digest；运行中任务默认完成，候选未执行任务必须审计重绑定或显式失败，不能继续执行已禁用版本。

## 10. 安全、日志和管理台

- 默认拒绝 NetworkPolicy；Model App 无外网，Worker 只访问许可的控制面、S3、DNS、时间和日志端点。
- API Key、Worker Token、OIDC 凭证、Provider 密钥和预签名 URL 只能来自 Secret 管理系统，禁止进入源码、测试夹具和日志。
- 日志结构化并带 `request_id`、`task_id`、`attempt_id`、`release_id`、`pool_id`、`provider_operation_id`；敏感提示词和素材内容按字段级加密与审计读取。
- 新管理操作必须有 RBAC、审计、影响预览、版本号和回滚路径；删除、禁用、回收、取消属于高风险操作。
- 指标至少包含请求、队列、租约、Worker、GPU、Provider、成本、发布和数据完整性；告警包含影响范围和处理建议。

## 11. 测试策略

### 11.1 必须覆盖的测试

- 单元：状态机、Schema、错误映射、游标、幂等键、CAS 命令和成本公式。
- 集成：PostgreSQL 事务/迁移、Redis 重建、Kafka Outbox、S3 上传确认和权限策略。
- 合同：API、Worker Agent/Model App、Provider Adapter；使用录制响应和无真实密钥夹具。
- 仿真：长短视频混合、在线/批量公平、突发、无库存、跨区涨价、预算封顶、冷启动、缩容迟滞和重复消息。
- 故障：Worker 失联、租约过期、旧结果、Provider 超时、预热失败、镜像 digest 不符、回滚、数据库切换和上传失败。
- 端到端：图片/视频创建、文件上传、统一 Task 查询、取消、完成和资产过期。

### 11.2 质量门

目标 CI 至少提供以下脚本：

```text
bun run format:check
bun run lint
bun run typecheck
bun test
bun run contracts:check
bun run db:migrate:check
bun run build
bun run test:e2e:smoke
```

镜像构建还必须通过非 root、SBOM、漏洞扫描、固定 digest、Helm render 和最小权限检查。缺少某项检查时，变更说明必须记录原因和替代证据。

## 12. 变更风险和审查

| 变更类型 | 额外要求 |
| --- | --- |
| 文案、注释、测试 | 常规检查；不得改变合同或日志敏感性 |
| API/Worker/Kafka 合同 | Schema 兼容检查、迁移说明、旧版本合同测试 |
| 数据库/状态机/租约 | 事务测试、故障测试、回滚方案、运维告警 |
| 调度/扩缩容/成本 | 确定性仿真、边界参数、容量和成本影响预估 |
| Provider/发布/回滚 | 录制合同、熔断测试、预热/排空/回收演练 |
| 认证/权限/敏感数据 | 威胁建模、负向测试、审计验证和安全评审 |

任何生产变更都必须回答：失败时如何停止、如何回滚、如何恢复真源、如何识别影响范围。没有答案的变更不得进入稳定发布。

## 13. AI 代码生成流程

AI 在修改代码时必须遵循：

1. 先读取相关设计文档、ADR、代码和测试，再提出假设与影响范围。
2. 先改合同/领域类型和测试，再写适配层和实现；不要从 HTTP handler 直接拼数据库和 Provider 调用。
3. 任何新增状态、配置、错误码、事件或数据库字段都必须说明所有生产消费者和兼容策略。
4. 不生成未经验证的 Provider URL、签名算法、GPU 价格、模型能力或凭证；未知内容使用接口和显式配置隔离。
5. 不留下空实现、假成功、吞异常、无限重试、隐式 fallback、`TODO` 作为生产路径或未经说明的功能开关。
6. 修改完成后运行与风险匹配的检查，报告修改文件、测试结果、未测试项、迁移、协议影响、残余风险和回滚步骤。

## 14. 完成定义

一个变更只有同时满足以下条件才算完成：

- 行为、状态和错误与设计文档一致。
- 合同、数据库、日志、指标和审计边界已更新。
- 正常路径、重试、重复消息、超时、取消、故障和回滚都有测试或明确的剩余风险。
- 生产配置没有隐式默认值、密钥和未经批准的跨域访问。
- 构建产物可固定为 digest，部署和回滚步骤可执行。
- 文档、ADR 或迁移说明已同步，且 `git diff --check` 通过。
