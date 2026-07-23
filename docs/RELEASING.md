# Releasing Satori

Satori is published as three packages:

- `@zokizuan/satori-core`
- `@zokizuan/satori-mcp`
- `@zokizuan/satori-cli`

They have independent versions but form one exact release closure:

```text
CLI -> exact MCP version
CLI -> exact Core version
MCP -> the same exact Core version
```

`satori upgrade` reads the latest CLI manifest as the release authority. It
does not independently select the latest MCP or Core package. A runtime release
therefore becomes visible to users only when the latest CLI points to that
exact compatible closure.

## What to Publish

| Changed package | Required publication order |
|---|---|
| CLI only | CLI |
| MCP, with the same Core | MCP, then CLI |
| Core | Core, then a new MCP bound to it, then CLI |
| MCP and Core | Core, then MCP, then CLI |
| All three | Core, then MCP, then CLI |

Even when CLI implementation code did not change, publish a new CLI version
when it must expose a new MCP/Core closure. When Core changes, MCP also needs a
new publication because MCP's packed manifest owns an exact Core dependency.

Publishing MCP or Core alone is safe, but existing users will not receive that
package through `satori upgrade` until a compatible CLI release points to it.
This prevents partially published releases from being assembled into an
untested runtime.

## Manifest Contract

The workspace source manifests use `workspace:*` for first-party dependencies.
`pnpm pack` must rewrite those entries to exact stable versions in the
published manifests.

Before publishing, the packed-release smoke verifies:

- packed CLI version matches the source CLI version;
- packed MCP version matches the source MCP version;
- packed Core version matches the source Core version;
- CLI depends on those exact MCP and Core versions;
- MCP depends on that exact Core version;
- the packed Core package metadata is resolvable; and
- MCP resolves Core from inside the installed release closure.

Do not replace these exact dependencies with ranges. The upgrade command rejects
incomplete, mismatched, out-of-root, or downgrade-producing closures.

## Release Procedure

Run the closure and packed-artifact checks before publishing:

```bash
pnpm run versions:check
pnpm run release:smoke:mcp
pnpm run release:smoke:cli
```

Publish only the packages required by the table above. For a complete closure:

```bash
pnpm run release:all
```

The equivalent explicit order is:

```bash
pnpm run release:core
pnpm run release:mcp
pnpm run release:cli
```

For a partial release, use only the applicable commands while preserving the
same dependency order. Each package's publish lifecycle runs its owning build
and release smoke.

Verify the registry after publication:

```bash
pnpm run release:verify
```

Then exercise `satori upgrade` from an existing managed installation. The
receipt must report the expected CLI, MCP, and Core versions. If candidate
runtime verification fails, the upgraded CLI remains installed while the
previous managed runtime and launcher remain active.

## User-Visible Upgrade Behavior

Users run:

```bash
satori upgrade
```

or, without a global CLI installation:

```bash
npx -y @zokizuan/satori-cli@latest upgrade
```

The CLI update occurs first. The exact MCP/Core candidate is then installed,
validated, and activated through the stable launcher. Client configuration,
indexes, skills, hooks, and repository profiles are preserved. Running coding
agents must be restarted to use an activated runtime update.
