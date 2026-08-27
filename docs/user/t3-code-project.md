# T3 Chat Helper pseudo-project

Open **Settings → General → T3 Code configuration → Open project** to start the built-in T3 Chat Helper. This pseudo-project is a chat surface for managing the running T3 Code environment; it is not a source repository.

Ask the agent to explain a setting, inspect the active configuration, change settings or keybindings, or answer a question about T3 Code. The project directs the agent to the user documentation first, then internal documentation, and finally the exact source checkout when documentation is not enough.

The project belongs to the selected T3 Code environment. A remote environment therefore opens and edits that remote server's configuration rather than files on the device displaying the client.

The workspace records the running server version and source commit. Before inspecting implementation details, the agent prepares that exact commit in an isolated, read-only `source` directory. It does not assume the latest `main` branch matches the running server. Product code changes belong in a separate normal project.

T3 Code creates the helper workspace separately from its runtime data. Supported typed APIs can update settings and keybindings, and direct writes are limited to those two user-managed JSON files. The source snapshot, state database, authentication material, runtime identifiers, logs, attachments, caches, and all worktrees remain read-only or inaccessible from this helper.

The bundled paperclip icon identifies the helper on web, desktop, and mobile through the shared project-favicon contract. Clients retain their standard accessible folder or project-name fallback if the asset cannot be loaded.
