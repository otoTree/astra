# ADR-0007：独立媒体验证与文件过期协调

## 状态

已采纳

## 背景

文件完成确认必须校验 S3 中的实际字节、SHA-256、文件签名和媒体完整可解码性。FFmpeg 对不可信媒体的解析资源消耗和攻击面不应进入 Public API 进程。文件到期又涉及 PostgreSQL 状态、S3 删除、有效执行 Lease 和排队 Task 失败，不能仅依赖 S3 Lifecycle 或 API 请求触发。

## 决策

1. Public API 是 File 状态机的唯一写入口。完成确认先执行 S3 HEAD 和 PostgreSQL CAS，将记录从 `pending_upload` 推进到 `validating`。
2. 独立 Media Validator 通过版本化内部 HTTP 合同接收 object key、声明的 MIME、大小和 SHA-256。它只读 S3、使用隔离临时目录、严格完整解码媒体并返回结构化元数据，不访问 PostgreSQL，也不修改对象。
3. Public API 区分确定性内容拒绝和基础设施失败。前者将 File 置为 `rejected` 并删除不可信对象；后者保留可重试状态，不把存储或验证服务故障归因于调用方素材。
4. File Sweeper 从 PostgreSQL 以有界批次和行锁领取到期记录。存在有效 Lease 的输入不回收；其他记录进入 `expiring`，S3 幂等删除成功后再写 `expired`。
5. 输入到期且相关 Task 仍处于 `queued | scheduling | provisioning` 时，Sweeper 在同一 PostgreSQL 事务中写 Task 失败、状态历史和 Outbox。Sweeper 崩溃后通过 `expiring` 冷却窗口重新领取。
6. S3 Lifecycle 只作为二进制清理兜底，不能独立推进数据库状态。PostgreSQL 始终是生命周期真源，S3 始终是仍存在二进制的真源。

## 影响

Public API 不承担 FFmpeg 资源尖峰或解析器攻击面，验证服务可以独立限制 CPU、内存、超时和并发。代价是完成确认多一次内部调用，并需要维护服务鉴权、超时、指标和重试分类。文件删除采用 Saga，因此 `expiring` 是可观察且可恢复的中间状态。

## 安全与可观测要求

- Validator 使用可轮换 Bearer 服务凭证和最小 S3 只读权限；日志不得包含凭证、预签名 URL、素材字节或原始提示词。
- 暴露验证次数、耗时、拒绝原因、基础设施失败和超时指标。
- Sweeper 暴露领取量、完成量、失败类型、最老待清理年龄和当前积压。
- 临时文件在请求结束时删除；本地磁盘与验证结果缓存都不是权威存储。

## 被否决的方案

- 在 Public API 进程内运行 FFmpeg：资源和安全故障域过大。
- 只检查扩展名或 Content-Type：无法发现伪装、损坏和截断媒体。
- 只使用 S3 Lifecycle：不能原子更新 Task、状态历史和 Outbox，也不能保护有效 Lease。
