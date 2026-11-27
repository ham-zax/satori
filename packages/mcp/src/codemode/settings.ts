export function readCodeModeSettings(get: (name: string) => string | undefined) {
    const enabled = get("SATORI_CODEMODE")?.trim() !== "0";
    return {
        enabled,
        compact: enabled && get("SATORI_TOOL_PROFILE")?.trim() === "compact",
        configPath: enabled ? get("SATORI_CODEMODE_MCP_CONFIG") || undefined : undefined,
    };
}

export type CodeModeSettings = ReturnType<typeof readCodeModeSettings>;
