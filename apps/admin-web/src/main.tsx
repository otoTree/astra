import React from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

function App() {
  return (
    <main className="shell">
      <header>
        <p className="eyebrow">ASTRA / INTERNAL CONTROL PLANE</p>
        <h1>模型集群控制台</h1>
        <p className="muted">骨架版本：API、调度、Provider、Worker 和发布模块正在接入。</p>
      </header>
      <section className="grid">
        {[
          ["Model Pools", "0 ready replicas", "等待 worker-control API"],
          ["Queue", "0 queued tasks", "PostgreSQL source of truth"],
          ["Releases", "0 active releases", "镜像 digest 发布"],
        ].map(([title, value, note]) => (
          <article key={title}>
            <h2>{title}</h2>
            <strong>{value}</strong>
            <span>{note}</span>
          </article>
        ))}
      </section>
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("admin_web_root_missing");

createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
