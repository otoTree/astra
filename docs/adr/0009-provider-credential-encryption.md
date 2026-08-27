# ADR-0009：共绩凭证密文存储

## 状态

已接受。

## 决策

共绩 Token 作为业务凭证保存在 PostgreSQL `provider_credentials` 表中，但只保存 AES-256-GCM
密文和 SHA-256 指纹。解密主密钥由 Secret Manager 注入 `PROVIDER_CREDENTIAL_ENCRYPTION_KEY`，不写入数据库。
Provider Controller 通过仓储读取当前 active 版本，在内存中短暂解密后传给共绩 Adapter；日志、Outbox、审计
和 API 响应均不得包含明文 Token。轮换通过新增版本并撤销旧版本完成，读取使用版本条件收敛。

`GONGJI_TOKEN` 仅保留为 local/test 的一次性引导输入，首次读取时加密写入数据库；生产配置不要求也不接受
该环境变量作为长期凭证来源。私钥签名模式仍是可选兼容能力，Token-only 是默认模式。

## 后果

- 数据库备份泄露不会直接暴露共绩 Token，但主密钥必须独立轮换和托管。
- Provider Controller 启动依赖迁移后的凭证表；凭证缺失时共绩状态为不可用，不会静默使用空 Token。
- 管理台通过受保护的 Admin API 完成轮换、吊销和审计，而不是修改环境变量；查询响应只包含状态、版本和 SHA-256 指纹。
