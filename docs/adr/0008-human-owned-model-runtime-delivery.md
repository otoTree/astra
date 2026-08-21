# ADR-0008：真实模型运行时由人类模型团队交付

- 状态：接受
- 日期：2026-08-21

## 背景

Astra 控制面必须能够在没有模型权重和 GPU 的开发环境中完成 API、调度、Worker、Provider、发布、扩缩容、安全与灾备闭环。真实 H3/10Eros 的权重受体积、许可、供应链和 GPU 环境约束，且模型质量验收需要人类判断。

## 决策

平台团队交付并维护语言无关的 localhost Model App Contract、能力 Schema、输出 Manifest、合同测试套件、镜像 digest 发布协议以及机械媒体验收工具。仓库中的参考 Model App 只生成确定性、可严格解码的合同产物，用于本地和 CI 验证。

以下工作由人类模型团队在隔离 GPU 环境完成：

- 获取、校验和保管模型、VAE、LoRA、文本编码器及其他权重。
- 构建包含真实 ComfyUI、节点、工作流与权重引用的模型镜像。
- 实现真实推理、显存优化和质量调优。
- 提交固定 OCI digest、资产哈希清单和人工质量批准。

控制面仓库、默认 Compose、CI 和普通开发机不得下载、缓存、生成或执行真实权重。平台只消费人类提交的不可变镜像 digest 和声明式 Release Manifest；Rollout 仍必须执行 readiness、capabilities、smoke、资源和输出合同门。

## 结果

- 平台可以在无 GPU 环境完成生产级执行与发布状态机验证。
- 真实模型实现不改变 Public API、Worker Control API 或 Model App Contract。
- 权重来源、许可和质量责任有明确所有者。
- 参考 Model App 通过名称、日志和界面表达为合同实现，不冒充真实模型推理。
