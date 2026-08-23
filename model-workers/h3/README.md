# H3 Model App 运行时准备

这里放置基于 Work-Fisher `Ref2VA` 参考媒体链路的 H3 Model App。镜像包含无模型的 Python HTTP 适配器和固定 API-format workflow；ComfyUI、所有自定义节点和 CUDA/PyTorch 依赖必须在派生镜像构建阶段固定，容器启动阶段只允许按清单校验/下载权重。

实施依据：

- [Model App 编写规范](../../docs/16-model-app-implementation.md)
- [Worker Contract](../../docs/05-model-worker-contract.md)
- [10Eros ComfyUI 部署](../../docs/11-10eros-comfyui-deployment.md)
- [Work-Fisher H3 Model App 准备](../../docs/20-work-fisher-h3-model-app-preparation.md)

生产镜像必须固定 OCI digest、ComfyUI commit、自定义节点 commit、workflow hash、权重 hash、Attention backend、Block Cache 参数和输出 Schema。

## 启动契约

基础镜像默认不下载任何文件。测试 Provider 必须显式设置：

```text
H3_RUNTIME_WEIGHT_DOWNLOAD_ENABLED=true
H3_WEIGHT_MANIFEST=/etc/astra/h3/weight-manifest.json
H3_WEIGHT_ROOT=/var/lib/astra/h3/weights
H3_WEIGHT_ALLOWED_HOSTS=hf-mirror.com,huggingface.co,cdn.hf.co,cdn-lfs.hf.co,xethub.hf.co
H3_WEIGHT_DOWNLOAD_MAX_RETRIES=2
HTTPS_PROXY=http://<approved-proxy>
H3_MODEL_APP_COMMAND_JSON=["python3","/opt/astra/h3/server.py"]
H3_COMFYUI_URL=http://127.0.0.1:8188
H3_COMFYUI_INPUT_DIR=/opt/comfyui/input
H3_COMFYUI_OUTPUT_DIR=/opt/comfyui/output
H3_COMFYUI_COMMAND_JSON=["python3","/opt/comfyui/main.py","--listen","127.0.0.1","--port","8188"]
H3_SMOKE_EXECUTION_ENABLED=true
```

清单中的每个条目必须有 HTTPS URL、固定 revision 对应的路径、目标相对路径、字节数和 SHA-256。下载先写 `.partial`，校验通过后原子替换；大小或哈希不匹配会让容器以配置错误退出。代理变量由 Python 标准库读取，内部地址应通过 `NO_PROXY` 绕过代理。

稳定 Profile 应设置 `H3_RUNTIME_WEIGHT_DOWNLOAD_ENABLED=false`，由 Provider 预热流程把已审核的内部 Weight Artifact 放到同一个 `H3_WEIGHT_ROOT`，Model App 只做本地校验。稳定 Replica 不允许访问 Hugging Face、hf-mirror.com 或其他公网模型源。

`H3_MODEL_APP_COMMAND_JSON` 必须是非空 JSON 字符串数组。基础镜像不会安装 ComfyUI、Python 包、节点或其他模型资产，也不会在本地提供确定性产物来代替真实推理。默认命令启动 `src/server.py`，它只代理同容器 `127.0.0.1:8188` 的 ComfyUI API；模型团队需要在派生镜像中加入固定 ComfyUI、节点和 CUDA/PyTorch 依赖。可以通过 `H3_COMFYUI_COMMAND_JSON` 让适配器以无 shell 子进程启动已经打入镜像的 ComfyUI，也可以由镜像 supervisor 启动它；两种方式都不会在启动时安装或下载依赖。

## Work-Fisher 运行合同

- `workflow_ref2va_api.json` 是从用户提供的 72 节点 UI graph 中冻结的 Group 63 参考媒体子图，不包含布局、预览 URL 或 RunningHub 路径。
- `MiniMaxH3AudioConditioningT8`、`MiniMaxH3MultiRateSamplerEXPT8`、`MiniMaxH3MemoryEfficientSageAttentionPatch`、`LoraLoaderBypassModelOnly` 和 `VHS_VideoCombine` 的版本必须与 Release Manifest 一起固定。
- `input_files` 中的 `image`、`video`、`audio` 会被按角色复制到 ComfyUI input 目录：图片连接 `ref_images`/首尾帧，视频通过 `LoadVideo -> GetVideoComponents` 连接 `ref_videos` 与对应音频，音频连接 `ref_audios`。复制是字节级操作，不转码。
- 适配器只调用 `/prompt`、`/history/{prompt_id}` 和 `/interrupt`，不把 ComfyUI API 暴露给业务调用方，也不让 ComfyUI 访问平台数据库、队列、Provider 或 S3。
- ComfyUI history 中的 MP4 被原样复制到 Attempt `output_dir`，随后用 `ffprobe` 做完整解码、尺寸、时长、FPS、音轨和 hash 验证，产物 manifest 的 `transformations` 保持空数组。

`weight-manifest.json` 登记了本工作流实际加载的五个权重及固定 Hugging Face revision、大小和 LFS SHA-256。清单是下载合同，不代表仓库包含任何权重；提交前必须运行 `bun run model-artifacts:check`。
