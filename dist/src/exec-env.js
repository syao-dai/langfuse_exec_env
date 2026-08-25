const DEFAULT_BASE_URL = "http://172.21.0.1:3050";
export function setupLangfuseExecEnv(api) {
    const pluginConfig = (api.pluginConfig ?? {});
    const logLevel = pluginConfig.logLevel ?? "info";
    const isDebug = logLevel === "debug";
    const debug = (message) => {
        if (isDebug)
            api.logger.info(message);
    };
    const isValidGroup = (group) => Boolean(group?.publicKey?.trim() && group?.secretKey?.trim());
    const credentialGroups = (Array.isArray(pluginConfig.credentials) ? pluginConfig.credentials : []).filter(isValidGroup);
    if (credentialGroups.length === 0) {
        api.logger.info("[langfuse-exec-env] No Langfuse credential groups configured. " +
            "Configure via openclaw.json, e.g.:\n" +
            "  openclaw config set plugins.entries.langfuse-exec-env.config.credentials " +
            "'[{\"publicKey\":\"pk-lf-xxx\",\"secretKey\":\"sk-lf-xxx\",\"agentIds\":[\"my-agent\"]}]'\n" +
            "— exec env injection disabled");
        return;
    }
    api.logger.info(`[langfuse-exec-env] Configured ${credentialGroups.length} Langfuse credential group(s): ` +
        credentialGroups
            .map((group, index) => group.agentIds && group.agentIds.length > 0
            ? `#${index + 1}[agents: ${group.agentIds.join(", ")}]`
            : `#${index + 1}[default/catch-all]`)
            .join(", "));
    const resolveCredentials = (agentId) => (agentId && credentialGroups.find((group) => group.agentIds?.includes(agentId))) ||
        credentialGroups.find((group) => !group.agentIds || group.agentIds.length === 0);
    api.on("resolve_exec_env", (event, ctx) => {
        const group = resolveCredentials(ctx.agentId);
        if (!group) {
            debug(`[langfuse-exec-env] [DEBUG] No credential group matches agent ${ctx.agentId} ` +
                `(and no default/catch-all group configured); not injecting Langfuse env ` +
                `(host=${event.host})`);
            return;
        }
        const baseUrl = (group.baseUrl?.trim() ?? DEFAULT_BASE_URL).replace(/\/$/, "");
        debug(`[langfuse-exec-env] [DEBUG] Injecting Langfuse env for agent ${ctx.agentId} ` +
            `(host=${event.host}, baseUrl=${baseUrl})`);
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
//# sourceMappingURL=exec-env.js.map