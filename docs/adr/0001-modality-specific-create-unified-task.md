# ADR-0001：分模态创建与统一任务协议

- 状态：Accepted
- 日期：2026-08-19

## 背景

图片与视频的输入、输出和模型参数差异明显，但两者都需要异步排队、取消、重试、成本、审计和结果过期。平台只要求 OpenAI 风格，不要求 OpenAI SDK 完整兼容。

## 决策

- 视频创建使用 `/v1/videos/generations`，图片创建使用 `/v1/images/generations`。
- 编辑能力分别使用 `/v1/videos/edits` 与 `/v1/images/edits`。
- 创建后统一返回 `generation.task`，通过 `/v1/tasks` 查询和取消。
- 所有生成均异步，不为快速图片任务增加同步分支。
- 模型特有参数只能进入由 Release Schema 校验的 `model_options`。
- 视频创建由调用方提供 `aspect_ratio`、Release 声明的 `resolution` 档位和时长，不接收任意像素 `size`、`fps`、`seed` 或 `negative_prompt`。FPS 与宽高由 Release 解析，seed 在首次创建事务中由系统随机生成并供后续 Attempt 复用。
- 视频 `input_files` 是保持顺序的 `file_id + type + role` 数组。`type` 只允许 `image | video | audio` 并必须与平台 File 元数据和严格解码结果一致；不接收任意外部 URL。

## 结果

调用方需要理解不同创建 Schema，但只需实现一种任务生命周期。平台可以在不污染公共 Task 的情况下扩展图片和视频能力，也避免绑定即将变化的外部供应商协议。

## 未选择方案

- 单一 `/v1/generations`：请求 Schema 会变成大量互斥字段，错误难以理解。
- 完全复制 OpenAI API：官方图片和视频生命周期不一致，且不能满足内部永久任务与统一调度需要。
- 图片同步、视频异步：会形成两套重试、超时和成本语义。
