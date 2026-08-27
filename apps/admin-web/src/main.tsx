import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { adminApiRequestUrl, api, mutate, saveCsrfToken } from "./admin-api.ts";
import { parseEnvironmentText, rolloutStrategyFromForm } from "./release-form.ts";
import "./styles.css";

type Row = Record<string, unknown>;
type ListResponse = { data: Row[]; has_more: boolean; next_after: string | null };
type Session = { display_name: string | null; email: string | null; project_id: string; permissions: string[] };
type View = "overview" | "tasks" | "models" | "capacity" | "releases" | "access" | "audit";

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

function ModelCatalog({ canCreate }: { canCreate: boolean }) {
  const [models, setModels] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    void api<ListResponse>("/admin/v1/models?limit=200")
      .then((value) => setModels(value.data))
      .catch((cause) => setError(cause instanceof Error ? cause.message : "model_load_failed"));
  }, []);
  useEffect(load, [load]);
  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    setBusy(true);
    setError(null);
    void mutate<Row>(
      "/admin/v1/models",
      "POST",
      {
        alias: values.get("alias"),
        modality: values.get("modality"),
        description: values.get("description") ?? "",
        reason: values.get("reason"),
      },
      crypto.randomUUID(),
    )
      .then(() => {
        form.reset();
        load();
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : "model_create_failed"))
      .finally(() => setBusy(false));
  };
  return (
    <>
      {canCreate && (
        <section className="band model-create-band">
          <div className="section-title">
            <h2>创建模型</h2>
            <span>基础标识</span>
          </div>
          <form className="model-create-form" onSubmit={submit}>
            <label>
              模型名称
              <input required name="alias" pattern="[a-z0-9][a-z0-9_.-]*" placeholder="例如：h3-video" />
            </label>
            <label>
              类型
              <select name="modality" defaultValue="video">
                <option value="video">视频</option>
                <option value="image">图片</option>
              </select>
            </label>
            <label className="wide">
              描述（可选）
              <input name="description" placeholder="例如：内部视频生成模型" />
            </label>
            <label className="wide">
              创建原因
              <input required minLength={8} name="reason" placeholder="说明模型用途" />
            </label>
            <button className="primary" disabled={busy} type="submit">
              {busy ? "创建中" : "创建模型"}
            </button>
          </form>
          {error && <div className="operation-result operation-error">{error}</div>}
        </section>
      )}
      <section className="band">
        <div className="section-title">
          <h2>已有模型</h2>
          <span>{models.length}</span>
        </div>
        {models.length === 0 ? (
          <Empty label="尚未创建模型" />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>名称</th>
                  <th>类型</th>
                  <th>描述</th>
                  <th>状态</th>
                  <th>创建时间</th>
                </tr>
              </thead>
              <tbody>
                {models.map((model) => (
                  <tr key={text(model.id)}>
                    <td className="mono">{text(model.alias)}</td>
                    <td>{text(model.modality)}</td>
                    <td>{text(model.description, "-")}</td>
                    <td>
                      <Status value={model.status} />
                    </td>
                    <td>{time(model.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

function ProviderCredentialPanel() {
  const [credential, setCredential] = useState<Row | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    void api<Row>("/admin/v1/provider-credentials/gongji")
      .then(setCredential)
      .catch((cause) => setError(cause instanceof Error ? cause.message : "credential_load_failed"));
  }, []);
  useEffect(load, [load]);
  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    setBusy(true);
    setError(null);
    void mutate<Row>(
      "/admin/v1/provider-credentials/gongji",
      "POST",
      { token: values.get("token"), reason: values.get("reason") },
      crypto.randomUUID(),
    )
      .then((value) => {
        setCredential(value);
        form.reset();
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : "credential_update_failed"))
      .finally(() => setBusy(false));
  };
  const revoke = () => {
    const version = Number(credential?.version);
    if (!version || !window.confirm("确认吊销当前共绩云 Token？吊销后共绩算力将不可用。")) return;
    setBusy(true);
    setError(null);
    void mutate<Row>(
      "/admin/v1/provider-credentials/gongji/revoke",
      "POST",
      { expected_version: version, reason: "Revoke Gongji credential from admin console" },
      crypto.randomUUID(),
      version,
    )
      .then(setCredential)
      .catch((cause) => setError(cause instanceof Error ? cause.message : "credential_revoke_failed"))
      .finally(() => setBusy(false));
  };
  const configured = credential?.configured === true;
  const fingerprint = text(credential?.token_fingerprint, "");
  return (
    <section className="band credential-band">
      <div className="section-title">
        <h2>共绩云 Token</h2>
        <Status value={configured ? "ready" : "unavailable"} />
      </div>
      <div className="credential-layout">
        <dl className="facts compact-facts">
          <div>
            <dt>状态</dt>
            <dd>{configured ? "已配置" : "未配置"}</dd>
          </div>
          <div>
            <dt>版本</dt>
            <dd>{text(credential?.version)}</dd>
          </div>
          <div>
            <dt>指纹</dt>
            <dd className="mono">{fingerprint ? `…${fingerprint.slice(-12)}` : "-"}</dd>
          </div>
          <div>
            <dt>更新时间</dt>
            <dd>{time(credential?.updated_at)}</dd>
          </div>
        </dl>
        <form className="inline-form" onSubmit={submit}>
          <label className="wide">
            {configured ? "新 Token" : "Token"}
            <input required name="token" type="password" autoComplete="off" />
          </label>
          <label className="wide">
            变更原因
            <input required minLength={8} name="reason" />
          </label>
          <div className="form-actions wide">
            <button className="primary" disabled={busy} type="submit">
              {configured ? "轮换 Token" : "保存 Token"}
            </button>
            {configured && (
              <button className="danger" disabled={busy} type="button" onClick={revoke}>
                吊销
              </button>
            )}
          </div>
        </form>
      </div>
      {error && <div className="operation-result operation-error">{error}</div>}
    </section>
  );
}

function ProviderSyncPanel({ onSynced }: { onSynced: () => void }) {
  const [latest, setLatest] = useState<Row | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    void api<ListResponse>("/admin/v1/provider-syncs?limit=20")
      .then((value) => setLatest(value.data.find((row) => row.provider === "gongji") ?? null))
      .catch((cause) => setError(cause instanceof Error ? cause.message : "provider_sync_load_failed"));
  }, []);
  useEffect(load, [load]);
  const sync = () => {
    setBusy(true);
    setError(null);
    void mutate<Row>(
      "/admin/v1/provider-syncs/gongji",
      "POST",
      { reason: "Refresh Gongji GPU inventory from admin console" },
      crypto.randomUUID(),
    )
      .then((value) => {
        setLatest(value);
        const started = Date.now();
        const poll = () => {
          void api<ListResponse>("/admin/v1/provider-syncs?limit=20")
            .then((result) => {
              const current = result.data.find((row) => row.id === value.id) ?? value;
              setLatest(current);
              if (current.status === "succeeded") {
                onSynced();
                setBusy(false);
              } else if (current.status === "failed" || Date.now() - started > 30_000) {
                setBusy(false);
              } else {
                window.setTimeout(poll, 800);
              }
            })
            .catch(() => setBusy(false));
        };
        poll();
      })
      .catch((cause) => {
        setError(cause instanceof Error ? cause.message : "provider_sync_request_failed");
        setBusy(false);
      });
  };
  return (
    <section className="band provider-sync-band">
      <div className="section-title">
        <h2>共绩 GPU 供给</h2>
        <Status value={busy ? "running" : (latest?.status ?? "ready")} />
      </div>
      <p className="section-note">
        这里的数据来自共绩资源接口，不需要手工录入设备。点击同步会实时获取 GPU
        型号、区域、可用数量和价格；平台只保存标准化库存快照。创建和回收真实算力时，Provider Controller 需要启用 Gongji
        Driver。
      </p>
      <div className="sync-actions">
        <button className="primary" disabled={busy} type="button" onClick={sync}>
          {busy ? "同步中…" : "立即同步 GPU 设备"}
        </button>
        <span className="sync-meta">
          {latest?.status === "succeeded"
            ? `最近成功：${time(latest.completed_at ?? latest.updated_at)}`
            : latest?.status === "failed"
              ? `同步失败：${text(latest.error_code, "未知错误")}`
              : latest?.status === "pending" || latest?.status === "running"
                ? "同步请求已提交，等待 Provider Controller 执行"
                : "尚未执行手动同步"}
        </span>
      </div>
      {error && <div className="operation-result operation-error">{error}</div>}
    </section>
  );
}

function ModelPoolCreatePanel({ onCreated }: { onCreated: () => void }) {
  const [releases, setReleases] = useState<Row[]>([]);
  const [inventory, setInventory] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void Promise.all([
      api<ListResponse>("/admin/v1/releases?limit=200"),
      api<ListResponse>("/admin/v1/inventory?limit=200"),
    ])
      .then(([releaseList, inventoryList]) => {
        setReleases(releaseList.data.filter((row) => row.status === "approved"));
        setInventory(inventoryList.data.filter((row) => ["healthy", "degraded"].includes(String(row.region_status))));
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : "pool_resources_load_failed"));
  }, []);
  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    const selected = inventory.find(
      (row) => `${row.provider}|${row.region_id}|${row.gpu_sku}` === values.get("inventory"),
    );
    const release = releases.find((row) => row.id === values.get("release_id"));
    if (!selected || !release) {
      setError("请选择已批准 Release 和有效的 GPU 供给");
      return;
    }
    setBusy(true);
    setError(null);
    void mutate<Row>(
      "/admin/v1/pools",
      "POST",
      {
        release_id: release.id,
        provider: selected.provider,
        region_id: selected.region_id,
        gpu_sku: selected.gpu_sku,
        execution_mode: values.get("execution_mode"),
        reason: values.get("reason"),
      },
      crypto.randomUUID(),
    )
      .then(() => {
        form.reset();
        onCreated();
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : "pool_create_failed"))
      .finally(() => setBusy(false));
  };
  return (
    <section className="band pool-create-band">
      <div className="section-title">
        <h2>创建模型池</h2>
        <span>调度配置</span>
      </div>
      <p className="section-note">
        模型池是“一个模型 Release + 一种 GPU
        供给”的调度单元。创建后默认为停用状态，还需要补齐容量、预算、区域和重试策略才能启用。
      </p>
      <form className="pool-create-form" onSubmit={submit}>
        <label>
          已批准 Release
          <select required name="release_id" defaultValue="">
            <option value="" disabled>
              选择模型 Release
            </option>
            {releases.map((release) => (
              <option key={text(release.id)} value={text(release.id)}>
                {text(release.alias, text(release.id))} · {text(release.image_digest)}
              </option>
            ))}
          </select>
        </label>
        <label>
          GPU 供给
          <select required name="inventory" defaultValue="">
            <option value="" disabled>
              选择同步到的 GPU 设备
            </option>
            {inventory.map((row) => {
              const value = `${row.provider}|${row.region_id}|${row.gpu_sku}`;
              return (
                <option key={value} value={value}>
                  {text(row.provider)} · {text(row.region_name, text(row.region_id))} · {text(row.gpu_sku)} · 可用{" "}
                  {text(row.available_replicas)}
                </option>
              );
            })}
          </select>
        </label>
        <label>
          执行模式
          <select name="execution_mode" defaultValue="deployment">
            <option value="deployment">在线服务</option>
            <option value="batch">批处理</option>
          </select>
        </label>
        <label>
          创建原因
          <input required minLength={8} name="reason" placeholder="例如：为 H3 配置 H20 在线池" />
        </label>
        <button className="primary" disabled={busy || releases.length === 0 || inventory.length === 0} type="submit">
          {busy ? "创建中…" : "创建模型池"}
        </button>
      </form>
      {releases.length === 0 && <p className="section-note">暂无已批准 Release；请先在“发布”页面解析并批准镜像。</p>}
      {inventory.length === 0 && (
        <p className="section-note">暂无可用 GPU 供给；请先配置 Token 并点击“立即同步 GPU 设备”。</p>
      )}
      {error && <div className="operation-result operation-error">{error}</div>}
    </section>
  );
}

const apiKeyScopes = [
  ["generations:create", "创建图片和视频任务"],
  ["tasks:read", "查询任务"],
  ["tasks:cancel", "取消任务"],
  ["files:write", "上传素材"],
  ["files:read", "读取素材"],
  ["models:read", "查询模型"],
  ["tasks:read_sensitive", "读取敏感请求"],
] as const;

function ApiKeyPanel() {
  const [keys, setKeys] = useState<Row[]>([]);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    void api<ListResponse>("/admin/v1/api-keys?limit=100")
      .then((value) => setKeys(value.data))
      .catch((cause) => setError(cause instanceof Error ? cause.message : "api_key_load_failed"));
  }, []);
  useEffect(load, [load]);
  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    const scopes = apiKeyScopes.flatMap(([scope]) => (values.get(`scope:${scope}`) === "on" ? [scope] : []));
    setBusy(true);
    setError(null);
    void mutate<Row>(
      "/admin/v1/api-keys",
      "POST",
      {
        name: values.get("name"),
        scopes,
        ...(values.get("expires_at")
          ? { expires_at: Math.floor(new Date(String(values.get("expires_at"))).getTime() / 1000) }
          : {}),
        reason: values.get("reason"),
      },
      crypto.randomUUID(),
    )
      .then((value) => {
        setNewKey(text(value.api_key, ""));
        form.reset();
        load();
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : "api_key_create_failed"))
      .finally(() => setBusy(false));
  };
  const revoke = (row: Row) => {
    if (!window.confirm(`确认吊销 API Key「${text(row.name)}」？外部调用会立即失效。`)) return;
    setBusy(true);
    setError(null);
    void mutate<Row>(
      `/admin/v1/api-keys/${encodeURIComponent(text(row.id))}/revoke`,
      "POST",
      { reason: "Revoke API Key from admin console" },
      crypto.randomUUID(),
    )
      .then(() => load())
      .catch((cause) => setError(cause instanceof Error ? cause.message : "api_key_revoke_failed"))
      .finally(() => setBusy(false));
  };
  return (
    <section className="band access-band">
      <div className="section-title">
        <h2>平台 API Key</h2>
        <span>Bearer Token</span>
      </div>
      <p className="section-note">外部系统通过 Authorization: Bearer API_KEY 访问 /v1。密钥只在创建成功后显示一次。</p>
      {newKey && (
        <div className="operation-result key-result">
          <strong>请立即复制新的 API Key</strong>
          <div className="key-copy-row">
            <code>{newKey}</code>
            <button className="secondary" type="button" onClick={() => void navigator.clipboard?.writeText(newKey)}>
              复制
            </button>
          </div>
          <button className="link-button" type="button" onClick={() => setNewKey(null)}>
            我已保存，关闭提示
          </button>
        </div>
      )}
      <div className="access-layout">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>名称</th>
                <th>Key</th>
                <th>权限</th>
                <th>状态</th>
                <th>最后使用</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {keys.map((row) => (
                <tr key={text(row.id)}>
                  <td>{text(row.name)}</td>
                  <td className="mono">
                    {text(row.key_prefix)}…{text(row.key_last_four)}
                  </td>
                  <td>{Array.isArray(row.scopes) ? row.scopes.map(String).join(", ") : "-"}</td>
                  <td>
                    <Status value={row.status} />
                  </td>
                  <td>{time(row.last_used_at)}</td>
                  <td>
                    {row.status === "active" && (
                      <button className="danger" disabled={busy} type="button" onClick={() => revoke(row)}>
                        吊销
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {keys.length === 0 && <Empty label="尚未创建 API Key" />}
        </div>
        <form className="access-form" onSubmit={submit}>
          <h3>创建调用密钥</h3>
          <label>
            名称
            <input required name="name" placeholder="例如：生产渲染服务" />
          </label>
          <label>
            过期时间（可选）
            <input name="expires_at" type="date" />
          </label>
          <fieldset>
            <legend>允许的操作</legend>
            {apiKeyScopes.map(([scope, label]) => (
              <label className="check-label" key={scope}>
                <input defaultChecked={scope !== "tasks:read_sensitive"} name={`scope:${scope}`} type="checkbox" />
                <span>{label}</span>
                <small className="mono">{scope}</small>
              </label>
            ))}
          </fieldset>
          <label>
            创建原因
            <input required minLength={8} name="reason" placeholder="说明调用方和用途" />
          </label>
          <button className="primary" disabled={busy} type="submit">
            {busy ? "处理中" : "创建 API Key"}
          </button>
        </form>
      </div>
      {error && <div className="operation-result operation-error">{error}</div>}
    </section>
  );
}

function ReleaseWorkbench() {
  const [models, setModels] = useState<Row[]>([]);
  const [releases, setReleases] = useState<Row[]>([]);
  const [pools, setPools] = useState<Row[]>([]);
  const [created, setCreated] = useState<Row | null>(null);
  const [selectedReleaseId, setSelectedReleaseId] = useState("");
  const [preview, setPreview] = useState<Row | null>(null);
  const [rollout, setRollout] = useState<Row | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    const [modelList, releaseList, poolList] = await Promise.all([
      api<ListResponse>("/admin/v1/models?limit=200"),
      api<ListResponse>("/admin/v1/releases?limit=200"),
      api<ListResponse>("/admin/v1/pools?limit=200"),
    ]);
    setModels(modelList.data.filter((row) => row.status === "active"));
    setReleases(releaseList.data);
    setPools(poolList.data.filter((row) => row.status === "active"));
  }, []);
  useEffect(() => void load().catch(() => setError("release_resources_load_failed")), [load]);
  const execute = async (operation: () => Promise<Row>, destination: (value: Row) => void) => {
    setBusy(true);
    setError(null);
    try {
      destination(await operation());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "release_operation_failed");
    } finally {
      setBusy(false);
    }
  };
  const createRelease = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    let environment: Record<string, string>;
    try {
      environment = parseEnvironmentText(String(values.get("environment")));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "environment_invalid");
      return;
    }
    void execute(
      () =>
        mutate<Row>(
          "/admin/v1/releases",
          "POST",
          {
            model_id: values.get("model_id"),
            source_image: values.get("source_image"),
            environment,
            reason: values.get("reason"),
          },
          crypto.randomUUID(),
        ),
      (value) => {
        setCreated(value);
        setPreview(null);
        setRollout(null);
        void load();
      },
    );
  };
  const approve = () => {
    if (!created) return;
    const version = Number(created.version);
    void execute(
      () =>
        mutate<Row>(
          `/admin/v1/releases/${encodeURIComponent(text(created.id))}/approval`,
          "POST",
          { expected_version: version, decision: "approve", reason: "Approve parsed model image release" },
          crypto.randomUUID(),
          version,
        ),
      (value) => {
        setCreated({ ...created, ...value });
        setSelectedReleaseId(text(created.id));
        void load();
      },
    );
  };
  const previewRollout = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const pool = pools.find((row) => row.id === values.get("pool_id"));
    if (!pool) {
      setError("请选择有效的 Model Pool");
      return;
    }
    const version = Number(pool.version);
    void execute(
      () =>
        mutate<Row>(
          "/admin/v1/rollouts/preview",
          "POST",
          {
            release_id: values.get("release_id"),
            pool_id: pool.id,
            expected_pool_version: version,
            strategy: rolloutStrategyFromForm(values),
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
            reason: "Start reviewed model image rollout",
          },
          crypto.randomUUID(),
          version,
        ),
      (value) => {
        setPreview(null);
        setRollout(value);
      },
    );
  };
  const approvedReleases = releases.filter((row) => row.status === "approved");
  const selectableReleases =
    created?.status === "approved" && !approvedReleases.some((release) => release.id === created.id)
      ? [created, ...approvedReleases]
      : approvedReleases;
  const previewImpact = preview?.impact as Row | undefined;
  const previewStrategy = preview?.strategy as Row | undefined;
  const selectedRelease = selectableReleases.find((release) => release.id === selectedReleaseId);
  const selectedModelId = selectedRelease?.model_id;
  const eligiblePools = selectedModelId
    ? pools.filter((pool) => {
        const sourceRelease = releases.find((release) => release.id === pool.release_id);
        return sourceRelease?.model_id === selectedModelId;
      })
    : pools;
  return (
    <section className="band release-workbench">
      <div className="section-title">
        <h2>发布模型镜像</h2>
        <Status value={busy ? "running" : "ready"} />
      </div>
      <ol className="release-steps" aria-label="发布步骤">
        <li className="current">1 镜像</li>
        <li className={created ? "current" : ""}>2 审批</li>
        <li className={preview || rollout ? "current" : ""}>3 发布</li>
      </ol>
      <form className="release-form" onSubmit={createRelease}>
        <label>
          模型
          <select required name="model_id" defaultValue="">
            <option value="" disabled>
              选择模型
            </option>
            {models.map((model) => (
              <option key={text(model.id)} value={text(model.id)}>
                {text(model.alias)} · {text(model.modality)}
              </option>
            ))}
          </select>
        </label>
        <label>
          镜像地址
          <input required name="source_image" placeholder="registry.example.com/team/model:v1.2.0" />
        </label>
        <label className="wide">
          环境变量（每行 KEY=VALUE）
          <textarea
            className="environment-editor"
            name="environment"
            spellCheck={false}
            placeholder={"H3_RUNTIME_WEIGHT_DOWNLOAD_ENABLED=false\nH3_WEIGHT_ROOT=/var/lib/astra/h3/weights"}
          />
        </label>
        <label className="wide">
          发布原因
          <input required minLength={8} name="reason" placeholder="例如：上线 H3 v1.2.0" />
        </label>
        <button className="primary" disabled={busy || models.length === 0} type="submit">
          解析镜像
        </button>
      </form>
      {created && (
        <div className="release-result">
          <div className="section-title">
            <h2>镜像解析结果</h2>
            <Status value={created.status} />
          </div>
          <dl className="facts result-facts">
            <div>
              <dt>Release</dt>
              <dd className="mono">{text(created.id)}</dd>
            </div>
            <div>
              <dt>固定 Digest</dt>
              <dd className="mono hash">{text(created.image_digest)}</dd>
            </div>
            <div>
              <dt>环境变量</dt>
              <dd>{Array.isArray(created.environment_names) ? created.environment_names.join(", ") || "无" : "无"}</dd>
            </div>
          </dl>
          {created.status === "draft" && (
            <button className="primary" disabled={busy} type="button" onClick={approve}>
              批准 Release
            </button>
          )}
        </div>
      )}
      <form className="release-form rollout-form" onSubmit={previewRollout}>
        <div className="subsection-title wide">
          <h3>滚动发布</h3>
        </div>
        <label>
          目标 Release
          <select
            required
            name="release_id"
            value={selectedReleaseId}
            onChange={(event) => setSelectedReleaseId(event.target.value)}
          >
            <option value="">选择已批准 Release</option>
            {selectableReleases.map((release) => (
              <option key={text(release.id)} value={text(release.id)}>
                {text(release.alias)} · {text(release.image_digest).slice(0, 20)}…
              </option>
            ))}
          </select>
        </label>
        <label>
          Model Pool
          <select key={selectedReleaseId || "pool-select"} required name="pool_id" defaultValue="">
            <option value="" disabled>
              选择目标 Pool
            </option>
            {eligiblePools.map((pool) => (
              <option key={text(pool.id)} value={text(pool.id)}>
                {text(pool.provider)} · {text(pool.region_id)} · {text(pool.gpu_sku)}
              </option>
            ))}
          </select>
        </label>
        <label>
          额外实例
          <input required name="max_surge" type="number" min="0" max="100" defaultValue="1" />
        </label>
        <label>
          最大不可用实例
          <input required name="max_unavailable" type="number" min="0" max="100" defaultValue="0" />
        </label>
        <label>
          额外成本上限（分）
          <input required name="maximum_extra_cost_minor" type="number" min="0" defaultValue="600" />
        </label>
        <label className="wide">
          发布原因
          <input required minLength={8} name="reason" />
        </label>
        <details className="advanced wide">
          <summary>高级设置</summary>
          <div className="advanced-grid">
            <label>
              单批实例
              <input required name="batch_size" type="number" min="1" max="100" defaultValue="1" />
            </label>
            <label>
              就绪超时（秒）
              <input required name="readiness_timeout_seconds" type="number" min="60" defaultValue="1800" />
            </label>
            <label>
              稳定窗口（秒）
              <input required name="readiness_stability_seconds" type="number" min="10" defaultValue="60" />
            </label>
            <label>
              总超时（秒）
              <input required name="progress_deadline_seconds" type="number" min="300" defaultValue="7200" />
            </label>
            <label>
              最大失败率（基点）
              <input required name="maximum_failure_rate_basis_points" type="number" min="0" defaultValue="500" />
            </label>
            <label>
              最大耗时回退（基点）
              <input
                required
                name="maximum_duration_regression_basis_points"
                type="number"
                min="0"
                defaultValue="2500"
              />
            </label>
            <label>
              币种
              <select name="currency" defaultValue="CNY">
                <option value="CNY">CNY</option>
              </select>
            </label>
            <label>
              回滚保留（秒）
              <input required name="rollback_retention_seconds" type="number" min="3600" defaultValue="604800" />
            </label>
            <label className="check-label">
              <input name="pause_on_failure" type="checkbox" defaultChecked />
              失败时暂停
            </label>
          </div>
        </details>
        <button
          className="primary"
          disabled={busy || selectableReleases.length === 0 || eligiblePools.length === 0}
          type="submit"
        >
          生成影响预览
        </button>
      </form>
      {preview && (
        <div className="release-result">
          <div className="section-title">
            <h2>影响预览</h2>
            <button className="primary" disabled={busy} type="button" onClick={startRollout}>
              确认发布
            </button>
          </div>
          <dl className="facts result-facts">
            <div>
              <dt>源 Digest</dt>
              <dd className="mono hash">{text(preview.source_image_digest)}</dd>
            </div>
            <div>
              <dt>目标 Digest</dt>
              <dd className="mono hash">{text(preview.target_image_digest)}</dd>
            </div>
            <div>
              <dt>替换实例</dt>
              <dd>{text(previewImpact?.replacement_steps)}</dd>
            </div>
            <div>
              <dt>额外成本</dt>
              <dd>
                {text(previewImpact?.estimated_extra_cost_minor)} {text(previewStrategy?.currency, "CNY")}
              </dd>
            </div>
          </dl>
        </div>
      )}
      {rollout && (
        <div className="release-result">
          <div className="section-title">
            <h2>发布已开始</h2>
            <Status value={rollout.status} />
          </div>
          <span className="mono">{text(rollout.id)}</span>
        </div>
      )}
      {error && <div className="operation-result operation-error">{error}</div>}
    </section>
  );
}

function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [authError, setAuthError] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [view, setView] = useState<View>("overview");
  const [taskId, setTaskId] = useState<string | null>(null);
  const [providerSyncVersion, setProviderSyncVersion] = useState(0);
  const [poolVersion, setPoolVersion] = useState(0);
  useEffect(
    () =>
      void api<Session>("/admin/v1/sessions/current")
        .then(setSession)
        .catch(() => setAuthError(true)),
    [],
  );
  const title = useMemo(
    () =>
      ({
        overview: "运行概览",
        tasks: "任务排障",
        models: "模型管理",
        capacity: "容量与算力",
        releases: "模型发布",
        access: "访问控制",
        audit: "安全审计",
      })[view],
    [view],
  );
  const localSignIn = async (event: React.FormEvent) => {
    event.preventDefault();
    setLoginBusy(true);
    setLoginError(null);
    const response = await fetch(adminApiRequestUrl("/admin/v1/sessions/login"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ username, password }),
    });
    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as { error?: { code?: string } };
      setLoginError(payload.error?.code ?? "登录失败");
      setLoginBusy(false);
      return;
    }
    const issued = (await response.json()) as Session & { csrf_token: string };
    saveCsrfToken(issued.csrf_token);
    setSession(issued);
    setAuthError(false);
    setLoginBusy(false);
  };
  if (authError)
    return (
      <main className="auth-state">
        <div className="brand">ASTRA</div>
        <h1>登录控制台</h1>
        <form onSubmit={(event) => void localSignIn(event)}>
          <label>
            用户名
            <input required value={username} onChange={(event) => setUsername(event.target.value)} />
          </label>
          <label>
            密码
            <input required type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
          </label>
          {loginError && <div className="operation-error">{loginError}</div>}
          <button className="primary" disabled={loginBusy} type="submit">
            {loginBusy ? "登录中" : "登录"}
          </button>
        </form>
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
    models: "模型",
    capacity: "容量",
    releases: "发布",
    access: "访问控制",
    audit: "审计",
  };
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">ASTRA</div>
        <nav>
          {(Object.keys(labels) as View[]).map((item) =>
            item === "access" && !session.permissions.includes("identity:admin") ? null : (
              <button type="button" key={item} className={view === item ? "active" : ""} onClick={() => setView(item)}>
                {labels[item]}
              </button>
            ),
          )}
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
        {view === "models" && <ModelCatalog canCreate={session.permissions.includes("releases:write")} />}
        {view === "capacity" && (
          <>
            {session.permissions.includes("provider_credentials:write") && <ProviderCredentialPanel />}
            {session.permissions.includes("provider_credentials:write") && (
              <ProviderSyncPanel onSynced={() => setProviderSyncVersion((value) => value + 1)} />
            )}
            {session.permissions.includes("policies:write") && (
              <ModelPoolCreatePanel
                key={`pool-create-${providerSyncVersion}`}
                onCreated={() => setPoolVersion((value) => value + 1)}
              />
            )}
            <ResourceTable
              title="模型池"
              path="/admin/v1/pools"
              key={`pools-${poolVersion}`}
              columns={["id", "release_id", "provider", "region_id", "gpu_sku", "status"]}
            />
            <ResourceTable
              title="GPU 库存"
              path="/admin/v1/inventory"
              key={`inventory-${providerSyncVersion}`}
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
            {session.permissions.includes("releases:write") && session.permissions.includes("rollouts:write") && (
              <ReleaseWorkbench />
            )}
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
        {view === "access" &&
          (session.permissions.includes("identity:admin") ? <ApiKeyPanel /> : <Empty label="没有访问控制权限" />)}
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
