# Connect a project to eska Explorer

Install an eska executable supporting `eska ide --stdio` and IDE API 1.0.
The CLI version does not replace the API handshake. Set `eska.explorer.executable`
if the executable is not available through PATH. For Remote workspaces, install
it on the workspace host, not only on your local computer.

If an existing project has no `eska.toml`, open a terminal at its root and run
`eska init`. Select the project type, source directory and workflow using the CLI
prompts. Supported sources are Designer XML; supported project types are
`configuration`, `extension`, `processing` and `report`.

Review the proposed settings before saving. Then run
**eska Explorer: Restart Connection**. The extension does not initialize projects,
install eska or build a 1C configuration automatically.

## Install the extension

Install the VSIX using **Extensions → Install from VSIX…**, then reload if prompted.
The extension ID is `1c-tooling.eska-explorer`. The backend is installed separately.
[Packaging instructions](packaging.md).
