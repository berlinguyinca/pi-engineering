const $ = (id) => document.getElementById(id);
let session;
const message = (text) => {
  $("message").textContent = text;
};
async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(session ? { "x-csrf-token": session.csrfToken } : {}),
      ...options.headers,
    },
  });
  if (response.status === 401) {
    session = undefined;
    $("workspace").hidden = true;
    $("welcome").hidden = false;
    $("logout").hidden = true;
    $("identity").textContent = "";
    $("key-secret").value = "";
    $("new-key").hidden = true;
    throw new Error("Please sign in to continue.");
  }
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || "Request failed. Please try again.");
  }
  return response.status === 204 ? null : response.json();
}
function cell(row, text) {
  const td = document.createElement("td");
  td.textContent = text;
  row.append(td);
  return td;
}
const date = (value) => (value ? new Date(value).toLocaleDateString() : "Never");
async function loadKeys() {
  const keys = await api("/api/keys");
  $("keys").replaceChildren();
  for (const key of keys) {
    const row = document.createElement("tr");
    cell(row, key.name);
    cell(row, key.scopes.join(", "));
    cell(row, date(key.expiresAt));
    cell(row, date(key.lastUsedAt));
    const action = cell(row, "");
    if (key.revokedAt) action.textContent = "Revoked";
    else {
      const button = document.createElement("button");
      button.className = "secondary";
      button.textContent = "Revoke";
      button.setAttribute("aria-label", `Revoke ${key.name}`);
      button.onclick = async () => {
        button.disabled = true;
        try {
          await api(`/api/keys/${encodeURIComponent(key.id)}`, { method: "DELETE" });
          message(`Revoked ${key.name}.`);
          await loadKeys();
        } catch (error) {
          message(error.message);
          button.disabled = false;
        }
      };
      action.append(button);
    }
    $("keys").append(row);
  }
  if (!keys.length) {
    const row = document.createElement("tr");
    cell(row, "No access keys yet.").colSpan = 5;
    $("keys").append(row);
  }
}
async function loadMemories() {
  const query = $("query").value.trim();
  const records = await api(query ? `/memory/search?q=${encodeURIComponent(query)}` : "/memory");
  $("memory-count").textContent = `${records.length} ${records.length === 1 ? "memory" : "memories"}`;
  $("memories").replaceChildren();
  for (const record of records) {
    const item = document.createElement("article");
    item.className = "memory";
    const heading = document.createElement("strong");
    heading.textContent = record.id;
    const text = document.createElement("p");
    text.textContent = record.text;
    const source = document.createElement("small");
    source.textContent = (record.sourceRefs || []).join(" · ");
    item.append(heading, text, source);
    $("memories").append(item);
  }
  if (!records.length) {
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = query
      ? "No memories match your search."
      : "No private memories yet. Connect Pi with an access key to start.";
    $("memories").append(p);
  }
}
$("search-form").onsubmit = async (event) => {
  event.preventDefault();
  try {
    await loadMemories();
    message("");
  } catch (error) {
    message(error.message);
  }
};
$("key-form").onsubmit = async (event) => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  try {
    const values = new FormData(event.target);
    const scopes = values.get("permissions") === "read" ? ["memory:read"] : ["memory:read", "memory:write"];
    const key = await api("/api/keys", {
      method: "POST",
      body: JSON.stringify({ name: values.get("name"), scopes, expiresInDays: Number(values.get("expiresInDays")) }),
    });
    $("key-secret").value = key.secret;
    $("new-key").hidden = false;
    $("pi-config").textContent =
      `export PI_OPENVIKING_BASE_URL='${session.baseUrl}'\nexport PI_OPENVIKING_TOKEN_FILE="$HOME/.config/pi/viking.key"\n# Save your key in that file and set its permissions:\nchmod 600 "$HOME/.config/pi/viking.key"`;
    $("key-secret").focus();
    await loadKeys();
    message("Access key created. Save the secret before leaving this page.");
  } catch (error) {
    message(error.message);
  } finally {
    button.disabled = false;
  }
};
$("copy-key").onclick = async () => {
  try {
    await navigator.clipboard.writeText($("key-secret").value);
    message("Key copied. Store it securely.");
  } catch {
    message("Copy unavailable. Select and copy the key manually.");
  }
};
$("dismiss-key").onclick = () => {
  $("key-secret").value = "";
  $("new-key").hidden = true;
  message("");
};
$("logout").onclick = async () => {
  try {
    await api("/auth/logout", { method: "POST" });
    location.assign("/");
  } catch (error) {
    message(error.message);
  }
};
(async () => {
  try {
    session = await api("/api/me");
    $("welcome").hidden = true;
    $("workspace").hidden = false;
    $("logout").hidden = false;
    $("identity").textContent = session.email;
    await Promise.all([loadKeys(), loadMemories()]);
  } catch (error) {
    if (session) message(error.message);
  }
})();
