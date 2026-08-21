import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import "./styles.css";

type Row = Record<string, unknown>;
type ListResponse = { data: Row[]; has_more: boolean; next_after: string | null };
type Session = { display_name: string | null; email: string | null; project_id: string; permissions: string[] };
type View = "overview" | "tasks" | "capacity" | "releases" | "audit";

const api = async <T,>(path: string): Promise<T> => {
  const response = await fetch(path, { credentials: "include", headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(response.status === 401 ? "session_required" : `request_failed:${response.status}`);
  return (await response.json()) as T;
};
const cookie = (name: string): string => {
  const prefix = `${name}=`;
  const value = document.cookie
    .split(";")
    .map((item) => item.trim())
    .find((item) => item.startsWith(prefix));
  return value ? decodeURIComponent(value.slice(prefix.length)) : "";
};
const mutate = async <T,>(
  path: string,
  method: "POST" | "PATCH",
  body: unknown,
  idempotencyKey: string,
  version?: number,
): Promise<T> => {
  const response = await fetch(path, {
    method,
    credentials: "include",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
      "x-csrf-token": cookie("astra_admin_csrf") || cookie("__Host-astra_admin_csrf"),
      ...(version === undefined ? {} : { "if-match": `"${version}"` }),
    },
    body: JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => ({}))) as T & { error?: { code?: string } };
  if (!response.ok) throw new Error(payload.error?.code ?? `request_failed:${response.status}`);
  return payload;
};
const text = (value: unknown, fallback = "-"): string =>
  value === null || value === undefined || value === "" ? fallback : String(value);
const time = (value: unknown): string =>
  typeof value === "number" ? new Date(value * 1000).toLocaleString("zh-CN", { hour12: false }) : "-";

function Status({ value }: { value: unknown }) {
  const status = text(value, "unknown");
  return <span className={`status status-${status}`}>{status}</span>;
}
function Empty({ label }: { label: string }) {
  return <div className="empty">{label}</div>;
}

function TaskTable({ onSelect }: { onSelect: (id: string) => void }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [after, setAfter] = useState<string | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async (cursor: string | null) => {
    setLoading(true);
    const result = await api<ListResponse>(
      `/admin/v1/tasks?limit=50${cursor ? `&after=${encodeURIComponent(cursor)}` : ""}`,
    );
    setRows(result.data);
    setNext(result.next_after);
    setLoading(false);
  }, []);
  useEffect(() => void load(after), [after, load]);
  if (loading) return <Empty label="正在读取任务" />;
  return (
    <>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Task</th>
              <th>模型</th>
              <th>类型</th>
              <th>优先级</th>
              <th>状态</th>
              <th>进度</th>
              <th>创建时间</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={text(row.id)} onClick={() => onSelect(text(row.id))} tabIndex={0}>
                <td className="mono">{text(row.id)}</td>
                <td>{text(row.model)}</td>
                <td>{text(row.type)}</td>
                <td>{text(row.priority)}</td>
                <td>
                  <Status value={row.status} />
                </td>
                <td>{row.progress === null ? "-" : `${text(row.progress)}%`}</td>
                <td>{time(row.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length === 0 && <Empty label="当前项目暂无任务" />}
      <div className="pager">
        <button type="button" disabled={!after} onClick={() => setAfter(null)}>
          首页
        </button>
        <button type="button" disabled={!next} onClick={() => setAfter(next)}>
          下一页
        </button>
      </div>
    </>
  );
}

function TaskDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const [detail, setDetail] = useState<Row | null>(null);
  useEffect(() => void api<Row>(`/admin/v1/tasks/${id}`).then(setDetail), [id]);
  return (
    <aside className="drawer">
      <div className="drawer-head">
        <div>
          <span className="label">TASK</span>
          <h2>{id}</h2>
        </div>
        <button className="icon-button" type="button" onClick={onClose} aria-label="关闭">
          ×
        </button>
      </div>
      {!detail ? (
        <Empty label="正在读取时间线" />
      ) : (
        <>
          <dl className="facts">
            <div>
              <dt>状态</dt>
              <dd>
                <Status value={detail.status} />
              </dd>
            </div>
            <div>
              <dt>Release</dt>
              <dd className="mono">{text(detail.model_release_id)}</dd>
            </div>
            <div>
              <dt>版本</dt>
              <dd>{text(detail.version)}</dd>
            </div>
            <div>
              <dt>请求哈希</dt>
              <dd className="mono hash">{text(detail.request_hash)}</dd>
            </div>
          </dl>
          <h3>状态时间线</h3>
          <ol className="timeline">
            {(detail.timeline as Row[]).map((event) => (
              <li key={text(event.id)}>
                <Status value={event.to_status} />
                <span>{time(event.created_at)}</span>
                <small>{text(event.reason, "无附加原因")}</small>
              </li>
            ))}
          </ol>
          <h3>执行尝试</h3>
          {(detail.attempts as Row[]).length === 0 ? (
            <Empty label="尚未创建 Attempt" />
          ) : (
            <pre>{JSON.stringify(detail.attempts, null, 2)}</pre>
          )}
        </>
      )}
    </aside>
  );
}

function ResourceTable({ title, path, columns }: { title: string; path: string; columns: string[] }) {
  const [rows, setRows] = useState<Row[]>([]);
  useEffect(() => void api<ListResponse>(`${path}?limit=100`).then((value) => setRows(value.data)), [path]);
  return (
    <section className="band">
      <div className="section-title">
        <h2>{title}</h2>
        <span>{rows.length}</span>
      </div>
      {rows.length === 0 ? (
        <Empty label="暂无记录" />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                {columns.map((column) => (
                  <th key={column}>{column.replaceAll("_", " ")}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={text(row.id)}>
                  {columns.map((column) => (
                    <td key={column}>
                      {column.includes("status") || column.includes("state") ? (
                        <Status value={row[column]} />
                      ) : column.endsWith("_at") ? (
                        time(row[column])
                      ) : (
                        text(row[column])
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Overview() {
  const [counts, setCounts] = useState({ queued: 0, replicas: 0, workers: 0, releases: 0 });
  useEffect(() => {
    void Promise.all([
      api<ListResponse>("/admin/v1/tasks?limit=200"),
      api<ListResponse>("/admin/v1/replicas?limit=200"),
      api<ListResponse>("/admin/v1/workers?limit=200"),
      api<ListResponse>("/admin/v1/releases?limit=200"),
    ]).then(([tasks, replicas, workers, releases]) =>
      setCounts({
        queued: tasks.data.filter((row) => row.status === "queued").length,
        replicas: replicas.data.filter((row) => row.observed_state === "ready").length,
        workers: workers.data.filter((row) => row.status === "ready" || row.status === "busy").length,
        releases: releases.data.filter((row) => row.accept_new_tasks === true).length,
      }),
    );
  }, []);
  return (
    <>
      <section className="metrics">
        <div>
          <span>排队任务</span>
          <strong>{counts.queued}</strong>
        </div>
        <div>
          <span>Ready Replica</span>
          <strong>{counts.replicas}</strong>
        </div>
        <div>
          <span>在线 Worker</span>
          <strong>{counts.workers}</strong>
        </div>
        <div>
          <span>接流量 Release</span>
          <strong>{counts.releases}</strong>
        </div>
      </section>
      <ResourceTable
        title="最近任务"
        path="/admin/v1/tasks"
        columns={["id", "model", "status", "priority", "created_at"]}
      />
    </>
  );
}

const workflowHash = "0".repeat(64);
const weightHash = "0".repeat(64);
const releaseManifest = JSON.stringify(
  {
    worker_contract_version: "v1",
    modalities: ["video"],
    operations: ["generation"],
    capabilities: { durations: [4, 6, 10, 15] },
    parameter_schema: { type: "object", additionalProperties: false },
    output_contract: { media_types: ["video/mp4"], preserve_original_bytes: true },
    resource_requirements: { gpu_skus: ["rtx5090"], gpu_memory_bytes: 34359738368, concurrency: 1 },
    components: [],
    weights: [{ logical_name: "model", sha256: weightHash, size_bytes: 1 }],
  },
  null,
  2,
);

function ManagementWorkbench() {
  const [result, setResult] = useState<Row | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (operation: () => Promise<Row>) => {
    setBusy(true);
    setError(null);
    try {
      setResult(await operation());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "operation_failed");
    } finally {
      setBusy(false);
    }
  };
  const submitModel = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    void run(() =>
      mutate<Row>(
        "/admin/v1/models",
        "POST",
        {
          alias: values.get("alias"),
          modality: values.get("modality"),
          description: values.get("description"),
          reason: values.get("reason"),
        },
        crypto.randomUUID(),
      ),
    );
  };
  const submitRelease = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    void run(() =>
      mutate<Row>(
        "/admin/v1/releases",
        "POST",
        {
          model_id: values.get("model_id"),
          source_image: values.get("source_image"),
          workflow_hash: values.get("workflow_hash"),
          maturity: values.get("maturity"),
          manifest: JSON.parse(String(values.get("manifest"))),
          reason: values.get("reason"),
        },
        crypto.randomUUID(),
      ),
    );
  };
  const submitPool = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    void run(() =>
      mutate<Row>(
        "/admin/v1/pools",
        "POST",
        {
          release_id: values.get("release_id"),
          provider: values.get("provider"),
          region_id: values.get("region_id"),
          gpu_sku: values.get("gpu_sku"),
          execution_mode: values.get("execution_mode"),
          reason: values.get("reason"),
        },
        crypto.randomUUID(),
      ),
    );
  };
  const submitPolicy = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    void run(() =>
      mutate<Row>(
        "/admin/v1/policies/validate",
        "POST",
        {
          policy_type: values.get("policy_type"),
          pool_id: values.get("pool_id"),
          configuration: JSON.parse(String(values.get("configuration"))),
          reason: values.get("reason"),
        },
        crypto.randomUUID(),
      ),
    );
  };
  const submitVersionChange = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const resource = String(values.get("resource"));
    const resourceId = String(values.get("resource_id"));
    const version = Number(values.get("expected_version"));
    const reason = values.get("reason");
    const body =
      resource === "models"
        ? {
            expected_version: version,
            status: values.get("status"),
            description: values.get("description"),
            reason,
          }
        : { expected_version: version, status: values.get("status"), reason };
    void run(() => mutate<Row>(`/admin/v1/${resource}/${resourceId}`, "PATCH", body, crypto.randomUUID(), version));
  };
  const submitApproval = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const version = Number(values.get("expected_version"));
    void run(() =>
      mutate<Row>(
        `/admin/v1/releases/${String(values.get("release_id"))}/approval`,
        "POST",
        { expected_version: version, decision: values.get("decision"), reason: values.get("reason") },
        crypto.randomUUID(),
        version,
      ),
    );
  };
  const submitAlias = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const version = Number(values.get("expected_version"));
    void run(() =>
      mutate<Row>(
        `/admin/v1/aliases/${String(values.get("alias"))}/switch`,
        "POST",
        {
          model_id: values.get("model_id"),
          release_id: values.get("release_id"),
          expected_version: version,
          reason: values.get("reason"),
        },
        crypto.randomUUID(),
        version,
      ),
    );
  };
  const submitRollback = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const version = Number(values.get("expected_current_version"));
    void run(() =>
      mutate<Row>(
        `/admin/v1/pools/${String(values.get("pool_id"))}/policies/${String(values.get("policy_type"))}/rollback`,
        "POST",
        {
          expected_current_version: version,
          target_policy_id: values.get("target_policy_id"),
          reason: values.get("reason"),
        },
        crypto.randomUUID(),
        version,
      ),
    );
  };
  const preview = () => {
    if (result?.object !== "policy.version") return;
    void run(() =>
      mutate<Row>(
        `/admin/v1/policies/${text(result.id)}/impact-previews`,
        "POST",
        {
          expected_policy_version: Number(result.version),
          horizon_seconds: 3600,
          reason: "Preview validated policy impact",
        },
        crypto.randomUUID(),
        Number(result.version),
      ),
    );
  };
  const publish = () => {
    if (result?.object !== "policy.impact_preview") return;
    void run(() =>
      mutate<Row>(
        `/admin/v1/policies/${text(result.policy_version_id)}/publish`,
        "POST",
        {
          expected_policy_version: Number(result.policy_version),
          preview_id: result.id,
          reason: "Publish reviewed policy version",
        },
        crypto.randomUUID(),
        Number(result.policy_version),
      ),
    );
  };
  return (
    <section className="band">
      <div className="section-title">
        <h2>控制面配置</h2>
      </div>
      <div className="form-grid">
        <form onSubmit={submitModel}>
          <h3>Model</h3>
          <label>
            Alias
            <input required name="alias" />
          </label>
          <label>
            模态
            <select name="modality">
              <option value="video">video</option>
              <option value="image">image</option>
            </select>
          </label>
          <label>
            描述
            <input name="description" />
          </label>
          <label>
            变更原因
            <input required minLength={8} name="reason" />
          </label>
          <button className="primary" disabled={busy} type="submit">
            创建
          </button>
        </form>
        <form onSubmit={submitRelease}>
          <h3>Release</h3>
          <label>
            Model ID
            <input required name="model_id" />
          </label>
          <label>
            镜像地址
            <input required name="source_image" placeholder="registry/team/model:tag" />
          </label>
          <label>
            工作流 SHA-256
            <input required name="workflow_hash" defaultValue={workflowHash} />
          </label>
          <label>
            成熟度
            <select name="maturity">
              <option value="candidate">candidate</option>
              <option value="stable">stable</option>
            </select>
          </label>
          <label className="wide">
            Manifest
            <textarea required name="manifest" defaultValue={releaseManifest} />
          </label>
          <label>
            变更原因
            <input required minLength={8} name="reason" />
          </label>
          <button className="primary" disabled={busy} type="submit">
            解析并创建
          </button>
        </form>
        <form onSubmit={submitPool}>
          <h3>Pool</h3>
          <label>
            Release ID
            <input required name="release_id" />
          </label>
          <label>
            Provider
            <input required name="provider" defaultValue="reference" />
          </label>
          <label>
            区域
            <input required name="region_id" defaultValue="region_local" />
          </label>
          <label>
            GPU SKU
            <input required name="gpu_sku" defaultValue="rtx5090" />
          </label>
          <label>
            模式
            <select name="execution_mode">
              <option value="deployment">deployment</option>
              <option value="batch">batch</option>
            </select>
          </label>
          <label>
            变更原因
            <input required minLength={8} name="reason" />
          </label>
          <button className="primary" disabled={busy} type="submit">
            创建
          </button>
        </form>
        <form onSubmit={submitPolicy}>
          <h3>Policy</h3>
          <label>
            Pool ID
            <input required name="pool_id" />
          </label>
          <label>
            类型
            <select name="policy_type">
              <option value="capacity">capacity</option>
              <option value="budget">budget</option>
              <option value="region">region</option>
              <option value="retry">retry</option>
            </select>
          </label>
          <label className="wide">
            配置
            <textarea
              required
              name="configuration"
              defaultValue={JSON.stringify(
                {
                  min_replicas: 0,
                  max_replicas: 10,
                  queue_target_seconds: 60,
                  target_utilization_percent: 75,
                  scale_up_step: 2,
                  scale_down_step_percent: 10,
                  idle_window_seconds: 900,
                  scale_down_cooldown_seconds: 1200,
                  hysteresis_percent: 10,
                },
                null,
                2,
              )}
            />
          </label>
          <label>
            变更原因
            <input required minLength={8} name="reason" />
          </label>
          <button className="primary" disabled={busy} type="submit">
            校验
          </button>
        </form>
        <form onSubmit={submitVersionChange}>
          <h3>资源状态</h3>
          <label>
            资源
            <select name="resource">
              <option value="models">Model</option>
              <option value="pools">Pool</option>
            </select>
          </label>
          <label>
            资源 ID
            <input required name="resource_id" />
          </label>
          <label>
            当前版本
            <input required name="expected_version" type="number" min="1" defaultValue="1" />
          </label>
          <label>
            状态
            <select name="status">
              <option value="active">active</option>
              <option value="disabled">disabled</option>
            </select>
          </label>
          <label>
            描述
            <input name="description" />
          </label>
          <label>
            变更原因
            <input required minLength={8} name="reason" />
          </label>
          <button className="primary" disabled={busy} type="submit">
            更新
          </button>
        </form>
        <form onSubmit={submitApproval}>
          <h3>Release 审批</h3>
          <label>
            Release ID
            <input required name="release_id" />
          </label>
          <label>
            当前版本
            <input required name="expected_version" type="number" min="1" defaultValue="1" />
          </label>
          <label>
            决定
            <select name="decision">
              <option value="approve">approve</option>
              <option value="reject">reject</option>
            </select>
          </label>
          <label>
            审批原因
            <input required minLength={8} name="reason" />
          </label>
          <button className="primary" disabled={busy} type="submit">
            提交审批
          </button>
        </form>
        <form onSubmit={submitAlias}>
          <h3>Alias</h3>
          <label>
            Alias
            <input required name="alias" />
          </label>
          <label>
            Model ID
            <input required name="model_id" />
          </label>
          <label>
            Release ID
            <input required name="release_id" />
          </label>
          <label>
            当前版本
            <input required name="expected_version" type="number" min="0" defaultValue="0" />
          </label>
          <label>
            切换原因
            <input required minLength={8} name="reason" />
          </label>
          <button className="primary" disabled={busy} type="submit">
            切换
          </button>
        </form>
        <form onSubmit={submitRollback}>
          <h3>Policy 回滚</h3>
          <label>
            Pool ID
            <input required name="pool_id" />
          </label>
          <label>
            类型
            <select name="policy_type">
              <option value="capacity">capacity</option>
              <option value="budget">budget</option>
              <option value="region">region</option>
              <option value="retry">retry</option>
            </select>
          </label>
          <label>
            当前版本
            <input required name="expected_current_version" type="number" min="1" />
          </label>
          <label>
            目标 Policy ID
            <input required name="target_policy_id" />
          </label>
          <label>
            回滚原因
            <input required minLength={8} name="reason" />
          </label>
          <button className="primary" disabled={busy} type="submit">
            回滚
          </button>
        </form>
      </div>
      {(result || error) && (
        <div className={`operation-result ${error ? "operation-error" : ""}`}>
          <div className="section-title">
            <h2>{error ? "操作失败" : "操作结果"}</h2>
          </div>
          {error ? <code>{error}</code> : <pre>{JSON.stringify(result, null, 2)}</pre>}
          {result?.object === "policy.version" && (
            <button type="button" className="secondary" onClick={preview}>
              影响预览
            </button>
          )}
          {result?.object === "policy.impact_preview" && (
            <button type="button" className="primary" onClick={publish}>
              发布策略
            </button>
          )}
        </div>
      )}
    </section>
  );
}

const rolloutStrategy = {
  max_surge: 1,
  max_unavailable: 0,
  batch_size: 1,
  readiness_timeout_seconds: 1800,
  readiness_stability_seconds: 60,
  progress_deadline_seconds: 7200,
  pause_on_failure: true,
  maximum_failure_rate_basis_points: 500,
  maximum_duration_regression_basis_points: 2500,
  maximum_extra_cost_minor: 600,
  currency: "CNY",
  rollback_retention_seconds: 604800,
};

function RolloutWorkbench() {
  const [preview, setPreview] = useState<Row | null>(null);
  const [detail, setDetail] = useState<Row | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const execute = async (operation: () => Promise<Row>, destination: (value: Row) => void) => {
    setBusy(true);
    setError(null);
    try {
      destination(await operation());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "rollout_operation_failed");
    } finally {
      setBusy(false);
    }
  };
  const previewRollout = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const version = Number(values.get("expected_pool_version"));
    void execute(
      () =>
        mutate<Row>(
          "/admin/v1/rollouts/preview",
          "POST",
          {
            release_id: values.get("release_id"),
            pool_id: values.get("pool_id"),
            expected_pool_version: version,
            strategy: JSON.parse(String(values.get("strategy"))),
            reason: values.get("reason"),
          },
          crypto.randomUUID(),
          version,
        ),
      setPreview,
    );
  };
  const startRollout = () => {
    if (!preview) return;
    const version = Number(preview.pool_version);
    void execute(
      () =>
        mutate<Row>(
          "/admin/v1/rollouts",
          "POST",
          {
            release_id: preview.target_release_id,
            pool_id: preview.pool_id,
            preview_id: preview.id,
            expected_pool_version: version,
            reason: "Start reviewed image rollout",
          },
          crypto.randomUUID(),
          version,
        ),
      (value) => {
        setPreview(null);
        setDetail(value);
      },
    );
  };
  const controlRollout = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const rolloutId = String(values.get("rollout_id"));
    const action = String(values.get("action"));
    const version = Number(values.get("expected_version"));
    void execute(
      () =>
        mutate<Row>(
          `/admin/v1/rollouts/${encodeURIComponent(rolloutId)}/${action}`,
          "POST",
          { expected_version: version, reason: values.get("reason") },
          crypto.randomUUID(),
          version,
        ),
      setDetail,
    );
  };
  const inspectRollout = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const rolloutId = String(new FormData(event.currentTarget).get("rollout_id"));
    void execute(() => api<Row>(`/admin/v1/rollouts/${encodeURIComponent(rolloutId)}`), setDetail);
  };
  return (
    <section className="band">
      <div className="section-title">
        <h2>镜像滚动发布</h2>
        <Status value={busy ? "running" : "ready"} />
      </div>
      <div className="form-grid">
        <form onSubmit={previewRollout}>
          <h3>发布预览</h3>
          <label>
            Pool ID
            <input required name="pool_id" />
          </label>
          <label>
            目标 Release ID
            <input required name="release_id" />
          </label>
          <label>
            Pool 当前版本
            <input required name="expected_pool_version" type="number" min="1" />
          </label>
          <label className="wide">
            滚动策略
            <textarea required name="strategy" defaultValue={JSON.stringify(rolloutStrategy, null, 2)} />
          </label>
          <label>
            变更原因
            <input required minLength={8} name="reason" />
          </label>
          <button className="primary" disabled={busy} type="submit">
            影响预览
          </button>
        </form>
        <form onSubmit={controlRollout}>
          <h3>发布控制</h3>
          <label>
            Rollout ID
            <input required name="rollout_id" />
          </label>
          <label>
            当前版本
            <input required name="expected_version" type="number" min="1" />
          </label>
          <label>
            操作
            <select name="action">
              <option value="pause">暂停</option>
              <option value="resume">恢复</option>
              <option value="rollback">回滚</option>
            </select>
          </label>
          <label>
            操作原因
            <input required minLength={8} name="reason" />
          </label>
          <button className="primary" disabled={busy} type="submit">
            执行
          </button>
        </form>
        <form onSubmit={inspectRollout}>
          <h3>逐机状态</h3>
          <label>
            Rollout ID
            <input required name="rollout_id" />
          </label>
          <button className="secondary" disabled={busy} type="submit">
            查询详情
          </button>
        </form>
      </div>
      {preview && (
        <div className="operation-result">
          <div className="section-title">
            <h2>影响与成本</h2>
            <button className="primary" disabled={busy} type="button" onClick={startRollout}>
              确认开始
            </button>
          </div>
          <pre>{JSON.stringify(preview, null, 2)}</pre>
        </div>
      )}
      {detail && (
        <div className="operation-result">
          <div className="section-title">
            <h2>发布进度</h2>
            <Status value={detail.status} />
          </div>
          <pre>{JSON.stringify(detail, null, 2)}</pre>
        </div>
      )}
      {error && (
        <div className="operation-result operation-error">
          <code>{error}</code>
        </div>
      )}
    </section>
  );
}

function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [authError, setAuthError] = useState(false);
  const [view, setView] = useState<View>("overview");
  const [taskId, setTaskId] = useState<string | null>(null);
  useEffect(
    () =>
      void api<Session>("/admin/v1/sessions/current")
        .then(setSession)
        .catch(() => setAuthError(true)),
    [],
  );
  const title = useMemo(
    () =>
      ({ overview: "运行概览", tasks: "任务排障", capacity: "容量与算力", releases: "模型发布", audit: "安全审计" })[
        view
      ],
    [view],
  );
  const localSignIn = async () => {
    const tokenResponse = await fetch("/identity/v1/id-tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    if (!tokenResponse.ok) throw new Error("local_identity_unavailable");
    const token = (await tokenResponse.json()) as { id_token: string };
    const exchange = await fetch("/admin/v1/sessions/exchange", {
      method: "POST",
      credentials: "include",
      headers: { authorization: `Bearer ${token.id_token}`, "content-type": "application/json" },
      body: JSON.stringify({ organization_id: "org_local", project_id: "project_local" }),
    });
    if (!exchange.ok) throw new Error("local_session_exchange_failed");
    setSession(await api<Session>("/admin/v1/sessions/current"));
    setAuthError(false);
  };
  if (authError)
    return (
      <main className="auth-state">
        <div className="brand">ASTRA</div>
        <h1>需要企业身份验证</h1>
        <a className="primary" href="/oidc/login">
          登录控制台
        </a>
        {import.meta.env.DEV && (
          <button className="secondary" type="button" onClick={() => void localSignIn()}>
            本地身份
          </button>
        )}
      </main>
    );
  if (!session)
    return (
      <main className="auth-state">
        <div className="spinner" role="status" aria-label="加载中" />
      </main>
    );
  const labels: Record<View, string> = {
    overview: "概览",
    tasks: "任务",
    capacity: "容量",
    releases: "发布",
    audit: "审计",
  };
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">ASTRA</div>
        <nav>
          {(Object.keys(labels) as View[]).map((item) => (
            <button type="button" key={item} className={view === item ? "active" : ""} onClick={() => setView(item)}>
              {labels[item]}
            </button>
          ))}
        </nav>
        <div className="identity">
          <strong>{session.display_name ?? session.email ?? "Operator"}</strong>
          <span>{session.project_id}</span>
        </div>
      </aside>
      <main className="workspace">
        <header className="topbar">
          <div>
            <span className="label">CONTROL PLANE</span>
            <h1>{title}</h1>
          </div>
          <Status value="healthy" />
        </header>
        {view === "overview" && <Overview />}
        {view === "tasks" && (
          <section className="band">
            <TaskTable onSelect={setTaskId} />
          </section>
        )}
        {view === "capacity" && (
          <>
            <ResourceTable
              title="模型池"
              path="/admin/v1/pools"
              columns={["id", "release_id", "provider", "region_id", "gpu_sku", "status"]}
            />
            <ResourceTable
              title="GPU 库存"
              path="/admin/v1/inventory"
              columns={["region_name", "gpu_sku", "available_replicas", "price_per_gpu_hour_minor", "observed_at"]}
            />
            <ResourceTable
              title="容量计划"
              path="/admin/v1/capacity-plans"
              columns={[
                "id",
                "pool_id",
                "status",
                "current_replicas",
                "desired_replicas",
                "queue_slo_replicas",
                "cost_minor",
                "net_benefit_minor",
                "suppression_reason",
                "created_at",
              ]}
            />
            <ResourceTable
              title="Worker"
              path="/admin/v1/workers"
              columns={["id", "replica_id", "release_id", "status", "last_heartbeat_at"]}
            />
          </>
        )}
        {view === "releases" && (
          <>
            {session.permissions.includes("releases:write") && <ManagementWorkbench />}
            {session.permissions.includes("rollouts:write") && <RolloutWorkbench />}
            <ResourceTable
              title="Release"
              path="/admin/v1/releases"
              columns={["id", "alias", "maturity", "image_digest", "accept_new_tasks", "created_at"]}
            />
            <ResourceTable
              title="Rollout"
              path="/admin/v1/rollouts"
              columns={["id", "pool_id", "target_release_id", "status", "updated_at"]}
            />
          </>
        )}
        {view === "audit" && (
          <ResourceTable
            title="不可变审计"
            path="/admin/v1/audit-events"
            columns={["created_at", "actor_id", "action", "resource_id", "outcome", "reason_code"]}
          />
        )}
      </main>
      {taskId && <TaskDetail id={taskId} onClose={() => setTaskId(null)} />}
    </div>
  );
}
const root = document.getElementById("root");
if (!root) throw new Error("admin_web_root_missing");
const reactRoot: Root = import.meta.hot?.data.reactRoot ?? createRoot(root);
if (import.meta.hot) import.meta.hot.data.reactRoot = reactRoot;
reactRoot.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
