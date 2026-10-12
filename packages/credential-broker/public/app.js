const fragment = new URLSearchParams(location.hash.slice(1));
const suppliedToken = fragment.get("token");
if (suppliedToken) sessionStorage.setItem("credential-broker-operator", suppliedToken);
history.replaceState(null, "", location.pathname);
const token = sessionStorage.getItem("credential-broker-operator");
// Reopening a rotated approval URL in this tab must replace its old session.
window.addEventListener("hashchange", () => {
  if (new URLSearchParams(location.hash.slice(1)).has("token")) location.reload();
});
const $ = (id) => document.getElementById(id);
let currentId;
let state;
let deciding = false;
let polling = false;
const dismissed = new Set();

async function api(path, method = "GET", data = {}) {
  const res = await fetch(path, {
    method,
    headers: {
      Authorization: `Bearer ${token ?? ""}`,
      ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
    },
    ...(method === "POST" ? { body: JSON.stringify(data) } : {}),
  });
  const value = await res.json();
  if (!res.ok) throw new Error(value.error ?? "Broker request failed.");
  return value;
}
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function review(request) {
  if (deciding) return;
  currentId = request.request_id;
  $("approval-title").textContent =
    request.kind === "exec"
      ? "Allow this command to use a credential?"
      : "Allow a temporary credential file?";
  $("approve").textContent = request.kind === "exec" ? "Approve & run" : "Approve file";
  $("always").hidden = request.kind !== "exec";
  $("decision-error").textContent = "";
  const details = $("approval-details");
  details.replaceChildren();
  for (const [label, value] of [
    [
      "Operation",
      request.kind === "exec" ? "Run a command · output discarded" : "Create a file lease",
    ],
    ["Client claim", request.client],
    ["Item label claim", request.label],
    ["Site requested", request.site ?? "Direct item request"],
    ["Vault item ID", request.item_id ?? "Choose a matching login below"],
    ["Field", request.field],
    ["Purpose claim", request.reason],
    ["File lifetime", `${request.ttl_seconds} seconds after delivery`],
    ...(request.kind === "exec"
      ? [
          ["Executable", request.argv[0]],
          ["Arguments (JSON)", JSON.stringify(request.argv.slice(1))],
          ["Working directory", request.cwd],
          ["File path variable", request.file_env],
        ]
      : []),
  ])
    details.append(element("dt", label), element("dd", value));
  if (request.candidates) {
    const label = element("label", "Vault login to approve");
    label.htmlFor = "login-choice";
    const select = element("select");
    select.id = "login-choice";
    select.required = true;
    if (request.candidates.length > 1) {
      const prompt = element("option", "Choose a login…");
      prompt.value = "";
      select.append(prompt);
    }
    for (const candidate of request.candidates) {
      const option = element(
        "option",
        `${candidate.name} · ${candidate.hosts.join(", ")} · ${candidate.item_id}`,
      );
      option.value = candidate.item_id;
      select.append(option);
    }
    details.append(element("dt"), element("dd"));
    details.lastChild.append(label, select);
  }
  if (!$("approval").open) $("approval").showModal();
}
function render() {
  const pending = state.requests.filter((r) => r.state === "pending");
  const active = state.requests.filter((r) => ["active", "running"].includes(r.state));
  $("mode").textContent =
    state.mode === "demo" ? "DEMO · fake credentials" : "BITWARDEN · live vault";
  $("pending-count").textContent = pending.length;
  $("active-count").textContent = active.length;
  $("review-next").hidden = pending.length === 0;
  if (!state.requests.length) {
    const empty = element("div", undefined, "empty");
    empty.append(
      element("h3", "No requests yet"),
      element("p", "Keep this page open. Incoming requests appear in an approval modal."),
    );
    $("requests").replaceChildren(empty);
  } else {
    $("requests").replaceChildren(
      ...state.requests.map((request) => {
        const card = element("article", undefined, "request");
        const top = element("div", undefined, "request-top");
        top.append(
          element("h3", request.label),
          element("span", request.state, `state ${request.state}`),
        );
        card.append(
          top,
          element("p", `${request.client} · ${request.field} · ${request.ttl_seconds}s lease`),
          element("p", request.reason),
        );
        if (request.kind === "exec") {
          card.append(
            element("code", JSON.stringify(request.argv)),
            element(
              "p",
              `${request.cwd} · credential path in ${request.file_env} · output discarded`,
            ),
          );
          if (request.exit_code !== undefined)
            card.append(
              element(
                "p",
                `Exit code: ${request.exit_code ?? "none"}${request.signal ? ` · ${request.signal}` : ""}`,
              ),
            );
        }
        if (request.path)
          card.append(
            element("code", request.path),
            element(
              "p",
              `Expires ${new Date(request.expires_at).toLocaleTimeString()} · ${Math.max(0, Math.ceil((request.expires_at - Date.now()) / 1000))}s remaining`,
            ),
          );
        if (request.error) card.append(element("p", request.error));
        if (["pending", "active", "running"].includes(request.state)) {
          const button = element(
            "button",
            request.state === "pending"
              ? "Review request"
              : request.kind === "exec"
                ? "Stop command"
                : "Release file",
            "secondary",
          );
          button.addEventListener("click", async () => {
            if (request.state === "pending") review(request);
            else {
              button.disabled = true;
              try {
                await api(`/api/requests/${request.request_id}/release`, "POST");
                await refresh();
              } catch (error) {
                $("connection").textContent = error.message;
                button.disabled = false;
              }
            }
          });
          card.append(button);
        }
        return card;
      }),
    );
  }
  if (currentId && !pending.some((r) => r.request_id === currentId) && !deciding) {
    $("approval").close();
    currentId = undefined;
  }
  if (!$("approval").open && !deciding) {
    const next = pending.find((r) => !dismissed.has(r.request_id));
    if (next) review(next);
  }
}
async function refresh() {
  if (polling) return;
  polling = true;
  try {
    state = await api("/api/state");
    $("connection").textContent = "Connected · approval required for every file";
    render();
  } catch (error) {
    $("connection").textContent =
      `${error.message} Open the private approval link from the human terminal.`;
  } finally {
    polling = false;
  }
}
async function decide(action, always = false) {
  if (deciding || !currentId) return;
  deciding = true;
  $("approve").disabled = $("deny").disabled = $("always").disabled = true;
  try {
    const selection = $("login-choice")?.value;
    const result = await api(`/api/requests/${currentId}/${action}`, "POST", {
      ...(action === "approve" && selection ? { item_id: selection } : {}),
      ...(always ? { always: true } : {}),
    });
    if (result.state === "failed") $("connection").textContent = result.error;
    $("approval").close();
    currentId = undefined;
  } catch (error) {
    $("decision-error").textContent = error.message;
  } finally {
    deciding = false;
    $("approve").disabled = $("deny").disabled = $("always").disabled = false;
    await refresh();
  }
}
$("approval-form").addEventListener("submit", (event) => {
  event.preventDefault();
  decide("approve");
});
$("deny").addEventListener("click", () => decide("deny"));
$("always").addEventListener("click", () => decide("approve", true));
$("approval").addEventListener("cancel", (event) => {
  if (deciding) {
    event.preventDefault();
    return;
  }
  dismissed.add(currentId);
  currentId = undefined;
});
$("review-next").addEventListener("click", () => {
  const request = state?.requests.find((r) => r.state === "pending");
  if (request) review(request);
});
refresh();
setInterval(refresh, 750);
