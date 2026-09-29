import {
    COMMAND_OPTION_SPECS,
    GLOBAL_OPTION_SPECS,
    type CommandOptionSpec,
    type HelpTopic,
} from "./args.js";

interface CommandHelp {
    usage: string[];
    summary: string;
    examples: string[];
}

const COMMAND_HELP: Readonly<Record<HelpTopic, CommandHelp>> = {
    install: {
        usage: ["satori install [options]"],
        summary: "Install the Satori runtime and configure your coding agents.",
        examples: [
            "satori install",
            "satori install --client codex --dry-run",
        ],
    },
    uninstall: {
        usage: ["satori uninstall [options]"],
        summary: "Remove Satori-managed client configuration.",
        examples: [
            "satori uninstall --dry-run",
            "satori uninstall --purge",
        ],
    },
    doctor: {
        usage: ["satori doctor [options]"],
        summary: "Check installation, runtime, and client configuration.",
        examples: [
            "satori doctor",
            "satori doctor --verbose",
        ],
    },
    upgrade: {
        usage: ["satori upgrade", "satori update"],
        summary: "Update the CLI and its compatible MCP/Core runtime (update is an alias).",
        examples: ["satori upgrade"],
    },
    terminate: {
        usage: ["satori terminate"],
        summary: "Stop all running Satori MCP servers.",
        examples: ["satori terminate"],
    },
    version: {
        usage: ["satori version", "satori -v", "satori --version"],
        summary: "Show installed CLI, MCP, and Core versions.",
        examples: ["satori version", "satori --format json version"],
    },
    "tools-list": {
        usage: ["satori tools list"],
        summary: "List the available MCP tools (use --format json for full input schemas).",
        examples: ["satori tools list", "satori tools list --format json"],
    },
    "tool-call": {
        usage: [
            "satori tool call <toolName> --args-json '<json>'",
            "satori tool call <toolName> --args-file <path>",
        ],
        summary: "Call an MCP tool from the terminal. Text output prints the tool's readable summary.",
        examples: [
            "satori tool call list_codebases --args-json '{}'",
            "satori tool call manage_index --args-json '{\"action\":\"status\",\"path\":\"/abs/repo\"}' --format json",
        ],
    },
};

function optionLabel(option: CommandOptionSpec): string {
    return option.value ? `${option.flag} <${option.value}>` : option.flag;
}

export function formatCommandHelpText(topic: HelpTopic): string {
    const help = COMMAND_HELP[topic];
    const commandOptions = [
        ...COMMAND_OPTION_SPECS[topic],
        { flag: "-h, --help", description: "Show this help" },
    ];
    // Align both option groups to one column so they read as a single table.
    const all = [...commandOptions, ...GLOBAL_OPTION_SPECS];
    const width = Math.max(...all.map((option) => optionLabel(option).length));
    const render = (options: readonly CommandOptionSpec[]) => options
        .map((option) => `  ${optionLabel(option).padEnd(width)}  ${option.description}`);
    return [
        help.summary,
        "",
        "Usage:",
        ...help.usage.map((line) => `  ${line}`),
        "",
        "Options:",
        ...render(commandOptions),
        "",
        "Global options (accepted before or after the command):",
        ...render(GLOBAL_OPTION_SPECS),
        "",
        "Examples:",
        ...help.examples.map((line) => `  ${line}`),
        "",
    ].join("\n");
}
