# H3 Model App 预留目录

这里放置生产 H3/10Eros Model App 的镜像构建和运行时实现。当前不包含真实模型调用，避免本地开发隐式下载权重或占用 GPU。

实施依据：

- [Model App 编写规范](../../docs/16-model-app-implementation.md)
- [Worker Contract](../../docs/05-model-worker-contract.md)
- [10Eros ComfyUI 部署](../../docs/11-10eros-comfyui-deployment.md)

生产镜像必须固定 OCI digest、ComfyUI commit、自定义节点 commit、workflow hash、权重 hash、Attention backend、Block Cache 参数和输出 Schema。
