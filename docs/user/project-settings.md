# Customize a project icon

T3 Code selects a project icon automatically. It checks `t3.json`, common favicon and app icon
paths, and icon links in project HTML files.

To choose a different icon:

1. Open **Settings** and select **Projects**.
2. Select the project.
3. Under **Appearance**, select **Choose a project file**.
4. Search for an image file and select it.

T3 Code supports SVG, PNG, ICO, JPEG, GIF, AVIF, and WebP files. The selected path applies to
each checkout in the project group and appears on your connected clients.

To use automatic detection again, select **Automatic**.

## Use global project actions

Global actions are available in every project connected to the same T3 Code environment.

1. Open **Settings** and select **General**.
2. Under **Global actions**, add the action name and command.
3. Enable **Run when a worktree is created** if the action prepares new worktrees.

A project action takes precedence when its ID, command, or name matches an inherited action. To
customize an inherited action for one checkout, open the project's settings and select
**Customize**. You can also disable an inherited action for one checkout and enable it again later.

Actions declared in `t3.json` run directly from the action menu without being imported. Effective
actions resolve in this order: project actions, `t3.json` actions, then global actions. Disabling an
inherited action hides either a `t3.json` or global action; project actions are never disabled by
that setting.
