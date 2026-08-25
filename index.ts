import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { setupLangfuseExecEnv } from "./src/exec-env.js";

export default definePluginEntry({
  id: "langfuse-exec-env",
  name: "Langfuse Exec Env",
  description:
    "Injects per-agent Langfuse credentials into the exec tool's environment so agent skills can query Langfuse on that agent's behalf",
  register(api) {
    setupLangfuseExecEnv(api);
  },
});
