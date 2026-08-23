# 工作流资料

这里保存用于研究和复现的 ComfyUI API 工作流 JSON。它们是输入资料，不是已经通过发布门的 Model Release。

## 10Eros-Max V3

文件：`(10Eros-Max V3)Minimax参考生视频BF16高质量加速版V3.json`

- 来源：用户提供的 ComfyUI API 工作流导出文件
- SHA-256：`f3eec51d53c3da66f04abafdb1be3756aa3e5c2e7682b2b0ca3f317d7c0f4a7b`
- 对应研究：[H3 Ref2VA 工作流研究](../10-h3-ref2va-workflow-research.md)
- 当前定位：`10Eros_Max_h3_fl2va_bf16_test3_pruned` + `MiniMaxH3ReferenceToVideo` 的实验模板

## Work-Fisher MiniMax H3 工作流合集

文件：[【Work-Fisher】MINIMAX-H3工作流合集.json](./【Work-Fisher】MINIMAX-H3工作流合集.json)

- 来源：用户提供的 ComfyUI UI 工作流合集
- SHA-256：`f52d7e9e1e954907a18f3936832b1da8006d1ba6b543bfdfe744df28d0b8d864`
- 规模：72 个节点，包含文档节点、三条独立示例链和可选分组开关
- 主要参考媒体分组：`多图参考1`（Group 63）与 `单图参考1`（Group 62）
- 当前定位：研究资料与 Model App 迁移输入，不是已经冻结的 API-format workflow

该文件保留原始节点、布局、提示词模板、本地素材文件名和 RunningHub 输出元数据，不能直接上传到 ComfyUI `/prompt`。生产 Model App 必须从对应分组提取 API-format 子图，删除 MarkdownNote、UI 布局、预览 URL、本地样例文件名和未使用分支，再由固定 allowlist 映射平台 `input_files`、`aspect_ratio`、`resolution`、`duration`、`prompt` 与 `audio`。

面向本平台的主力候选是参考媒体路径：

1. `MiniMaxH3AudioConditioningT8` 接收参考图片、参考视频、参考视频音频和独立参考音频。
2. `MiniMaxH3MultiRateSamplerEXPT8` 使用视频/音频分步配置；当前合集示例为视频 8 步、音频 10 步，不能直接视为 10Eros 质量基线。
3. `MiniMaxH3MemoryEfficientSageAttentionPatch` 和 `LoraLoaderBypassModelOnly` 属于运行时/加速选项，必须作为 Release Profile 单独验收。
4. `MiniMaxH3AVDecodeT8` 输出联合音视频 latent 的视频与音频分量，平台只原样搬运 Model App 产物，不做平台转码。

导入前必须核对自定义节点 commit、实际模型文件、VAE/文本编码器、CUDA/PyTorch ABI、输入素材角色和输出容器。文件中出现的 `.safetensors`、`.png`、`.mp3` 仅是工作流引用，不代表这些资产已存在于仓库；本仓库不得下载或缓存它们。

导入 ComfyUI 前应检查自定义节点、模型权重、VAE、CLIP、CUDA/PyTorch 版本和本地素材是否已准备。JSON 中的 `SaveVideo format=auto/codec=auto`、节点元数据推荐权重、未连线参考图等内容不能直接视为生产合同；具体阻断项见研究文档。
