

# Satori Pitch Deck Content

## Slide 1: Title

**Satori**
**Repo context for AI coding agents**

**Subtitle:**
An open-source developer tool that helps AI coding agents investigate real codebases before editing.

**Footer:**
MIT open source · MCP-compatible · Built for Codex, Claude, and OpenCode workflows

**Context / speaker note:**
Satori helps coding agents move beyond basic grep-style search. It gives them a structured path from intent search to exact code evidence before they propose edits.

---

## Slide 2: Problem

**AI coding agents often edit from incomplete repo context**

Modern coding agents are powerful, but they still struggle when working inside real codebases. They may find nearby text, guess the right file, miss related code paths, or rely on stale repository context.

This creates common failure modes:

* The agent edits the obvious file, not the right implementation.
* It changes a function without checking what calls it.
* It relies on outdated index or search results.
* The developer cannot easily inspect what evidence the agent used.
* Search finds code, but does not guide the agent toward the next useful step.

**Context / speaker note:**
The problem is not that agents cannot search. The problem is that search alone is not enough for safe code changes in real repositories.

---

## Slide 3: Solution

**Satori gives agents an investigation path before they edit**

Satori indexes a software repository and gives MCP-compatible coding agents a deterministic way to search, navigate, and read code evidence before proposing changes.

Agents can:

* Search by plain-English intent.
* Open exact functions, symbols, or file ranges.
* Inspect related caller and callee paths.
* Detect stale, partial, or unsafe repo context.
* Follow suggested next actions instead of guessing.
* Keep source-code edits inside the user’s normal editor or agent host.

**Context / speaker note:**
Satori does not edit your code. It gives agents better repo evidence while edits stay in the user's editor or agent host.

---

## Slide 4: Product

**A fixed six-tool MCP surface for repo investigation**

Satori exposes a small, stable tool surface that coding agents can reliably use during development workflows.

**Core capabilities:**

1. **Search codebase**
   Find relevant implementation areas using semantic search, exact identifiers, and keyword matching.

2. **Inspect file outline**
   Map functions, classes, symbols, and implementation structure inside a file.

3. **Read exact evidence**
   Open bounded file ranges or exact symbols instead of dumping large files into context.

4. **Trace callers and callees**
   Inspect nearby dependency paths when relationship metadata is available.

5. **Manage index lifecycle**
   Create, sync, reindex, check status, or clear repository indexes.

6. **List indexed codebases**
   See which repositories are ready, indexing, failed, or require reindexing.

**Context / speaker note:**
The product is intentionally small. Instead of exposing a large set of knobs, Satori gives agents a predictable path from search to evidence.

---

## Slide 5: Why It Matters

**Reducing blind edits in real engineering workflows**

Satori is built around a simple principle: agents should inspect real code evidence before proposing changes.

**Without Satori:**
An agent searches nearby files, guesses which implementation matters, edits from partial context, and leaves the developer to discover what it missed.

**With Satori:**
An agent searches by behavior, opens the exact implementation span, checks related code paths, and receives warnings when the repo context is stale or incomplete.

**Benefits:**

* Fewer wrong-file edits.
* Better investigation before refactors.
* More inspectable agent decisions.
* Safer use of AI agents in large repositories.
* Clear recovery guidance when context is unsafe.

**Context / speaker note:**
This is the stakeholder value slide. Avoid going too deep into ASTs, fingerprints, or vector storage here. The reviewer should understand the practical outcome.

---

## Slide 6: Users and Market

**Built for developers and teams using AI coding agents**

Satori is designed for developers and engineering teams working with AI coding agents on repositories that are too large, fragmented, or active to paste into a chat window.

**Initial users:**

* Indie developers using Claude Code, Codex, OpenCode, or MCP clients.
* Engineering teams adopting AI-assisted development.
* Developers working in monorepos or multi-package repositories.
* Teams that need inspectable evidence before agent-driven code changes.
* Developers who want local-first or self-hosted repo intelligence.

**Use cases:**

* Bug investigation.
* Refactoring support.
* Onboarding to unfamiliar codebases.
* Finding implementation ownership.
* Checking caller/callee impact before changes.
* Keeping AI coding workflows grounded in current repo state.

**Context / speaker note:**
Frame this as developer infrastructure for the AI coding workflow category. Do not present it as consulting.

---

## Slide 7: Current Status

**Open-source, packaged, and usable today**

Satori is currently available as an open-source developer tool with published packages and supported MCP client setup.

**Current status:**

* MIT-licensed open-source project.
* Published npm packages for core indexing, MCP server, and CLI installation.
* CLI installer supports Codex, Claude, and OpenCode workflows.
* Six fixed MCP tools with no source-code write tools exposed.
* Supports Milvus/Zilliz vector storage.
* Supports embedding providers including VoyageAI, OpenAI, Gemini, and Ollama.
* Includes diagnostics to check provider and vector-store setup.
* Designed for local-first developer workflows, with a path toward hosted team workflows.

**Optional metric box:**
**Status:** MVP / early product
**Distribution:** Open source + npm
**Primary users:** Developers using AI coding agents
**Business direction:** Developer tooling / AI infrastructure

**Context / speaker note:**
This slide should prove that Satori is not just an idea. It is already packaged, installable, and positioned as a software product.

---

## Slide 8: Azure Opportunity

**Azure credits would help Satori become Azure-native**

Satori currently runs as a local-first open-source tool using Milvus/Zilliz and multiple embedding providers. Azure credits would support the next stage: building and validating Azure-native infrastructure for hosted and team-based workflows.

**Planned Azure use cases:**

* **Azure OpenAI** for embeddings and model workflows.
* **Azure AI Search** as a managed vector search backend.
* **Azure Blob Storage** for shared index state, symbol metadata, and relationship metadata.
* **Azure Container Apps** for hosted indexing and API services.
* **Azure-based evaluation pipelines** for retrieval quality testing and regression checks.
* **Future team workflows** for shared repo context across engineering teams.

**Context / speaker note:**
Be clear that Azure integration is planned, not already built. The honest message is: Satori has the architecture to support Azure adapters, and the credits would fund that work.

---

## Slide 9: Roadmap

**From local-first tool to hosted repo intelligence for teams**

**Near-term roadmap:**

* Improve symbol-owned retrieval so agents navigate by implementation units instead of raw text chunks.
* Expand caller/callee support and relationship-backed navigation.
* Harden index lifecycle, stale-state recovery, and fallback behavior.
* Improve onboarding through CLI diagnostics and guided MCP workflows.
* Build Azure-native adapters for embeddings, vector search, storage, and hosted indexing.

**Longer-term roadmap:**

* Hosted team workflows.
* Shared repository indexes.
* Multi-user freshness tracking.
* Enterprise-grade repo intelligence.
* Evaluation tooling for comparing agent retrieval quality across real repositories.

**Context / speaker note:**
Separate what is built from what is planned. Microsoft reviewers will accept roadmap ambition, but the wording should not imply hosted SaaS already exists.

---

## Slide 10: Ask

**Using Microsoft for Startups credits to accelerate Satori**

Satori is seeking Microsoft for Startups support to validate Azure-native infrastructure and move from a local-first open-source tool toward hosted developer workflows.

**Credits would be used for:**

* Azure OpenAI integration testing.
* Azure AI Search vector backend development.
* Hosted indexing jobs.
* Storage for shared repo metadata and sidecars.
* Evaluation and regression pipelines.
* API and container infrastructure for early team workflows.

**Goal:**
Build the Azure-native foundation for Satori as developer infrastructure for AI-assisted software engineering.

**Closing line:**
Satori helps AI coding agents investigate real codebases before editing, making agent-assisted development easier to inspect and trust.

**Context / speaker note:**
This is the application-specific slide. It connects the product to Microsoft’s startup program and makes the credit use concrete.

---

# Optional Appendix Slide

Use this only if the upload allows a longer deck or if you want a final credibility page.

## Appendix: What Satori Does Not Claim

Satori is intentionally honest about its current boundaries.

* It is not an agent framework.
* It does not expose source-code write tools through MCP.
* It does not replace tests, typechecking, code review, or engineering judgment.
* It is not a hosted SaaS today.
* Azure-native adapters are planned, not currently shipped.
* Some language features are capability-dependent, especially call graph support.

**Context / speaker note:**
This slide can help with technical trust, but it is optional. For a startup application, I would only include it if the deck still feels concise.
