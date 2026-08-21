# ADR-0003：Worker 出站拉取与本地模型合同

- 状态：Accepted
- 日期：2026-08-19

## 背景

GPU Worker 运行在外部供应商区域。供应商可以生成公网服务 URL，但直接暴露 ComfyUI/模型端口会扩大攻击面，并将平台与特定推理实现绑定。H3 Model App 又不能被限制为 Bun 或 TypeScript。

## 决策

- 平台提供标准 Bun Worker Agent，Agent 主动通过 HTTPS 连接 Worker Control API。
- Agent 使用长轮询领取 Task、续租、下载输入、上传输出和报告状态。
- Model App 只在 localhost 实现语言无关 HTTP Contract，不直接连接平台基础组件。
- Agent 与 Model App 共享单任务隔离目录。
- Model App 不获得平台、供应商或长期 S3 凭证。

## 结果

GPU 数据面只需要稳定出站网络，避免公网模型入口。模型团队可以自由选择 Python、C++、Rust 等技术。平台承担一个额外 Agent 进程和本地协议维护成本。

## 未选择方案

- 控制面主动调用供应商公网模型端口：安全、鉴权和网络可靠性较差。
- Model App 直接消费 Redis：耦合队列、租约和凭证，语言实现容易产生状态分叉。
- 强制所有模型使用 Bun：不适合主流 GPU 推理生态。
