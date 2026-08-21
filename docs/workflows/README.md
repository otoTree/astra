# 工作流资料

这里保存用于研究和复现的 ComfyUI API 工作流 JSON。它们是输入资料，不是已经通过发布门的 Model Release。

## 10Eros-Max V3

文件：`(10Eros-Max V3)Minimax参考生视频BF16高质量加速版V3.json`

- 来源：用户提供的 ComfyUI API 工作流导出文件
- SHA-256：`f3eec51d53c3da66f04abafdb1be3756aa3e5c2e7682b2b0ca3f317d7c0f4a7b`
- 对应研究：[H3 Ref2VA 工作流研究](../10-h3-ref2va-workflow-research.md)
- 当前定位：`10Eros_Max_h3_fl2va_bf16_test3_pruned` + `MiniMaxH3ReferenceToVideo` 的实验模板

导入 ComfyUI 前应检查自定义节点、模型权重、VAE、CLIP、CUDA/PyTorch 版本和本地素材是否已准备。JSON 中的 `SaveVideo format=auto/codec=auto`、节点元数据推荐权重、未连线参考图等内容不能直接视为生产合同；具体阻断项见研究文档。

