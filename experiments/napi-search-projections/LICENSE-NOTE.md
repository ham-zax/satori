# License inventory

This private experiment follows the repository's AGPL-3.0-only license.
`crate-licenses.json` records SPDX license declarations for every resolved Cargo
package, including direct, transitive, and build dependencies. Cargo.lock pins
that inventory. Generate it with `pnpm --ignore-workspace run licenses`.
Check it with `node licenses.mjs --check`. Both commands use `cargo metadata
--locked` and fail if a package has no license declaration. Upstream source and
license texts are available in the local Cargo registry package directories
reported by `cargo metadata --locked --format-version 1` (`manifest_path`).
No native binary is distributed by this experiment.

napi-derive's build dependencies include Unicode identifier/segmentation crates.
The projection kernel uses only ASCII byte predicates. The kernel adds no
Unicode rules or runtime Unicode dependency. It does not enable Tokio.
The JavaScript build/test tools and their exact resolved versions are recorded
in pnpm-lock.yaml. @napi-rs/cli is pinned to 3.10.8 (MIT).
