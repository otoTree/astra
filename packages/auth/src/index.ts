export type ProjectContext = Readonly<{
  organizationId: string;
  projectId: string;
  scopes: readonly string[];
}>;

export type AdminRole = "viewer" | "operator" | "model_releaser" | "security_auditor" | "admin";

export function requireScope(context: ProjectContext, scope: string): void {
  if (!context.scopes.includes(scope)) throw new Error(`missing_scope:${scope}`);
}
