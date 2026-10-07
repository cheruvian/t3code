# Settings and project overrides

On web and desktop, the "Applying settings for …" sentence at the top of Settings pages picks
the project and environment a change applies to. Pages that only hold device preferences, such as
Appearance, don't show it. They start at **All projects** and **All environments**
and stay selected as you move between categories or search for a setting.

Preferences saved on this device, such as appearance, confirmations and browser profiles, always
show and ignore the selection. Everything else is stored on a server. Choose one environment to
edit its settings, or leave **All environments** to edit every connected environment at once.
Offline environments keep their current values; this is a bulk edit, not a synced global default.

Choose a project to override settings for it on the selected environments. A layers icon beside
each server row's title shows where the value comes from: the built-in default, the environment,
or a project override. Click it to see that chain on every selected environment. An override can
be reset to inherit again. Settings that cannot be overridden by a project are shown read-only
while a project is selected.

When the selected environments disagree, the control shows **Mixed** in place of a value and the
layers icon turns amber. Picking a value applies it to every selected environment.

Changing an environment value never touches a project's own override. When projects override the
setting you are editing, the layers icon counts them and the chain lists each one with its value:
click a project to jump to it, or **Reset all** to make those projects follow the environment
again.

Providers and diagnostics are per machine: they show one environment at a time, the primary
one until you pick another. Every other setting fans out to the selection.

On mobile, open **Settings** and use the filter in its header to choose connected environments
and a project. The filter stays available in server-setting pages. With **All projects** selected,
the **Server settings** categories and auto-settle controls in **Thread behavior** edit the
selected environments' defaults. Choosing a project edits its overrides on the selected
environments. Use **Use defaults** in a page to remove that page's project overrides.
Open **Settings → Projects & threads → Overview** to rename the project across its selected
connected checkouts and see where those checkouts live.
Settings that are environment-wide stay read-only while a project is selected. When selected
targets disagree, a control shows **Mixed** until you choose one value. Appearance, keyboard,
and other phone-only settings ignore the filter.

## Worktree branch names

In **Settings → Source Control → Worktree branch naming**, choose a static prefix,
a model-selected semantic prefix such as `feat/` or `fix/`, or custom instructions
for the complete name. The static prefix defaults to `t3/`; a trailing slash is
optional, and an empty prefix adds nothing. Invalid characters in a static prefix
are replaced with hyphens. Custom instructions are appended to
the naming prompt and can specify issue IDs, namespaces, and casing.

These settings apply to automatically named new worktree branches. Select a project
to override its environment defaults. Worktree directories keep their original names.
If generation fails, or a custom name is invalid or already taken, the temporary
branch name remains.

## Scheduled tasks on mobile

Open **Settings → Scheduled tasks** to create recurring tasks or manage existing
ones across your connected environments. Use the settings filter to narrow the
list by environment or project. Each task runs on the environment you choose,
using its project, model, and workspace settings. Fixed-time schedules use that
environment's time zone, which may differ from your phone's.

You can edit, pause, resume, run immediately, or delete a task from the list.
Webhook tasks only run when their URL is called, so they can't be run
immediately.
Leaving an edited form asks before discarding unsaved changes.

## Webhook automations

In **Settings → Scheduled tasks**, choose **On webhook**
as a task's schedule to run it whenever another service calls its URL, such as
GitHub on a new pull request or a CI job that failed. A public URL needs a
[T3 Connect](remote-access.md) managed tunnel; after you save the task, copy
its URL from the editor. Without one, the editor shows only the URL's path.
**Rotate** replaces the URL and the old one stops working.

The prompt decides what the agent sees. Placeholders pull values out of the
request: `{{body.path}}` for a JSON or form field, `{{headers.name}}`,
`{{query.name}}`, `{{body}}` for the raw body, and `{{request}}` for everything.
For example, `Review this PR: {{body.pull_request.html_url}}` sends only the
pull request link. A placeholder with no value is left empty.

For GitHub, turn on **Require signature**, keep the header
`x-hub-signature-256`, hex encoding and the `sha256=` prefix, and enter the
same secret in the repository's webhook settings with content type
`application/json`. Requests without a valid signature are rejected. Set this
up on desktop or web; mobile keeps an existing signature check but can't turn
one on.

On desktop and web, pick **Deliveries** from a task's menu to see recent
requests and the prompt each one produced.

If the environment is offline, the sender gets an error and nothing runs;
redeliver from the sender, such as GitHub's **Recent Deliveries**, once it is
back. To have T3 Connect keep requests instead, turn on **Hold webhooks while
offline** in **Settings → Connections**. T3 Connect then stores requests to a
T3 Connect URL for up to 24 hours and delivers them when the environment
returns. Leave it off if you don't want request bodies stored outside your
machine. To skip requests that waited too long, set **Skip requests older
than** on the task.

## Defaults and inheritance

General contains the model and workspace for new threads. Integrations controls agent browser
access. Source Control contains automatic pull, the default pull request merge method and text
generation. The same rows edit environment defaults or project overrides depending on the
project crumb.

The Project category, shown while a project is selected, holds the project's name, icon, actions,
checkouts and removal. Actions belong to a project: editing them creates the project's own list
on each selected environment, and reset returns to the environment's shared list. A project's
`t3.json` actions can be imported there.

Settings a repository can also declare in `t3.json`, such as the workspace for new threads,
resolve in one order: a project override, then the environment setting, then `t3.json`, then the
built-in default. Leave a setting on **Inherit** to let the next tier decide.
Browser access changes apply when an agent session next starts.

New worktrees initialize git submodules recursively. If that step is slow because the repository
declares many nested submodules, set **Submodules** in **Settings → General** (with the project
selected to override it there) to **Top level only** to stop at the ones the repository declares
itself, or **Skip** to leave them for a setup script. It resolves in the same order as the
workspace default: a `"worktreeSubmodules"` value in the `t3.json` of the branch being checked out
applies when the project and environment are both on **Inherit**.

## Worktree location

New worktrees go in the `worktrees` folder of the T3 home directory. To put them somewhere else,
such as another drive, set **Settings → Storage → Worktree location** to an absolute path like
`D:\worktrees` or `~/worktrees`. The setting is per machine. Existing worktrees stay where they
are, and cleanup covers both the default folder and the custom one.

## Storage cleanup

Open **Settings → Storage** to enable automatic cleanup on one machine or all connected
environments. Policies are off by default and run on the server at startup, when changed, and
hourly. Offline machines keep their existing policies.

Select a project to set **Automatic worktree cleanup** to **Inherit**, **Off**, or **Custom**.
Inherit follows each machine's rules; Off keeps that project's worktrees until you remove them
manually. Custom applies separate worktree rules to the selected project or checkout. Browser
captures and log retention remain machine-wide.

Worktrees can be removed after a chosen number of inactive days, when a merged pull request's
commits are on the remote default branch, when all commits are on that branch without a pull
request, or when all commits are backed up on the worktree branch's remote. Only T3-managed
worktrees are eligible. Active
sessions, shared worktrees, uncommitted changes, and ignored files other than `node_modules`
prevent removal. Branches and thread history stay; starting another turn recreates the checkout.
Merge cleanup requires a merged pull request whose commits are included in the remote default
branch. A squash or rebase merge on GitHub also counts when the pull request targeted the default
branch and the worktree is still at the pull request's last commit.

To clean up now, open **Settings → Storage → Review worktrees**. **Remove all settled worktrees
pushed to default branch** checks the remote default branch. **Remove all settled worktrees pushed
to any remote branch** checks the branch's upstream, or its same-name branch on the primary remote.
It can remove an unmerged checkout after all its commits are backed up remotely. Both actions
check local changes and live sessions before removing a checkout, regardless of the automatic
policy. Expand a worktree's changed files to review local work, or select **Open conversation** to
return to its thread.

When you settle a conversation with local changes, review the file list and line summary in the
confirmation. Choose **Settle and keep worktree** to preserve them. To remove the checkout,
including untracked and ignored files, choose **Delete worktree and discard local changes**.
Closing the dialog cancels settlement.

Enable **Delete worktrees with deleted threads** to remove safe worktrees after their last
thread is deleted, including archived threads and worktrees left by earlier deletions. The
server waits for sessions and terminals to stop and retries skipped worktrees after restart.
Existing prompts for deleting a worktree manually remain available when this policy is off.

Browser captures and rotated logs have separate retention periods. Expired capture links stop
working. Current logs, message attachments, and browser profiles are kept.

## Project icons

Select the project and open Project to choose an icon, emoji, monogram, or image. The choice applies to
every checkout in the project group and appears on connected clients. Choose **Automatic** to let
T3 Code detect an icon again.

Choose **Monogram** in the icon picker to set one or two letters or numbers and a color.

When no image is found, web and desktop show a two-character monogram with a color
from the icon palette, derived from the saved project name. For example, `Nebula` becomes `NA`,
`Silver Orchard` becomes `SO`, and `M7 Forge` becomes `M7`.

## Keep the default branch current

In Source Control, enable **Automatically pull** to keep the default-branch checkout up to date
with its configured upstream. Choose an environment to set the default or a project to override it.
On mobile, use **Settings → Source control** to change selected environment defaults or project overrides.

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

## Reserve a resource for a thread

On web or desktop, select a project in Settings, open its Actions, and add a
**Resource action** for a device, port, staging environment, or other named resource.
Choose a color and optional checkout and release scripts and agent prompts.
Scripts run on the project's server in the thread's workspace, followed by the
prompt in that thread. Resource scripts have no automatic timeout. Use **Abort**
while checkout or release is running to stop the local process or interrupt its
agent prompt. An aborted action keeps its reservation; release it explicitly
when ready. Stopping a deployment command does not undo work already started in
an external service.

To share a resource action through Git, add its `resource` hooks to a script in
`t3.json`. Use empty strings for hooks you don't need:

```json
{
  "scripts": [
    {
      "name": "SANDBOX",
      "command": "bash scripts/deploy-slownet.sh",
      "resource": {
        "color": "#3b82f6",
        "checkoutPrompt": "",
        "releaseCommand": "",
        "releasePrompt": ""
      }
    }
  ]
}
```

The action appears when each environment pulls the file; no import is required.
A saved project action with the same name or command takes precedence, so remove
that override to use the file's definition. Definitions are shared through Git,
but each environment stores its own reservations.

Run the action from a thread to check out the resource. Only one thread in that
project on that server can hold it at a time. The thread shows a colored indicator
and a Release control; mobile can check out and release configured resources too.
A release finishes automatically after its script and prompt complete. Resource
colors also mark the owning thread in the thread list, including compact rows.

Open **Resource logs** in the thread to see checkout and release results, commands,
and output. Output updates about once a second while the action runs and remains available after
release. Each output stream keeps its latest 16 KiB; longer output is marked as
truncated. **Checking out** means the hooks are still running, **Checked out** means
they succeeded, and **Failed** means the reservation needs attention.

To move a reservation to another thread, run **Take over** there and confirm the
current session name. This runs checkout hooks in the new thread without running
the previous thread’s release hooks. Wait for any running resource hooks to finish
before taking over.

Connected environments with checkouts in the same project
group also show each other's reservations for actions with the same ID. The
action menu names the owning thread and environment. Taking over there clears
the other environment's reservation before checking out locally. This relies
on connected clients seeing current lock state; simultaneous checkouts and
disconnected environments can still conflict.

Failed hooks keep the resource reserved. Retry Release, or use Force release to
clear ownership without running cleanup. Restarting the server preserves ownership;
interrupted hooks are marked failed instead of being run again. Release resources
before archiving or deleting their thread. Project Actions also shows held resources,
even when their action definition has been changed or removed.
