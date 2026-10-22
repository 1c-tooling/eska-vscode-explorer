# Connect a project to ESKA Explorer

The default backend is `eska-project serve --stdio`, Metadata API 1.12.
Build `cargo build -p eska-project` in an ESKA checkout containing that package,
then set `eska.explorer.executable` to its absolute binary path on the workspace
host. Default discovery checks `~/.eska/bin` first, then absolute PATH directories. The metadata tree works without the full CLI, Git, a 1C platform
or an analyzer. [Backend selection](cli-management.md).

Use **Prepare project and language components** for component setup. The current public ESKA release has no project ZIP; configure a local binary or install a local T97 package. Analyzer 0.3.2 can be installed independently. See [component setup](component-setup.md).

For the documented older `eska ide`, explicitly choose
`eska.explorer.backend = "legacy"` and your `eska` executable. Its path is kept;
Explorer shows a Legacy indicator and warning. An incompatible component is
never replaced by a different executable automatically.

If an existing Designer XML export has no `eska.toml`, run `eska-project init`
at its root. Use `--source` for a directory other than the root or `src`.
Types `configuration`, `extension`, `processing` and `report` are supported.
This command does not initialize Git or start a platform. In legacy mode you
can use `eska init` with that CLI's options instead.

Review the manifest, then run **ESKA Explorer: Restart Connection**.
The extension does not initialize a project or build a 1C configuration automatically.

## Install the extension

Install the VSIX using **Extensions → Install from VSIX…**. The extension ID is
`1c-tooling.eska-explorer`. [Packaging instructions](packaging.md).
