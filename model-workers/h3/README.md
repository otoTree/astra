# H3 Model App 运行时准备

这里放置生产 H3/10Eros Model App 的运行时准备文件。当前不包含真实模型调用或权重；`Dockerfile` 是供模型团队扩展的无权重基础镜像，负责在远端测试容器启动时按固定清单校验/下载资产，然后执行模型团队提供的 Model App 命令。

实施依据：

- [Model App 编写规范](../../docs/16-model-app-implementation.md)
- [Worker Contract](../../docs/05-model-worker-contract.md)
- [10Eros ComfyUI 部署](../../docs/11-10eros-comfyui-deployment.md)

生产镜像必须固定 OCI digest、ComfyUI commit、自定义节点 commit、workflow hash、权重 hash、Attention backend、Block Cache 参数和输出 Schema。

## 启动契约

基础镜像默认不下载任何文件。测试 Provider 必须显式设置：

```text
H3_RUNTIME_WEIGHT_DOWNLOAD_ENABLED=true
H3_WEIGHT_MANIFEST=/etc/astra/h3/weight-manifest.json
H3_WEIGHT_ROOT=/var/lib/astra/h3/weights
H3_WEIGHT_ALLOWED_HOSTS=hf-mirror.com,huggingface.co
HTTPS_PROXY=http://<approved-proxy>
H3_MODEL_APP_COMMAND_JSON=["python3","/opt/model-app/server.py"]
```

清单中的每个条目必须有 HTTPS URL、固定 revision 对应的路径、目标相对路径、字节数和 SHA-256。下载先写 `.partial`，校验通过后原子替换；大小或哈希不匹配会让容器以配置错误退出。代理变量由 Python 标准库读取，内部地址应通过 `NO_PROXY` 绕过代理。

稳定 Profile 应设置 `H3_RUNTIME_WEIGHT_DOWNLOAD_ENABLED=false`，由 Provider 预热流程把已审核的内部 Weight Artifact 放到同一个 `H3_WEIGHT_ROOT`，Model App 只做本地校验。稳定 Replica 不允许访问 Hugging Face、hf-mirror.com 或其他公网模型源。

`H3_MODEL_APP_COMMAND_JSON` 必须是非空 JSON 字符串数组。基础镜像不会启动 ComfyUI，也不会提供确定性产物来代替真实推理；模型团队必须在派生镜像中加入固定 ComfyUI、节点、API-format workflow 和 Worker Contract HTTP 服务，再提交 OCI digest 进入 Release 流程。
