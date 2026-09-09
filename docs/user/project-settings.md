# Project settings

Open **Settings → Projects**. The project and machine pickers start at **All projects** and
**All machines**.

Change the default model, workspace, automatic pull, agent browser access, or actions for projects that inherit those values.
Select an individual project to override a default. Reset its row to inherit again. Changing a
default preserves explicit project overrides. Workspace preferences in `t3.json` take precedence
over machine defaults when the project has no explicit workspace override.

Select a machine to limit edits to it. **All machines** writes defaults to connected machines;
offline machines keep their previous values. Mixed values are indicated when selected machines
or checkouts disagree. Browser access changes apply when an agent session next starts.

Project grouping has a client-wide default across machines, with individual checkout overrides.
Shared actions apply to inheriting projects; editing a project's actions creates an independent list.
Reset that list to use shared actions again. Existing project actions are preserved.

Project names, icons, removal, and importing actions from a checkout remain project-specific.
When there are several checkouts, the checkout picker selects which actions and grouping to edit.

## Project icons

Choose an icon, emoji, or image from the project to make it easier to recognize. The choice applies
to selected checkouts in the project group and appears on connected clients. Choose **Automatic** to
let T3 Code detect an icon again.

## Keep the default branch current

Enable **Automatically pull** to keep the default-branch checkout up to date with its configured
upstream.

T3 Code only pulls when it can fast-forward and the checkout has no changed files, untracked files,
or local commits. It skips checkouts on another branch or without an upstream. If a checkout has
local work, resolve it yourself before automatic pulls can resume.

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
