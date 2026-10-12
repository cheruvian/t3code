const api = window.brokerDesktop;
const root = document.getElementById("app");
let model, timer, selection;
const text = (value) => String(value ?? "");
// All request/provider metadata is untrusted text, never markup.
function element(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = text(content);
  return node;
}
function append(parent, ...nodes) {
  parent.append(...nodes);
  return parent;
}
function button(label, action, value, className = "") {
  const node = element("button", className, label);
  node.type = "button";
  node.onclick = async () => {
    node.disabled = true;
    try {
      await api.act(action, typeof value === "function" ? value() : value);
    } catch {
      showError("This action is no longer available. Check the current request.");
      node.disabled = false;
    }
  };
  return node;
}
function showError(message) {
  let error = root.querySelector(".error");
  if (!error) {
    error = element("div", "error");
    error.setAttribute("role", "alert");
    root.querySelector(".content")?.append(error);
  }
  error.textContent = message;
}
function brand() {
  return append(
    element("div", "brand"),
    element("div", "brand-icon", "◇"),
    append(
      element("div"),
      element("div", "brand-name", "Credential Broker"),
      element("div", "eyebrow", "Private by permission"),
    ),
  );
}
function shell(type) {
  root.className = type;
  root.replaceChildren();
  append(root, element("div", "titlebar", "Credential Broker"));
  return append(root, element("section", "content")).lastChild;
}
function row(label, value) {
  return append(element("div", "row"), element("span", "", label), element("strong", "", value));
}
function footer() {
  return append(
    element("div", "footer"),
    element("span", "status-dot"),
    element("span", "", "Vault secrets stay out of agent output"),
  );
}
function details(request) {
  const node = element("details", "details");
  append(node, element("summary", "", "Review exact command & scope"));
  append(
    node,
    element(
      "pre",
      "",
      `Executable: ${request.argv?.[0] ?? "Separate file lease"}\nArguments: ${JSON.stringify(request.argv?.slice(1) ?? [])}\nWorking directory: ${request.cwd ?? "Consumer managed"}\nFile variable: ${request.file_env ?? "Consumer managed"}\nCaller claim: ${request.client}\nItem: ${selection ?? request.item_id ?? ""}`,
    ),
  );
  return node;
}
function approval(request) {
  const content = shell("approval");
  append(
    content,
    brand(),
    element("h1", "", "Approve login access."),
    element("p", "", "An agent wants to use a saved login. Choose what it can access."),
  );
  const card = element("div", "card");
  append(
    card,
    append(
      element("div", "site"),
      element("div", "site-icon", "↗"),
      element("div", "site-title", request.site ?? "Vault login"),
      element("span", "badge", "Approval required"),
    ),
  );
  const choices = request.candidates ?? [
    { item_id: request.item_id, name: "Selected vault login", hosts: [] },
  ];
  if (!choices.some((choice) => choice.item_id === selection)) selection = choices[0]?.item_id;
  const select = element("select");
  select.id = "login";
  for (const choice of choices) {
    const option = element(
      "option",
      "",
      `${choice.name}${choice.hosts?.length ? " · " + choice.hosts.join(", ") : ""}`,
    );
    option.value = choice.item_id;
    option.selected = choice.item_id === selection;
    select.append(option);
  }
  const label = element("label", "label", "SAVED LOGIN");
  label.htmlFor = "login";
  select.onchange = () => {
    selection = select.value;
    const current = content.querySelector("details");
    current?.replaceWith(details(request));
  };
  append(
    card,
    label,
    select,
    row("Requested fields", request.field === "login" ? "Username + password" : request.field),
    row("Access lifetime", `${request.ttl_seconds} seconds`),
    row("Program", request.argv?.[0]?.split("/").at(-1) ?? "Separate file lease"),
    element("div", "divider"),
    element("div", "eyebrow", "Requested purpose · caller supplied"),
    element("div", "purpose", request.reason),
  );
  append(
    content,
    card,
    details(request),
    element(
      "div",
      "hint",
      request.kind === "exec"
        ? "Always allow remembers this login and exact command. Every automatic use shows a notice with a revoke button."
        : "This file lease is unsupervised. Release it immediately after use. Copies cannot be revoked.",
    ),
  );
  const actions = element("div", "actions");
  append(
    actions,
    button("Deny", "deny", undefined, "ghost"),
    button("Allow once", "once", () => selection, request.kind === "exec" ? "" : "primary"),
  );
  if (request.kind === "exec")
    actions.append(button("Always allow", "always", () => selection, "primary"));
  append(content, actions, footer());
}
function unlock() {
  const content = shell("unlock");
  append(
    content,
    brand(),
    element("h1", "", "Your vault.\nYour permission."),
    element("p", "", "Unlock Bitwarden privately to let approved commands use your saved logins."),
  );
  const form = element("form");
  const input = element("input");
  input.type = "password";
  input.id = "master-password";
  input.autocomplete = "off";
  input.maxLength = 4096;
  const label = element("label", "label", "MASTER PASSWORD");
  label.htmlFor = input.id;
  const cancel = button("Cancel", "deny", undefined, "ghost");
  const submit = element("button", "primary", "Unlock vault");
  submit.type = "submit";
  form.onsubmit = async (event) => {
    event.preventDefault();
    submit.disabled = true;
    let password = input.value;
    input.value = "";
    try {
      await api.act("unlock", password);
    } catch {
      showError("Unlock request expired. Please start the broker again.");
      submit.disabled = false;
    } finally {
      password = undefined;
    }
  };
  append(
    form,
    label,
    input,
    element(
      "div",
      "hint",
      "Sent only to the local Bitwarden unlock process. Never saved or returned to the agent.",
    ),
    append(element("div", "actions"), cancel, submit),
  );
  append(content, form, footer());
  input.focus();
}
function notice(data) {
  root.className = `notice${data.revoked ? " revoked" : ""}`;
  root.replaceChildren();
  append(
    root,
    append(
      element("div", "notice-head"),
      element("span", "", data.revoked ? "⊘" : "◇"),
      element("span", "", data.revoked ? "Access revoked" : "Automatically approved"),
    ),
    element("h1", "", data.site),
    element(
      "p",
      "",
      data.revoked
        ? "Grant removed. Its active commands were stopped."
        : `${data.command} · ${data.label}`,
    ),
  );
  const countdown = element("span", "countdown");
  const actions = element("div", "actions");
  if (!data.revoked) actions.append(button("Revoke & stop", "revoke", undefined, "danger"));
  actions.append(button("Dismiss", "dismiss", undefined, "ghost"));
  append(root, append(element("div", "notice-bottom"), countdown, actions));
  const fill = element("div", "progress-fill");
  append(root, append(element("div", "progress"), fill));
  const tick = () => {
    const remaining = Math.max(0, Math.ceil((data.expires_at - Date.now()) / 1000));
    countdown.textContent = `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")} remaining`;
    fill.style.transform = `scaleX(${Math.min(1, remaining / 300)})`;
  };
  tick();
  timer = setInterval(tick, 250);
}
function dashboard(data) {
  const content = shell("dashboard");
  const active = data.requests.filter((r) => ["running", "active", "preparing"].includes(r.state));
  append(
    content,
    brand(),
    element("h1", "", "Access, on your terms."),
    element(
      "p",
      "",
      data.status === "ready"
        ? "Your vault is ready. Review what is running and what you have allowed."
        : "Getting the private broker ready…",
    ),
  );
  const stats = element("div", "stats");
  for (const [label, number] of [
    ["Active uses", active.length],
    ["Saved permissions", data.grants.length],
  ])
    stats.append(
      append(element("div", "stat"), element("span", "", label), element("strong", "", number)),
    );
  if (data.error) content.append(element("div", "error", data.error));
  append(
    content,
    stats,
    append(
      element("div", "section-title"),
      element("h2", "", "Active access"),
      element("span", "", "Temporary & supervised"),
    ),
  );
  if (!active.length)
    content.append(
      element(
        "div",
        "empty",
        "Nothing is using a credential right now.\nNew requests will ask for your permission.",
      ),
    );
  for (const request of active)
    content.append(
      append(
        element("div", "access"),
        append(
          element("div"),
          element("div", "name", request.site ?? request.label),
          element(
            "div",
            "meta",
            `${request.state} · ${request.auto_approved ? "Automatically approved" : "Approved once"}`,
          ),
        ),
        button("Stop", "release", request.request_id, "danger"),
      ),
    );
  append(
    content,
    append(
      element("div", "section-title"),
      element("h2", "", "Always allowed"),
      element("span", "", "Exact command scope"),
    ),
  );
  if (!data.grants.length)
    content.append(
      element(
        "div",
        "empty",
        "No standing permissions.\nAlways allow is available when you approve a command.",
      ),
    );
  for (const grant of data.grants) {
    const item = append(
      element("div", "access"),
      append(
        element("div"),
        element("div", "name", grant.scope.site ?? "Direct vault login"),
        element(
          "div",
          "meta",
          `${grant.scope.argv[0].split("/").at(-1)} · ${grant.max_ttl}s maximum · ${grant.scope.field}`,
        ),
      ),
      button("Revoke", "revoke", grant.grant_id, "danger"),
    );
    const inspect = element("details", "details");
    append(
      inspect,
      element("summary", "", "Permission details"),
      element(
        "pre",
        "",
        `Item: ${grant.item_id}\nExecutable: ${grant.scope.argv[0]}\nArguments: ${JSON.stringify(grant.scope.argv.slice(1))}\nDirectory: ${grant.scope.cwd}\nCaller claim: ${grant.scope.client}`,
      ),
    );
    append(content, item, inspect);
  }
  append(content, element("div", "hint runtime", `Agent runtime: ${data.runtime}`), footer());
}
function render(value) {
  if (model && (value.revision ?? 0) < (model.revision ?? 0)) return;
  const unchanged =
    model &&
    JSON.stringify({ ...model, revision: undefined }) ===
      JSON.stringify({ ...value, revision: undefined });
  model = value;
  if (unchanged) return;
  clearInterval(timer);
  if (model.type === "approval") approval(model.data);
  else if (model.type === "unlock") unlock();
  else if (model.type === "notice") notice(model.data);
  else dashboard(model.data);
}
api.subscribe(render);
api.model().then((value) => {
  render(value);
  requestAnimationFrame(() => requestAnimationFrame(() => api.ready()));
});
