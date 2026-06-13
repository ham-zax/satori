# Security Policy

## Supported Versions

Security fixes target the current `main` branch and the latest published versions of:

- `@zokizuan/satori-core`
- `@zokizuan/satori-mcp`
- `@zokizuan/satori-cli`

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

## Disclosure

Please give maintainers reasonable time to investigate and release a fix before publishing exploit details. This project does not currently offer a bug bounty or guaranteed response SLA.
