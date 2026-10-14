import test from "node:test";
import assert from "node:assert/strict";
import { COMMAND_OPTION_SPECS, GLOBAL_OPTION_SPECS, type HelpTopic } from "./args.js";
import { formatCommandHelpText } from "./command-help.js";

const TOPICS = Object.keys(COMMAND_OPTION_SPECS) as HelpTopic[];

function listedFlags(text: string, heading: string): string[] {
    const lines = text.split("\n");
    const start = lines.indexOf(heading);
    assert.notEqual(start, -1, `${heading} section is missing`);
    const flags: string[] = [];
    for (const line of lines.slice(start + 1)) {
        if (line === "") break;
        flags.push(line.trim().split(/\s{2,}/)[0].replace(/ <.*>$/, ""));
    }
    return flags;
}

test("per-command help lists usage, exactly the parser's options, and examples", () => {
    for (const [topic, name] of [
        ["install", "install"],
        ["uninstall", "uninstall"],
        ["doctor", "doctor"],
        ["tool-call", "tool call"],
    ] as const) {
        const text = formatCommandHelpText(topic);
        assert.match(text, new RegExp(`Usage:\\n  satori ${name}\\b`), topic);
        assert.match(text, /Examples:\n {2}satori /, topic);
        assert.deepEqual(
            listedFlags(text, "Options:"),
            [...COMMAND_OPTION_SPECS[topic].map((option) => option.flag), "-h, --help"],
            topic,
        );
        assert.deepEqual(
            listedFlags(text, "Global options (accepted before or after the command):"),
            GLOBAL_OPTION_SPECS.map((option) => option.flag),
            topic,
        );
    }
});

test("every help topic renders", () => {
    for (const topic of TOPICS) {
        assert.match(formatCommandHelpText(topic), /^\S.*\n\nUsage:\n {2}satori /, topic);
    }
});

test("reranker help documents provider selection, models, and verification control", () => {
    const text = formatCommandHelpText("reranker");
    assert.match(text, /satori reranker use <provider> \[--model <name>\] \[--no-verify\]/);
    assert.match(text, /satori reranker use voyage --model rerank-3/);
    assert.match(text, /--no-verify\s+Skip the Voyage reranker test call/);
    assert.match(text, /paid API/);
    assert.match(text, /VOYAGEAI_API_KEY/);
    assert.match(text, /hidden input/);
    assert.match(text, /~\/\.satori\/\.env/);
    assert.match(text, /Enter cancels without switching/);
    assert.match(text, /Existing keys.*skip the prompt/);
    assert.match(text, /Without a terminal/);
});
