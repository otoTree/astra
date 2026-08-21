import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
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
              title="Worker"
              path="/admin/v1/workers"
              columns={["id", "replica_id", "release_id", "status", "last_heartbeat_at"]}
            />
          </>
        )}
        {view === "releases" && (
          <>
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
createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
