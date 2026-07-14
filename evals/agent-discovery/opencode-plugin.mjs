import { createAgentDiscoveryGuard } from "./opencode-guard.mjs";

export default async function agentDiscoveryPlugin() {
    return createAgentDiscoveryGuard(process.env);
}
