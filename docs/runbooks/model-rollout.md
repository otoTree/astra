# 模型镜像滚动发布手册

本手册用于已经批准的不可变 Model Release。控制面只处理 OCI digest、Manifest、能力和权重哈希元数据，
不下载或运行权重。真实 GPU 与质量验证由人类模型团队在隔离环境签署。

## 1. 发布前检查

1. 确认 source Release、target Release、Pool 和 Alias 均属于同一项目与模型。
2. target Release 状态必须为 `approved`，镜像必须固定为 `repository@sha256:...`；不得直接发布 mutable tag。
3. Pool 的 capacity、budget、region 和 retry 策略均已发布，Provider 快照为 fresh，目标区域存在兼容 GPU 库存。
4. 确认 `maximum_extra_cost_minor` 覆盖预热和新旧实例重叠计费，旧 digest 尚在回滚保留期。
5. 检查 Provider Controller `/health/ready` 中 `operation_reconcile` 与 `rollout_reconcile` 都是 `ready`。

## 2. 标准操作

1. 在管理台选择 target Release 和 Pool，提交 Rollout Preview。
2. 核对 source/target digest、替换台数、库存快照、额外成本、临时容量下降和队列风险。
3. 使用 preview ID 创建 Rollout。默认使用 `max_surge=1`、`max_unavailable=0` 和 `batch_size=1`。
4. 观察每个 Step 依次经过 `provisioning -> validating -> target_ready -> draining_old -> replacing -> completed`。
5. 新 Worker 验证前必须保持 `rollout_reserved=true`；旧 Worker 只有在旧 Release 队列清零后才进入 drain。
6. Rollout 完成后确认 Alias 指向 target、旧 Worker 已 `drained`、旧 Provider 资源已回收且费用记录已更新。

每次管理写请求必须携带新的 `Idempotency-Key`、当前资源版本对应的 `If-Match` 和不少于八个字符的原因。
网络超时后先用原幂等键查询或重放，禁止更换键盲目创建第二个 Rollout。

## 3. 运行中任务

- drain 只停止领取新 Attempt，不取消已有 Attempt。
- `running`、`reserved` 或 `unknown` 槽位都不能回收；`unknown` 必须等待 Lease 与 orphan grace period。
- 旧 Release 的 queued Task 保持原 Release 身份，由旧 Worker 排空；Alias 切换不会迁移已有 Task。
- 只有 Worker 上报 `drained` 且 PostgreSQL 不存在有效 Lease 后，Provider terminate 才可执行。

## 4. 暂停与恢复

出现镜像拉取失败、验证失败、digest/capabilities 不一致、进度超时、预算越界或供应商错误时，Controller 自动
暂停。暂停后先记录 Rollout/Step、Provider Operation、Worker 验证证据、库存快照年龄和告警时间，再处理根因。

恢复前必须确认：失败原因已消除、目标 digest 未变化、Provider 快照仍有效、额外成本仍在上限内。使用当前
Rollout version 执行 resume；不要修改历史 Step 或重用其他 Release 的验证报告。

## 5. 回滚

1. 使用当前 Rollout version 和明确原因请求 rollback。
2. 确认 Alias 已先切回 source Release，target Release 已停止接收新 Task。
3. 保留 target Worker 处理其已固定的 queued/running Task；事故级禁止继续执行时显式取消并审计。
4. 如果 source digest 没有热实例，等待相同的预热和 Worker 验证门通过。
5. 观察反向逐机替换，直到 source 容量恢复、target Worker drained 并回收。

不得删除 Candidate Release、Rollout、Step、Event 或 Provider Operation。回滚依赖这些不可变记录收敛供应商
状态和防止重复计费资源。

## 6. 指标与告警

至少观察：

- `astra_rollout_reconcile_total{outcome}`：持续 `paused`、`failed` 或相同 waiting reason 需要排查。
- `astra_rollout_active{status}`：同一 Pool 只能有一个活动 Rollout。
- `astra_rollout_oldest_age_seconds`：超过 `progress_deadline_seconds` 应自动暂停。
- Provider operation backlog/retry、Worker heartbeat、Lease expiry、旧/新 Release 队列深度和额外成本。

告警恢复必须同时满足数据库期望状态、Worker 状态和 Provider 观察状态一致，不能只以供应商控制台显示为准。

## 7. 应用回滚

先暂停活动 Rollout 并确认 Controller 不再创建新操作，再回滚应用镜像。数据库迁移不降级，不删除新增列或历史
表。Worker Control API 保持运行以续租、接收结果和 `drained`；Provider Controller 恢复后依靠数据库租约、
确定性 operation key 和供应商资源观察继续 Reconcile。
