# Model Workers

`model-workers/` 不限制语言。每个模型应用只需实现 [Model App Worker Contract](../docs/05-model-worker-contract.md) 的 localhost HTTP 接口，并由标准 Bun Worker Agent 代理。

模型应用不得访问 PostgreSQL、Redis、Kafka、Provider 或 S3。输入来自 Agent 创建的 Attempt 工作目录，输出使用 manifest 描述并由 Agent 原样上传。

当前目录：

- `reference/`：Model App 合同参考实现，用于本地验证同一生产协议，不加载 GPU 权重。
- `h3/`：预留给 10Eros/MiniMax H3 镜像；生产实现应固定 ComfyUI、节点、工作流和权重 digest。
