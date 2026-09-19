# Connect a project to ESKA Explorer

A global ESKA 0.11.0 or newer with compatible IDE API 1.0 is required.
Explorer offers installation if it is missing or incompatible. Installation and
updates require an explicit button click. `eska.explorer.executable` selects a
development backend; a compatible global CLI is still required. For Remote,
installation belongs to the workspace host. [CLI management (Russian)](cli-management.md).

If an existing project has no `eska.toml`, open a terminal at its root and run
`eska init`. Select the project type, source directory and workflow using the CLI
prompts. Supported sources are Designer XML; supported project types are
`configuration`, `extension`, `processing` and `report`.

Review the proposed settings before saving. Then run
**ESKA Explorer: Restart Connection**. The extension does not initialize projects,
or build a 1C configuration automatically. CLI installation requires confirmation.

## Install the extension

Install the VSIX using **Extensions → Install from VSIX…**, then reload if prompted.
The extension ID is `1c-tooling.eska-explorer`. A compatible global backend is required.
[Packaging instructions](packaging.md).
