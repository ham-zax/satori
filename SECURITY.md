# Security Policy

## Supported Versions

Security fixes target the current `main` branch and the latest published versions of:

- `@satori-code/core`
- `@satori-code/mcp`
- `@satori-code/cli`

Older versions may receive fixes when the issue is severe and a patch release is practical.

## Reporting a Vulnerability

Do not open a public issue with exploit details, provider tokens, private repository content, or sensitive logs.

Preferred path:

1. Use GitHub private vulnerability reporting if it is enabled for this repository.
2. If private reporting is unavailable, open a minimal public issue asking for a private security contact path. Do not include technical details beyond the affected package and broad impact category.

Useful details for a private report:

- affected package and version,
- operating system and Node.js version,
- MCP client, if relevant,
- exact command or tool call shape,
- expected behavior,
- observed behavior,
- impact,
- minimal reproduction without secrets or private code.

## Scope

Security-relevant issues include:

- source-code write or filesystem mutation paths exposed through read-only MCP tools,
- path traversal or reads outside the requested repository boundary,
- leakage of API keys, environment variables, private repo content, or logs,
- unsafe generated client config,
- destructive index lifecycle behavior without explicit user intent,
- dependency or install-chain issues that affect normal setup.

Satori is a local/developer tool and depends on user-provided embedding and vector-store providers. Provider account security, third-party service outages, and exposed user credentials outside this project are out of scope unless Satori caused the exposure.

## Shared Runtime Trust Boundary

The shared runtime (one offline Potion + LanceDB host serving multiple MCP sessions over a Unix socket) is a **same-OS-user facility**. The socket is created with mode `0600` and its directories are owned with mode `0700`, which enforces an **OS-user boundary**: other OS users cannot connect or read host state.

This does **not** enforce a boundary between processes running as the same OS user. Any same-UID process can read the host metadata file (`host.json`, mode `0600`) and connect to the socket. For the current release, same-UID processes are treated as **inside** the shared-runtime trust boundary.

Consequences of this model:

- The attach handshake `challengeNonce` is a client-generated freshness/correlation value echoed by the host. It proves the live host answered this exact attach; it does **not** authenticate the launcher against a malicious same-UID process.
- The metadata `ownershipToken` is a lifecycle-state ownership marker used only so the owning host can remove its own stale socket/metadata state. It is never transmitted over the socket and never used as a launcher credential. A token stored in same-UID-readable metadata cannot authenticate against same-UID attackers, so none is claimed.
- If protection from malicious same-UID processes is ever required, the shared host must run under a separate OS identity or broker with per-launcher capabilities delivered outside the metadata file; a metadata-readable bearer token is not a fix.

## Disclosure

Please give maintainers reasonable time to investigate and release a fix before publishing exploit details. This project does not currently offer a bug bounty or guaranteed response SLA.
