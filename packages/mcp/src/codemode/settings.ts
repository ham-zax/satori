export function readCodeModeSettings(get: (name: string) => string | undefined) {
    const enabled = get("SATORI_CODEMODE")?.trim() !== "0";
    return {
        enabled,
        configPath: enabled ? get("SATORI_CODEMODE_MCP_CONFIG") || undefined : undefined,
    };
}

export type CodeModeSettings = ReturnType<typeof readCodeModeSettings>;
