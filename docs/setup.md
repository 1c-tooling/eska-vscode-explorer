# Connect a project to ESKA Explorer

The default backend is `eska-project serve --stdio`, Metadata API 1.12.
Build `cargo build -p eska-project` in an ESKA checkout containing that package,
then set `eska.explorer.executable` to its absolute binary path on the workspace
host. Default discovery checks `~/.eska/bin` first, then absolute PATH directories. The metadata tree works without the full CLI, Git, a 1C platform
or an analyzer. [Backend selection](cli-management.md).

Use **Prepare project and language components** for component setup. The current public ESKA release has no project ZIP; configure a local binary or install a local T97 package. The latest stable Analyzer app release can be installed independently. See [component setup](component-setup.md).

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

## Standalone formatting

Install `eska-fmt` for its CLI, add `eska` for the `eska fmt` facade, or add
`eska-project` API 1.33 for Explorer. The analyzer is independent. Managed archives
use `designer-xml-4`; keep the installed ESKA component contracts compatible.
The single ESKA status item opens the component list with versions, paths, update and recovery actions for the project backend, formatter and analyzer.
`eska.explorer.formatterExecutable` selects an explicit executable or the default
managed/PATH lookup. `eska.explorer.formatOnSave` is disabled by default.
Set formatting rules in `[format]` in `eska.toml`; native indentation settings do
not override them. Missing/incompatible formatters never fall back to the analyzer.
For offline operation disable `checkForFormatterUpdates` as well as other update checks.

## Multiline parameter hints

With `eska-project` API 1.34, continuation lines of multiline string arguments
receive the same visual advance as the first line. Related parameter labels and
invisible offsets use the editor font for an exact match; independent single-line
calls keep their native hints. This changes neither source text nor font settings.
Alignment requires `editor.inlayHints.enabled = "on"`. Conditional modifier-key
modes, explicit accessibility support, and actionable/resolvable hints retain
native rendering without alignment. [Details](language-service.md).

## Workspace project groups

Two or more visible extensions, reports or data processors of the same type
form a virtual group. The threshold is independent for each type. A single member
and configuration projects stay at the original level. Labels follow the tree
language. Search and reveal-from-file expand the right group; membership changes
retain surviving metadata selections and expansion without rewriting sources.
