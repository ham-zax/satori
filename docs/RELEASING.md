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

The repository enforces the release graph before any publication. Authenticate
with npm separately before the publication command; `release:all` deliberately
does not start an interactive login flow.

```bash
pnpm run release:login
npm whoami --registry=https://registry.npmjs.org/
```

`release:login` runs npm's web-login flow. The `whoami` command must return the
npm account that has publish access to the `@zokizuan` packages. Do not continue
with publication if it returns `E401`, an unexpected identity, or an account
without package write access. npm can surface a scoped-package write-permission
failure as `E404 Not Found` on the publish `PUT`, so verify identity before
interpreting a publish-time 404 as a missing package.

The repository release commands are:

```text
versions:check
    fast, offline literal current-version reference validation

release:check
    runs the complete release qualification suite, then verifies the packed
    graph against the production registry

release:bump
    previews or applies an idempotent coordinated bump plan

release:all
    qualifies once, publishes the retained verified tarballs in
    Core -> MCP -> CLI order, and verifies the production latest closure

release:verify
    verifies the exact local versions, latest tags, and published dependency
    closure on the production registry
```

### `pnpm run versions:check`

Scans the fixed list of package manifests plus generated references and fails
when a literal `@zokizuan/<package>@x.y.z` reference does not match the local
manifest version. This is the fast literal-reference gate; it is part of
`pnpm run check`.

### `pnpm run release:check`

Requires a clean working tree, then runs `pnpm check`, the full Core, MCP, CLI,
and release-script tests, the MCP request-contract, documentation, and manifest
checks, a clean root build, and both packed release smokes. It refuses the
candidate if any command or the subsequent packed graph verification dirties
the working tree.

After qualification, it packs Core, MCP and CLI into a temporary directory,
verifies the packed release graph is exact, queries the production registry
for every published stable version, and compares normalized packed file trees
when the exact local version is already published.

A release graph is valid when every package is either:

- `unpublished` — the version does not exist on npm and needs publication; or
- `published-identical` — the version exists and the local packed artifact is
  byte-for-byte equivalent after normalized extraction, so it must be skipped.

Any `stale-version` (same version already published with a different artifact),
`invalid-graph` (packed dependencies do not match local versions),
`non-monotonic-version` (an unpublished local version is not greater than the
registry's highest stable version), or `superseded-version` (an identical local
artifact is older than the registry maximum) makes the release invalid, and
`release:check` exits nonzero.

The packed artifact, not Git tags or source timestamps, is the release truth:

- compiled JavaScript and declarations;
- package metadata;
- generated files;
- executable permissions;
- packaged assets;
- `workspace:*` dependencies rewritten by `pnpm pack`;
- transitive release-graph changes such as a stale Core pin in a packed MCP
  manifest.

If npm metadata cannot be verified (network failure, malformed output,
authentication error, registry outage), the check fails closed. A registry 404
for the exact version is the only response treated as "unpublished".

Example shape of a valid release candidate:

```text
Satori release graph

Package                         Local            Registry state   Action
@zokizuan/satori-core           <core-version>   unpublished      publish
@zokizuan/satori-mcp            <mcp-version>    unpublished      publish
@zokizuan/satori-cli            <cli-version>    unpublished      publish

Packed release graph
@zokizuan/satori-mcp dependency -> @zokizuan/satori-core@<core-version>
@zokizuan/satori-cli managed runtime -> @zokizuan/satori-mcp@<mcp-version>
@zokizuan/satori-cli managed runtime -> @zokizuan/satori-core@<core-version>

Release graph valid.
```

### `pnpm release:bump`

Plans coordinated version changes for one target and its reverse dependency
closure:

```text
Core changes
    -> Core must receive an unpublished version
    -> MCP must receive an unpublished version because it pins Core
    -> CLI must receive an unpublished version because its managed-runtime target records Core and MCP

MCP changes
    -> MCP must receive an unpublished version
    -> CLI must receive an unpublished version because its managed-runtime target records MCP

CLI-only changes
    -> only CLI must receive an unpublished version
```

"Receive an unpublished version" does not always mean increment again. A local
version that is already prepared, greater than the registry maximum, and high
enough to satisfy the requested major, minor, or patch intent remains unchanged
and absorbs additional coordinated changes. If a later explicit bump request is
stronger than the prepared version, the command advances it to the requested
minimum instead of making the result depend on bump-command order.

Usage:

```bash
pnpm release:bump -- core minor
pnpm release:bump -- core minor --apply
pnpm release:bump minor # shorthand for core minor; preview only
```

Preview mode performs no writes. Mutation requires `--apply`, which also
requires a clean working tree, runs `versions:check`, regenerates `server.json`
when MCP changes, and restores every file if generation or validation fails.

From a fully published state, the planner advances the requested package and
every reverse dependency whose exact dependency or managed-runtime target must change. From a
prepared-but-unpublished state, a version already high enough for the requested
intent remains unchanged and absorbs the coordinated changes. Always use the
planner output rather than copying version numbers from this document.

### `pnpm release minor`

Runs the coordinated Core minor bump with downstream MCP and CLI updates,
commits the release manifests, pushes `master` to the canonical repository,
then invokes the existing publication workflow. `major` and `patch` work the
same way. This command requires a clean working tree and local `master` that
contains canonical `master`; it never force-pushes. Commit your implementation
changes before running it.

If commit, push, or publication fails, the command stops and preserves the
prepared files or commit. Resolve that failure before retrying. After a partial
publication, use `pnpm release` to retry the prepared graph without requesting
another version bump.

Plain `pnpm release` remains publish-only, as does `pnpm run release:all`.

### `pnpm run release:all`

The single supported publication path. It runs:

1. the same complete qualification owned by `release:check`;
2. publication of only the retained, already-verified tarballs in Core -> MCP
   -> CLI order;
3. exact-version verification plus dependency or managed-runtime target verification after each package;
4. final verification that all exact versions and all three `latest` tags form
   the expected local Core -> MCP -> CLI closure.

Preconditions: a valid npm login with publish access to the scoped packages, a
clean working tree, `master` branch, `HEAD` exactly equal to `master` fetched
directly from `https://github.com/ham-zax/satori.git` into the dedicated
`refs/remotes/satori-release/master` authority ref, and a valid monotonic
release graph. Source authority is fetched and checked both before
and after qualification, immediately before any registry write.
Already-published identical packages are skipped only after their `latest` tags
are verified before the first registry write. An intentional emergency release
from locally-ahead commits requires the explicit `--allow-unpushed-head`
override; canonical release master must still be an ancestor of `HEAD`, so
stale or diverged history is rejected.

After publishing Core, `release:all` polls until `@zokizuan/satori-core@<version>`
is visible on npm, then publishes MCP, then verifies that the published MCP pins
the exact Core version, then publishes CLI and verifies its exact
`satoriManagedRuntime` Core and MCP targets. A publish
command is never retried automatically. If verification fails after a
successful publish, the run stops and reports exactly which packages were
already published.

Registry reads normalize and validate both npm 11 and npm 12 `npm view --json`
shapes. Final propagation checks retry transient network, not-found, and
temporarily stale registry state, while authentication failures and malformed
responses fail immediately.

All registry probes, tarball downloads, and publication commands are pinned to
`https://registry.npmjs.org/`; publication explicitly uses `--tag latest` and
`--access public`. Package `publishConfig` repeats those constraints as
defense-in-depth.

The individual package publish scripts are deliberately disabled. Publication
must use `release:all`:

```bash
pnpm run release:core
pnpm run release:mcp
pnpm run release:cli
```

Each command exits nonzero with a message directing the operator to
`pnpm run release:all`.

### `pnpm run release:verify`

Reads the local Core, MCP, and CLI versions and fails unless every exact version
exists on the production registry, every package's `latest` tag equals that
version, published MCP pins the exact local Core, and published CLI pins the
exact local Core and MCP.

## Rules for Manual Publication

- never manually publish MCP before its exact Core version exists on npm;
- never manually publish CLI before its exact MCP and Core versions exist on
  npm;
- an already-published same version with a different packed artifact is a
  release error and requires a new version;
- unpublished prepared versions may accumulate coordinated changes without
  another bump;
- `workspace:*` remains in source manifests and must appear as exact versions
  in the packed (published) manifests;
- do not publish at all when npm metadata cannot be verified.

The release smokes run inside both `release:check` and `release:all` before any
publication.

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
indexes, hooks, and repository profiles are preserved. Running coding
agents must be restarted to use an activated runtime update.
