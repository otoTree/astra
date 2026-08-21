# 10Eros-Max V3 权重与依赖来源登记

## 1. 结论

本表只针对当前 10Eros-Max V3 工作流。地址分为三类：

- **已确认工作流地址**：工作流 MarkdownNote 或节点元数据内明确给出的 URL，可以作为官方 H3 资产候选来源。
- **代码仓库地址**：自定义节点的源码来源，不是模型权重。
- **未找到公开地址**：某项工作流只给出文件名，当前没有可验证的公开下载 URL；不能用相似模型或官方 Ref2VA 权重替代。

已确认真正的 10Eros UNET 位于 [TenStrip/10Eros-Max](https://huggingface.co/TenStrip/10Eros-Max)；仓库页面显示该文件约 40.2 GB。部署仍必须下载后自行计算 SHA-256、核对文件大小、safetensors header、许可证和分发授权，不能只信文件名。

下载传输可以在受控的 Weight Import Job 中选择 [hf-mirror.com](https://hf-mirror.com/) 加速。镜像不是权威来源；固定 commit、文件大小、SHA-256、safetensors header 和许可证校验规则见 [Hugging Face 镜像与权重供应链设计](./14-huggingface-mirror-and-weight-supply-chain.md)。

同时需要登记其基础模型来源：[MiniMaxAI/MiniMax-H3](https://huggingface.co/MiniMaxAI/MiniMax-H3)。官方仓库包含 `FL2VA/` 和 `Ref2VA/` 两个基础变体，总仓库页面约 498 GB；模型卡声明 H3-Base-FL2VA、H3-Base-Ref2VA、24 FPS、4-15 秒和 32 kHz 立体声音频。TenStrip 模型卡将 `MiniMaxAI/MiniMax-H3` 标为 `base_model`，并说明 10Eros 是在 H3 基础上 graft/转换的派生权重。

## 2. 模型权重登记

| 角色 | 工作流实际文件 | 可验证来源 | 状态与用途 |
| --- | --- | --- | --- |
| UNET | `10Eros_Max_h3_fl2va_bf16_test3_pruned.safetensors` | [TenStrip/10Eros-Max 固定提交下载](https://huggingface.co/TenStrip/10Eros-Max/resolve/d04ab4ce5ad0b104965d7f76fbe2223be87cae0d/10Eros_Max_h3_fl2va_bf16_test3_pruned.safetensors?download=true)；[仓库文件页](https://huggingface.co/TenStrip/10Eros-Max/blob/main/10Eros_Max_h3_fl2va_bf16_test3_pruned.safetensors) | **已确认文件名匹配**，页面显示约 40.2 GB。固定提交为 `d04ab4ce5ad0b104965d7f76fbe2223be87cae0d`；下载后必须登记 SHA-256。禁止替换成官方 `ref2va_pruned_int8_convrot`。 |
| CLIP | `qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors` | [Comfy-Org/MiniMax-H3](https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors) | **工作流内置官方候选地址**。下载后仍需记录实际 SHA-256/大小。 |
| Video VAE | `minimax_h3_video_vae_fp16.safetensors` | [Comfy-Org/MiniMax-H3](https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/vae/minimax_h3_video_vae_fp16.safetensors) | **工作流内置官方候选地址**。与当前 JSON 实际 `VAELoader` 选择一致。 |
| Audio VAE | `minimax_h3_audio_vae_fp32.safetensors` | [Comfy-Org/MiniMax-H3](https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/vae/minimax_h3_audio_vae_fp32.safetensors) | **工作流内置官方候选地址**。与当前 JSON 实际 `VAELoader` 选择一致。 |
| 官方 Ref2VA 对照 UNET | `minimax_h3_ref2va_pruned_int8_convrot.safetensors` | [Comfy-Org/MiniMax-H3](https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors) | **仅为官方对照/节点元数据推荐项，不是 10Eros 实际权重**。只能用于机械或质量对照，不能放入 10Eros Release。 |

## 2.1 基础模型与运行时权重的关系

| 层次 | 地址 | 是否需要作为 10Eros Replica 的额外 UNET |
| --- | --- | --- |
| 官方基础模型/架构来源 | [MiniMaxAI/MiniMax-H3](https://huggingface.co/MiniMaxAI/MiniMax-H3) | 通常不需要。10Eros test3 文件本身作为当前 `UNETLoader` 输入；基础仓库用于溯源、代码/配置对照和许可证确认。 |
| ComfyUI 转换资产 | [Comfy-Org/MiniMax-H3](https://huggingface.co/Comfy-Org/MiniMax-H3) | 需要其中工作流实际选择的 CLIP、Video VAE、Audio VAE；不要把官方 Ref2VA INT8 UNET 与 10Eros test3 同时加载。 |
| 10Eros 派生 UNET | [TenStrip/10Eros-Max](https://huggingface.co/TenStrip/10Eros-Max) | **需要**。这是当前唯一生产候选 UNET；固定 test3 文件的 commit 和 SHA-256。 |

不要因为存在 `MiniMaxAI/MiniMax-H3` 基础模型地址，就在 Worker 启动时再下载一份 498 GB 的完整基础仓库。若 10Eros 文件是完整可加载 checkpoint，运行时只需它、工作流所需 CLIP/VAE 和节点依赖；是否还需要基础仓库中的 tokenizer/config/processor，要以实际 ComfyUI 镜像和 `UNETLoader`/`CLIPLoader` 的启动日志验证。

### 2.1 地址状态说明

工作流 JSON 的 `UNETLoader.properties.models` 仍显示官方 Ref2VA INT8 文件的 URL，但 `widgets_values` 实际选择的是 `10Eros_Max_h3_fl2va_bf16_test3_pruned.safetensors`。本次已在 TenStrip 仓库确认该文件存在，因此应使用 TenStrip 文件，不得根据节点元数据自动替换为官方 INT8 UNET。

Hugging Face 的 `main` 文件页会继续变化；Release 必须使用上表中的 commit 固定 URL，或者把下载后的 blob 存入自有 Weight Artifact 并以 SHA-256 作为唯一身份。

官方 H3 地址来自用户提供的工作流 MarkdownNote 和节点模型元数据；正式下载时应使用固定 revision/commit 或下载后立即计算 SHA-256，不能使用 `main` 作为 Release 身份。本文不把 URL 请求成功等同于文件内容可信，也未下载几十 GB 的模型文件。

### 2.2 模型卡与许可证

TenStrip 模型卡声明 `minimax-h3-community-license-agreement`，并说明该发布包含来自 LTX 2.3、Wan 2.2 和 Krea 2 的 transferred character，因此相应来源模型的社区许可证也可能适用于对应部分。内部生产使用前必须由安全/法务确认许可证、再分发、商用和生成内容条款；不能因为文件位于 Hugging Face 就默认拥有自由再分发权。

## 3. 自定义节点和依赖源码

这些不是权重，但必须进入 Model App 镜像并固定版本：

| 能力 | 仓库 | 当前研究 commit | 用途 |
| --- | --- | --- | --- |
| H3 核心节点 | [Comfy-Org/ComfyUI](https://github.com/Comfy-Org/ComfyUI) | 研究快照 `8583b0ce0a813c6215e2c304d08bf597e2993c37` | `MiniMaxH3ReferenceToVideo`、VAE、Sampler 等 |
| H3 Block Cache | [T8mars/comfyui-minimax-h3-blockcache-T8](https://github.com/T8mars/comfyui-minimax-h3-blockcache-T8) | `28eda9860e19adabb2312ba254bd468bee32688e` | `MiniMaxH3BlockCacheT8` |
| SageAttention/KJ 节点 | [kijai/ComfyUI-KJNodes](https://github.com/kijai/ComfyUI-KJNodes) | `3f20054214fec9f9234fd3841ae6f1e4287948f6` | `PathchSageAttentionKJ` |

实际 RunningHub 环境的 commit 仍未知。上述版本只能作为可复现研究基线；生产镜像必须记录真实安装 commit、Python 包锁、CUDA/PyTorch 版本和编译产物。

### 3.1 可选 FaceRefine 节点集

| 能力 | 仓库/资产 | 研究版本 | 说明 |
| --- | --- | --- | --- |
| H3 小脸二次生成与回贴 | [Carasibana/ComfyUI-H3-FaceRefine](https://github.com/Carasibana/ComfyUI-H3-FaceRefine) | `79a97ce5ee4b393ce26313bd1280b706fe8b4f2c` | 逐帧检测、crop、H3 AV latent 注入、低 denoise 重采样和人脸区域 stitch；不是普通编码后处理。 |
| 人脸检测器 | [Bingsu/adetailer `face_yolov8m.pt`](https://huggingface.co/Bingsu/adetailer/blob/main/face_yolov8m.pt) | revision/SHA-256 待固定 | FaceRefine 首个 profile 的必需资产。 |
| 人体 fallback 检测器 | [Bingsu/adetailer `person_yolov8m-seg.pt`](https://huggingface.co/Bingsu/adetailer/blob/main/person_yolov8m-seg.pt) | revision/SHA-256 待固定 | 可选；缺失人脸时估计头部位置。 |
| 身份跟踪 | [InsightFace `buffalo_l`](https://github.com/deepinsight/insightface) | 包版本/模型 hash 待固定 | 仅多人或 identity reference 场景；禁止生产运行时联网下载。 |
| SAM mask | [Segment Anything `sam_vit_b_01ec64.pth`](https://github.com/facebookresearch/segment-anything#model-checkpoints) | revision/SHA-256 待固定 | 仅 SAM profile；首期矩形 mask 不依赖它。 |

FaceRefine 的示例还使用 GGUF H3 和 4-step Turbo LoRA，但这些不能替代 10Eros BF16 test3；详见 [FaceRefine 研究文档](./13-10eros-h3-face-refine-research.md)。

## 4. 取得 10Eros 权重时必须索取的资料

从作者、RunningHub 或供应商取得 `10Eros_Max_h3_fl2va_bf16_test3_pruned.safetensors` 时，交付包至少应包含：

```text
10Eros_Max_h3_fl2va_bf16_test3_pruned.safetensors
sha256sums.txt
size_bytes.txt
safetensors_header.json
license.txt
source_and_release.txt
```

`source_and_release.txt` 至少写明原始来源、训练/转换版本、是否 pruned/curve-projected、适用的 ComfyUI commit、目标 dtype、允许的商业/内部使用范围和禁止再分发限制。

## 5. 下载和入库流程

```text
临时下载目录
  -> TLS/凭证校验
  -> 计算 SHA-256、大小、safetensors header
  -> 人工核对来源与许可证
  -> S3/OCI Weight Artifact 上传（content-addressed）
  -> PostgreSQL 登记 Weight Manifest
  -> 预热节点下载到本地 NVMe
  -> Replica ready 前再次校验
```

任何文件名相同但 SHA-256 不同的文件都必须视为新权重、新 Release。禁止在 ComfyUI 启动时按模糊文件名挑选“最像”的权重，禁止从公网 URL 自动跟随 mutable `main` 或 `latest`。

## 6. 待办状态

| 事项 | 当前状态 | 下一步 |
| --- | --- | --- |
| 10Eros UNET 公开地址 | 已确认 | 使用 TenStrip 固定提交下载，并核对访问许可 |
| hf-mirror 导入加速 | 已验证 API/固定文件响应头；未下载完整权重 | 通过 Import Job 下载并计算 SHA-256 后入库，不让生产 Replica 访问镜像 |
| 10Eros UNET SHA-256/大小/dtype | SHA-256/dtype 未测；页面约 40.2 GB | 下载后离线审计并写入 Weight Manifest |
| 官方 CLIP/VAE 下载地址 | 已从工作流确认 | 固定 revision，下载后计算哈希 |
| Block Cache/KJNodes 源码地址 | 已确认 | 镜像构建时锁 commit 和依赖 |
| RunningHub 实际运行环境版本 | 未知 | 从导出环境或作者取得版本清单 |
