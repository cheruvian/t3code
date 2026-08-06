# T3 Code agent project

Open **Settings → General → T3 Code configuration → Open project** to start a project for managing T3 Code itself.

Ask the agent to explain a setting, inspect the active configuration, change settings or keybindings, or answer a question about T3 Code. The project directs the agent to the user documentation first, then internal documentation, and finally the exact source checkout when documentation is not enough.

The project belongs to the selected T3 Code environment. A remote environment therefore opens and edits that remote server's configuration rather than files on the device displaying the client.

The workspace records the running server version and source commit. Before inspecting implementation details, the agent prepares that exact commit in an isolated, read-only `source` directory. It does not assume the latest `main` branch matches the running server. Product code changes belong in a separate normal project.

T3 Code creates the agent workspace separately from its runtime data. Its instructions identify the live settings and keybindings files while telling the agent not to touch databases, credentials, logs, attachments, caches, or worktrees unless you explicitly request that operation.
