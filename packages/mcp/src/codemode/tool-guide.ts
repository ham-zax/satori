export const SCRIPT_TOOL_GUIDE: ReadonlyMap<string, string> = new Map([
    ["architecture_overview", "({path}) for repository boundaries and hotspots"],
    ["detect_changes", "({path, baseRef?}) for Git diff impact"],
    ["find_references", "({path, symbolRef: {file, symbolId}}) for exact occurrences"],
    ["list_codebases", "({}) for indexed repositories and readiness"],
    ["trace_path", "({path, sourceSymbolId, targetSymbolId}) for a path between exact symbols"],
]);

export const CODEMODE_AGENT_GUIDANCE = "If run_script is available, use it to chain related tool calls. Its description gives the tools.<name>(args) signatures for compact mode.";
