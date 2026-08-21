# ADR-0004：通用 Provider Contract 与共绩适配器

- 状态：Accepted
- 日期：2026-08-19

## 背景

首期算力来自共绩，其 API 提供资源、弹性 Deployment、Batch Job、Job Queue、节点、存储、日志和费用能力，并使用专有签名、状态和资源标识。平台未来可能接入自有 Kubernetes GPU 或其他供应商。

## 决策

- Scheduler 与核心领域只依赖规范化 Provider Contract。
- `provider-gongji` 独立处理 token、timestamp、version、签名、DTO、错误码、资源 mark 和生命周期映射。
- Provider Controller 使用 desired/observed Reconcile，不让 API/Scheduler 直接发供应商写请求。
- 所有写操作预先创建幂等 Provider Operation，超时后先观察再重试。
- 原始供应商响应加密保留用于排障，公共 API 只暴露规范化状态和错误。

## 结果

首期多一层适配代码与合同测试，但供应商变更不会污染公共 Task、调度算法和 Worker。后续 Adapter 必须通过同一合同测试，而不是在 Scheduler 中增加供应商条件分支。

## 未选择方案

- 核心直接绑定共绩 DTO：开发初期较快，但供应商状态、签名和 mark 会扩散到全系统。
- 首期同时实现多个 Provider：当前没有第二个明确目标，会扩大无效测试矩阵。
- 以 Kubernetes API 作为唯一 Provider Contract：不能完整表达外部 Batch Job、计费和专有存储能力。
