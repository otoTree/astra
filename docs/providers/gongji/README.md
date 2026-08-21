# 共绩算力 Provider API 本地镜像

本目录保存共绩科技 Open API 的本地文档快照，供 `provider-gongji` Adapter、合同测试和运维排障使用。它是供应商协议镜像，不是 Astra 公共 API；调度器、Task 领域和 Worker Contract 不得直接依赖这些字段。

## 快速入口

- [接口索引](./api-index.md)：按供应商文档分组列出全部接口、HTTP 方法、路径和本地详情页。
- [`api/`](./api/)：每个接口的原始 OpenAPI 3.0.1 Markdown 页面，包含请求参数、请求体 Schema、响应 Schema、示例和供应商错误码。
- [`source-llms.txt`](./source-llms.txt)：本次同步使用的 Apifox 文档索引原文。
- [共绩适配说明](./adapter-notes.md)：鉴权、签名、加密、错误映射、幂等和平台 Provider Contract 边界。

## 快照范围

- 来源：共绩算力 Open API Apifox 文档。
- 来源索引：<https://s.apifox.cn/6aa360d3-d8f2-471e-b841-3a35c33a7b7c/llms.txt>
- API Base URL：`https://openapi.suanli.cn`
- 本地接口详情页：67 个；每个详情页至少包含一个 OpenAPI path 和 HTTP operation。
- 同步方式：保留供应商 Markdown/OpenAPI 内容；仅将详情页之间的 Apifox 链接改为本地相对链接，不改写字段、枚举、错误码或响应 Envelope。
- 本次索引快照时间：`2026-08-19T17:13:53Z`；`source-llms.txt` SHA-256：`f87626e5815634989362579057a65cb55014ceaeace4950e9f72738b2b96d686`。

## 阅读规则

1. 先阅读 `adapter-notes.md`，了解哪些字段可以进入通用 Provider Contract。
2. 再从 `api-index.md` 找到目标接口，阅读对应 `api/api-*.md` 的完整 OpenAPI Schema。
3. 共绩 API 的 `token`、`timestamp`、`version`、`sign_str` 和加密/签名规则只在 Adapter 中实现。
4. 供应商原始 `code/message/data` 响应必须保存为受限诊断载荷，同时转换为平台内部标准错误；不能直接向公共 API 暴露。
5. 本地开发使用 Provider Adapter 合同参考实现，不得因为存在这些文档而向共绩发送请求。

## 与平台的边界

```text
Astra Scheduler
    -> Provider Contract
        -> provider-gongji Adapter
            -> 共绩 Open API
```

Adapter 负责资源查询、弹性 Deployment、镜像预热、Job、节点、费用、对象存储和裸金属 API 的 DTO 转换、签名、重试、熔断、幂等操作键和 reconcile。核心调度器只看通用资源、Replica、Capacity Plan、Provider Operation 和计费接口。

## 供应商文档变更

同步新版本时必须：

- 保留旧快照，不覆盖已用于生产的版本目录。
- 比较 path、method、请求字段、必填项、枚举、响应 code 和错误描述。
- 运行 Provider Adapter 合同测试、录制响应测试和影响预估。
- 若破坏通用 Contract 或改变状态语义，先新增 ADR，再修改适配器。
- 记录同步时间、来源索引哈希、详情页数量和变更摘要。

## 阶段 8 实现状态

当前 Adapter 只启用七类读取：资源、Deployment、节点、Job、镜像预热区域、镜像预热任务和计费。合同夹具位于
`packages/provider-gongji/fixtures/documented/`，由本目录 OpenAPI 示例裁剪并脱敏，不是对生产接口的实时请求。
本地 `PROVIDER_DRIVER=reference`，不会读取共绩凭证或连接 `openapi.suanli.cn`。

阶段 9 已实现 Deployment 创建/暂停/停止与镜像预热创建 Transport，但只能由 Provider Controller 根据数据库
Provider Operation 调用，不能绕过 Operation 与 Reconcile。模糊写入失败由确定性任务名查询收敛，不在 HTTP
客户端内盲目重放。真实供应商合同验证只能在隔离环境显式启用，并必须设置成本上限和自动回收。
