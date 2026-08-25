import type { OpenClawPluginApi } from "../api.js";

/**
 * langfuse-exec-env — OpenClaw plugin
 *
 * Injects Langfuse credentials into the `exec` tool's environment on a
 * per-agent basis, via the `resolve_exec_env` hook. This lets an agent's
 * skills (e.g. sql-audit-trace, via `npx langfuse-cli` or the Langfuse HTTP
 * API) read back that agent's own Langfuse project data, without every
 * agent in the same OpenClaw process sharing one container-wide credential
 * set (as a plain docker-compose env var would force).
 *
 * This plugin only ever reads `ctx.agentId` from the hook context — it does
 * not need `hooks.allowConversationAccess`.
 *
 * Configuration via openclaw.json:
 *   credentials               — Array of Langfuse credential groups, each:
 *     credentials[].publicKey   — Langfuse project public key (required)
 *     credentials[].secretKey   — Langfuse project secret key (required)
 *     credentials[].baseUrl     — Langfuse server URL (default: http://172.21.0.1:3050)
 *     credentials[].agentIds    — Agent IDs this group applies to (omit/empty = default/catch-all)
 *
 * Example configuration — two teams, each reading back their own Langfuse project:
 *   openclaw config set plugins.entries.langfuse-exec-env.config.credentials '[
 *     {"publicKey":"pk-lf-teamA","secretKey":"sk-lf-teamA","agentIds":["teamA-agent"]},
 *     {"publicKey":"pk-lf-teamB","secretKey":"sk-lf-teamB","agentIds":["teamB-agent"]}
 *   ]'
 *
 * Injected env vars (for every exec call made by a matched agent):
 *   LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, LANGFUSE_HOST
 *     — read by `npx langfuse-cli` and the official Langfuse SDKs.
 *   AGENT_LANGFUSE_PUBLIC_KEY, AGENT_LANGFUSE_SECRET_KEY, AGENT_LANGFUSE_BASE_URL
 *     — read by sql-audit-trace's Step 0 HTTP-API fallback (kept under a
 *       separate prefix so it can't collide with the host's own LANGFUSE_*
 *       env vars if Claude Code itself is also wired to a Langfuse project).
 */

// One Langfuse project's credentials, optionally scoped to a set of agent IDs.
// A group with no `agentIds` (or an empty list) is the catch-all/default group.
interface CredentialGroup {
  publicKey?: string;
  secretKey?: string;
  baseUrl?: string;
  agentIds?: string[];
}

interface PluginConfig {
  logLevel?: "info" | "debug";
  credentials?: CredentialGroup[];
}

const DEFAULT_BASE_URL = "http://172.21.0.1:3050";

export function setupLangfuseExecEnv(api: OpenClawPluginApi): void {
  const pluginConfig = (api.pluginConfig ?? {}) as PluginConfig;

  const logLevel = pluginConfig.logLevel ?? "info";
  const isDebug = logLevel === "debug";
  const debug = (message: string) => {
    if (isDebug) api.logger.info(message);
  };

  const isValidGroup = (
    group: CredentialGroup | undefined,
  ): group is CredentialGroup & { publicKey: string; secretKey: string } =>
    Boolean(group?.publicKey?.trim() && group?.secretKey?.trim());

  const credentialGroups: Array<CredentialGroup & { publicKey: string; secretKey: string }> = (
    Array.isArray(pluginConfig.credentials) ? pluginConfig.credentials : []
  ).filter(isValidGroup);

  if (credentialGroups.length === 0) {
    api.logger.info(
      "[langfuse-exec-env] No Langfuse credential groups configured. " +
      "Configure via openclaw.json, e.g.:\n" +
      "  openclaw config set plugins.entries.langfuse-exec-env.config.credentials " +
      "'[{\"publicKey\":\"pk-lf-xxx\",\"secretKey\":\"sk-lf-xxx\",\"agentIds\":[\"my-agent\"]}]'\n" +
      "— exec env injection disabled",
    );
    return;
  }

  api.logger.info(
    `[langfuse-exec-env] Configured ${credentialGroups.length} Langfuse credential group(s): ` +
    credentialGroups
      .map((group, index) =>
        group.agentIds && group.agentIds.length > 0
          ? `#${index + 1}[agents: ${group.agentIds.join(", ")}]`
          : `#${index + 1}[default/catch-all]`,
      )
      .join(", "),
  );

  const resolveCredentials = (
    agentId?: string,
  ): (CredentialGroup & { publicKey: string; secretKey: string }) | undefined =>
    (agentId && credentialGroups.find((group) => group.agentIds?.includes(agentId))) ||
    credentialGroups.find((group) => !group.agentIds || group.agentIds.length === 0);

  api.on("resolve_exec_env", (event, ctx) => {
    const group = resolveCredentials(ctx.agentId);
    if (!group) {
      debug(
        `[langfuse-exec-env] [DEBUG] No credential group matches agent ${ctx.agentId} ` +
        `(and no default/catch-all group configured); not injecting Langfuse env ` +
        `(host=${event.host})`,
      );
      return;
    }

    const baseUrl = (group.baseUrl?.trim() ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    debug(
      `[langfuse-exec-env] [DEBUG] Injecting Langfuse env for agent ${ctx.agentId} ` +
      `(host=${event.host}, baseUrl=${baseUrl})`,
    );

    return {
      LANGFUSE_PUBLIC_KEY: group.publicKey,
      LANGFUSE_SECRET_KEY: group.secretKey,
      LANGFUSE_HOST: baseUrl,
      // sql-audit-trace's Step 0 HTTP-API fallback reads this prefix specifically
      // so it can't collide with the host's own LANGFUSE_* env vars.
      AGENT_LANGFUSE_PUBLIC_KEY: group.publicKey,
      AGENT_LANGFUSE_SECRET_KEY: group.secretKey,
      AGENT_LANGFUSE_BASE_URL: baseUrl,
    };
  });
}
