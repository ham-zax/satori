import { createLanguageAnalysisService, normalizeLanguageId, type LanguageAnalysisPort } from "@satori-code/core";
import type { SourceLineSpan } from "./bounded-source-selector.js";
import { CURRENT_SOURCE_MAX_BYTES } from "./current-source-symbols.js";
import type { InspectableSourceEvidence } from "./inspectable-source.js";

type ContextSpans = readonly Readonly<SourceLineSpan>[] | undefined;

/** Owns transient syntax evidence. The inspected hash is the cache witness, never source authority. */
export class SourceContextEvidenceOwner {
    private cached?: { key: string; spans: Promise<ContextSpans> };

    public constructor(private readonly analyzer: LanguageAnalysisPort = createLanguageAnalysisService({
        chunkSize: CURRENT_SOURCE_MAX_BYTES,
        chunkOverlap: 0,
    })) {}

    public async collect(evidence: InspectableSourceEvidence, language: string): Promise<ContextSpans> {
        let spans: Promise<ContextSpans> | undefined;
        try {
            const normalizedLanguage = normalizeLanguageId(language);
            if (evidence.sourceBytes.byteLength > CURRENT_SOURCE_MAX_BYTES
                || this.analyzer.getStrategyForLanguage(normalizedLanguage).backend !== "oxc") return undefined;
            const key = JSON.stringify([evidence.canonicalRoot, evidence.relativeFile, evidence.observedHash, normalizedLanguage]);
            if (this.cached?.key === key) {
                spans = this.cached.spans;
            } else {
                spans = this.analyzer.analyze({
                    content: evidence.source,
                    relativePath: evidence.relativeFile,
                    language: normalizedLanguage,
                    includeEarlyExitSpans: true,
                }).then((analysis): ContextSpans => analysis.structuralStatus === "complete" && analysis.earlyExitSpans
                    ? Object.freeze(analysis.earlyExitSpans.map(span => Object.freeze({
                        startLine: span.startLine, endLine: span.endLine,
                    }))) : undefined);
                // Retain one file only, including concurrent requests for that same hash.
                this.cached = { key, spans };
            }
            // Cached callers also await analysis before releasing the inspected source.
            return await spans;
        } catch {
            if (spans && this.cached?.spans === spans) this.cached = undefined;
            // Syntax spans are optional. Preserve the caller's first source selection.
            return undefined;
        }
    }
}

export const sourceContextEvidenceOwner = new SourceContextEvidenceOwner();
