const environmentName = /^[A-Z_][A-Z0-9_]*$/;
const reservedName = /^(?:WORKER_|MODEL_APP_RELEASE$)/;
const sensitiveName = /(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY|API_KEY|CREDENTIAL)/;

export function parseEnvironmentText(source: string): Record<string, string> {
  const environment: Record<string, string> = {};
  const lines = source.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? "";
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) throw new Error(`第 ${index + 1} 行需要使用 KEY=VALUE`);
    const name = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (!environmentName.test(name)) throw new Error(`第 ${index + 1} 行的变量名无效`);
    if (reservedName.test(name)) throw new Error(`${name} 由 Astra 管理`);
    if (sensitiveName.test(name)) throw new Error(`${name} 必须使用平台凭证管理`);
    if (name in environment) throw new Error(`${name} 重复出现`);
    if (value.length > 8192) throw new Error(`${name} 的值过长`);
    environment[name] = value;
  }
  if (Object.keys(environment).length > 64) throw new Error("环境变量不能超过 64 个");
  return environment;
}

export function rolloutStrategyFromForm(values: FormData): Record<string, string | number | boolean> {
  const number = (name: string): number => Number(values.get(name));
  return {
    max_surge: number("max_surge"),
    max_unavailable: number("max_unavailable"),
    batch_size: number("batch_size"),
    readiness_timeout_seconds: number("readiness_timeout_seconds"),
    readiness_stability_seconds: number("readiness_stability_seconds"),
    progress_deadline_seconds: number("progress_deadline_seconds"),
    pause_on_failure: values.get("pause_on_failure") === "on",
    maximum_failure_rate_basis_points: number("maximum_failure_rate_basis_points"),
    maximum_duration_regression_basis_points: number("maximum_duration_regression_basis_points"),
    maximum_extra_cost_minor: number("maximum_extra_cost_minor"),
    currency: String(values.get("currency")),
    rollback_retention_seconds: number("rollback_retention_seconds"),
  };
}
