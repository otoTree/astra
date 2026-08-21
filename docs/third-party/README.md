# 第三方源码快照

## ComfyUI

`ComfyUI/` 是 Astra 研究 H3 工作流所依据的上游 ComfyUI 源码快照，来源为：

- 上游仓库：<https://github.com/comfyanonymous/ComfyUI>
- 快照方式：浅克隆（`--depth 1 --no-tags`）
- 当前提交：`8583b0ce0a813c6215e2c304d08bf597e2993c37`
- 用途：阅读节点实现、确认输入输出合同、辅助工作流静态研究

该目录不是 Astra 的生产运行时，也不应被控制面或 Worker Agent 直接依赖。生产镜像必须在独立构建流程中固定完整 commit、Python/CUDA/PyTorch 依赖、第三方节点 commit、模型权重哈希和容器 digest。

更新该快照时，应在本文件和 H3 研究文档中同步记录新的完整 commit，并重新执行相关节点合同和模型发布门测试。

## ComfyUI-H3-FaceRefine

`ComfyUI-H3-FaceRefine/` 是用于研究 H3 小脸二次生成和回贴的第三方节点快照：

- 上游仓库：<https://github.com/Carasibana/ComfyUI-H3-FaceRefine>
- 快照方式：浅克隆（`--depth 1 --no-tags`）
- 当前提交：`79a97ce5ee4b393ce26313bd1280b706fe8b4f2c`
- 用途：研究逐帧人脸跟踪、H3 视频 latent 注入、按脸部大小调 denoise 和回贴合同
- 研究文档：[13-10eros-h3-face-refine-research.md](../13-10eros-h3-face-refine-research.md)

该节点集会触发第二次 H3 推理，不能作为普通后处理依赖直接加到稳定 10Eros 镜像。生产使用必须固定检测器、InsightFace/SAM 资产、Python 依赖和许可证，并通过独立 Release profile 的资源、质量和输出门。
