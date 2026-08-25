# 共绩适配说明

## 1. 鉴权和请求签名

所有接口详情页都以供应商定义为准。当前快照显示的公共请求头为：

| Header | 类型 | 说明 |
| --- | --- | --- |
| `token` | string | 共绩平台 API 密钥；由 Secret 注入，不能写日志 |
| `timestamp` | integer/string | RSA 签名模式使用的毫秒级 Unix 时间戳 |
| `version` | string | RSA 签名模式的接口版本，当前详情页通常为 `1.0.0` |
| `sign_str` | string | 可选；启用 RSA 签名模式时发送，简易 Token 模式不发送 |

供应商签名参考流程为 RSA-SHA256、PKCS#1 v1.5、Base64。Astra 默认使用供应商文档中的简易 Token 模式；只有显式配置 `GONGJI_PRIVATE_KEY_PEM` 时才启用签名。待签名字符串的形式是：

```text
{path}\n{version}\n{timestamp}\n{token}\n{body}
```

其中 `path` 是不含域名和查询字符串的请求路径，`body` 使用实际发送的 JSON 字节对应的规范化字符串；GET 无请求体时使用空字符串。签名算法、加密模式和密钥格式必须以供应商当前正式文档及合同测试最终确认，不能仅凭示例推断。

需要加密的接口遵循“先加密、后签名”：使用平台提供的 RSA 公钥对请求体分段加密，拼接密文块并整体 Base64 编码为 `encrypted_body`；HTTP body 发送该 Base64 字符串，同时待签名字符串的 `body` 也必须使用完全相同的 `encrypted_body`。未加密接口直接使用规范化 JSON body。加密接口的具体块大小、密钥编码和响应解密规则以供应商正式文档为准，必须在 Adapter 中封装，不能散落在各业务用例。

当前 Apifox 页面还引用了供应商外部签名文档（`suanli.cn`）。本地适配说明已记录公共头、算法和待签名字符串，但不把外部页面当作运行时依赖；实现前必须用供应商提供的测试凭证完成正向、验签失败、时间漂移和请求体字节一致性测试。

不要在 Scheduler、公共 API 或数据库领域模型中出现上述 Header；它们只属于 `provider-gongji` 的 transport 层。

## 2. 响应 Envelope

大多数详情页使用：

```json
{
  "code": "0000",
  "message": "success",
  "data": {}
}
```

供应商文档说明 `code != "0000"` 时 `data` 通常为 `null`。Adapter 必须：

- 保存 `provider_code`、脱敏 `provider_message`、HTTP 状态、request ID 和 operation ID。
- 将成功、可重试、限流、签名失败、参数错误、资源不足、状态冲突和未知错误映射为通用 Provider Error。
- 对 `C999` 等通用失败不做无限重试；签名/鉴权错误直接熔断写操作。
- 不把供应商原始 message 直接返回给公共调用方。

各接口的完整 code 枚举和响应字段仍以对应 `api/api-*.md` 为准；不同接口可能出现额外业务码，Adapter 不能用一个全局枚举替代详情页定义。

部分旧版接口的详情页在供应商当前公开索引中已不存在，但新版页面仍可能保留旧链接（例如 `api-296882076.md`）。这类链接不纳入本地 67 个当前接口清单；如生产 Adapter 仍需调用旧路径，必须先向共绩确认版本和文档，再单独建立带来源、生命周期和合同测试的 legacy 目录。

## 3. 幂等、轮询和 Reconcile

- 供应商没有统一的 Astra 幂等键时，在数据库保存 `provider_operation_id`、请求哈希和资源目标，使用 PostgreSQL CAS 防止重复创建。
- Provider Controller 以期望状态驱动查询和修改，不能把一次 API 成功响应直接当作最终 observed state。
- 创建、更新、暂停、恢复、删除、预热和回收都必须设置超时、指数退避、Retry-After、熔断和最大重试次数。
- 供应商任务查询是最终一致的；创建后先记录 `provisioning`/`pending`，由 reconcile 读取详情和节点状态推进。
- Provider 超时不等于资源不存在；必须先查询和对账，再决定重试或创建新操作。

## 4. 与模型镜像 Rollout 的映射

共绩镜像预热接口对应平台的 `prewarm` 操作；弹性 Deployment/节点接口对应 `ensureDeployment`、`resizeDeployment`、`drain` 和 `reclaim`。新镜像必须先预热并通过 Worker readiness、capabilities、smoke 和媒体门，再开放新 Release 接收新任务。旧 Release 通过 Worker `drained` 回报后才允许回收。

## 5. 本地 Provider Adapter 合同参考实现

Provider Adapter 合同参考实现必须覆盖这些类别：资源列表、弹性任务生命周期、镜像预热、Job/队列、节点状态/日志/事件、计费、对象存储和裸金属。它不访问真实共绩，但返回结构应使用详情页中的请求/响应 Schema 和可配置错误码，确保接口在无 GPU 的 Mac 上可验证。
