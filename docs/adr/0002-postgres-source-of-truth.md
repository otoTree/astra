# ADR-0002：PostgreSQL 为真源，Redis 为可重建执行索引

- 状态：Accepted
- 日期：2026-08-19

## 背景

系统选择 Redis Cluster 承载高频队列操作，但 Task 需要永久记录、严格状态机、幂等、租约和审计。若 Redis 同时成为状态真源，故障恢复会出现双写和状态分裂。

## 决策

- PostgreSQL 是 Task、Attempt、Lease、策略、容量期望和审计的唯一权威来源。
- Redis 保存公平队列排序、候选索引、限流和短期缓存。
- Scheduler 从 Redis 取得候选后必须用 PostgreSQL CAS 创建 Attempt 与 Lease。
- Task 事务通过 Outbox 驱动 Redis Relay；Redis 全量丢失时从 PostgreSQL重建。
- Redis 不可用时暂停新 Lease，不根据缓存继续改变业务状态。

## 结果

核心路径多一次数据库确认，但得到明确的一致性与恢复模型。Redis 可以按吞吐扩展或整体替换，不会丢失已接受任务。

## 未选择方案

- Redis 为任务真源：不符合永久记录和关系审计需求。
- PostgreSQL 单独承担所有队列排序：组件更少，但公平队列热点和限流会集中到数据库。
- Redis Streams 作为执行队列：取消、优先级调整、公平排序和租约控制较复杂。
