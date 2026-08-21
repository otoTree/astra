# ADR-0006：模型输出字节保真与显式后处理

## 状态

已采纳

## 背景

Astra 的 Worker Agent 负责把任意语言实现的 Model App 接入统一任务平台。视频和图片模型的容器、编码、像素格式、音频参数和元数据可能不同。若 Agent 为了提供“统一格式”而调用 FFmpeg 转码或重新封装，会引入质量损失、元数据丢失、音画同步变化和不可复现的编码漂移，也会让平台承担模型应用本不声明的语义。

## 决策

1. Model App 负责生成并声明原始产物。Release Manifest 必须声明允许的 `content_types`、容器、视频/音频编码、媒体元数据、输出数量和 sidecar 能力。
2. Worker Agent 只负责路径安全、大小、SHA-256、MIME、完整解码/可读性检查、Release Schema 校验和 S3 上传。S3 保存的对象字节必须与 Model App 输出文件完全一致。
3. Agent 不得转码、裁切、重采样、改 FPS、改变像素格式或重新封装，也不得偷偷生成缩略图或预览文件。FFmpeg 仅可作为 probe/decoder 使用。
4. 需要派生格式或严格时长的能力，必须由 Model App 在镜像内部显式生成并纳入该 Release，或通过独立后处理 Task/Release 提供。派生结果与原始结果分别记录 Artifact 和 provenance。
5. Task API 统一 Task 生命周期和 Artifact 元数据，不承诺所有模型使用 MP4、H.264 或 AAC。调用方必须读取 `content_type` 和 `media` 字段。

## 影响

优点：保留模型结果的完整信息，避免隐藏转换导致的质量和同步变化；通过原始 SHA-256 可以审计和复现；模型团队可以使用适合模型的格式。

代价：调用方需要处理不同 Release 的媒体格式；播放器预览和统一转码必须显式部署和计费；每个 Release 要维护更完整的输出 Schema 和验收样本。

## 约束与验证

- Agent 上传前必须重新计算 SHA-256 和大小，并执行完整媒体解码。
- `output_manifest_invalid`、`output_integrity_check_failed` 与模型自身的 `output_generation_failed` 分开记录。
- H3 工作流若要满足精确 4-15 秒交付，必须在模型镜像内部增加裁切/封装步骤并创建新 Release；平台不能在输出后补做。
- 已保存 Artifact 不因后续 Release 变更而改写。回滚通过 Alias 和镜像 digest 完成，不修改旧对象。

## 被否决的方案

在 Worker Agent 上传流程中统一转成 H.264/AAC MP4，或用平台统一 FPS、像素格式和采样率。该方案违反原始产物保真、增加隐性计算成本，并可能改变模型输出语义。

