# Connect local Pi installations to Viking

The portal is live at **https://viking.metabolomics.us**. Sign in with your
existing BinView/scheduler account. Create one access key per device. Choose
Read and write and either a dated expiry or **Never expires**. Non-expiring
keys work until revoked. Save the secret when shown; it cannot be displayed
again. Existing keys are not converted when this option is added.

## This workstation

Inspection found Pi 0.85.1, one global profile, and the local package
`/home/wohlgemuth/IdeaProjects/pi-engineering-runtime` already registered.
Its current code supports the portal API and environment/token-file settings.
**No Pi binary upgrade or switch to the portal worktree is needed.**

On 2026-09-14, this workstation was configured at the operator's request:
`~/.config/pi/viking-env.sh` is sourced by `.bashrc`, `.profile` and the existing
`.zshrc`; `~/.config/environment.d/60-viking-pi.conf` covers user services.
The current user service manager and all three existing tmux sessions also have
the environment for future processes/panes. The key file was created empty with
mode 600 for the operator to fill. The shared fragment sets enabled to 1 and clears
the direct-token override. Existing processes must be restarted after saving the
key. Shell backups are under `~/.config/pi/backups/`.

Save the key without putting it in command history (Bash):

```bash
install -d -m 700 "$HOME/.config/pi"
read -rsp 'Paste Viking access key: ' VIKING_DEVICE_KEY
echo
(umask 077; printf '%s\n' "$VIKING_DEVICE_KEY" > "$HOME/.config/pi/viking.key")
unset VIKING_DEVICE_KEY
```

This intentionally replaces the key file if it already exists. Add the
following to the shell startup file used to launch Pi, and apply it to the
current terminal as well:

```bash
unset PI_OPENVIKING_TOKEN PI_OPENVIKING_ENABLED
export PI_OPENVIKING_BASE_URL=https://viking.metabolomics.us
export PI_OPENVIKING_TOKEN_FILE="$HOME/.config/pi/viking.key"
```

The direct token variable overrides the token file. The enabled variable can
disable the integration, so remove stale overrides. Never put the secret itself
in shell startup files. GUI, tmux, service and remote launchers need the same
environment; shell startup changes do not update already-running processes.
Start fresh Pi sessions after configuration or rotation.

## Other devices and profiles

Use `pi list` to inspect installed packages. If the engineering package is absent:

```bash
pi install git:github.com/berlinguyinca/pi-engineering-runtime
```

For an existing git-installed package, use the exact source shown by `pi list`:

```bash
pi update --extension git:github.com/berlinguyinca/pi-engineering-runtime
```

Plain `pi update` updates Pi itself; `pi update --extensions` updates installed
packages. Local-path packages use the checkout's files directly: update that
checkout with its normal reviewed Git workflow. Custom `PI_CODING_AGENT_DIR`
profiles need their own package registration. Multiple Pi sessions sharing one
profile and launcher environment need only one installation and configuration.
Repeat key creation/configuration on each device so one device can be revoked
without affecting the others.

## Verify the connection

This prints only the response status and record count, never the key or memories:

```bash
python3 - <<'PY'
import json, os, urllib.request
from pathlib import Path

key = Path(os.environ['PI_OPENVIKING_TOKEN_FILE']).read_text().strip()
request = urllib.request.Request(
    os.environ['PI_OPENVIKING_BASE_URL'].rstrip('/') + '/memory',
    headers={'Authorization': 'Bearer ' + key},
)
with urllib.request.urlopen(request, timeout=30) as response:
    records = json.load(response)
    if not isinstance(records, list):
        raise SystemExit('Unexpected response')
    print(f'Authentication OK: HTTP {response.status}; {len(records)} private memories')
PY
```

Then start Pi and run `/blackhole --dashboard`. Zero records is normal for a
new private account. The dashboard alone cannot prove authentication: the
current provider degrades failed recall to an empty array. The standalone
`pi-engineering blackhole status` CLI does not consume the connection environment
and should not be used as a remote-authentication test.

## Current behavior

This integration recalls durable memory for **engineering scout, planner and
implementer workers**. Independent reviewers/challengers do not inherit it.
Ordinary Pi chat does not automatically recall or upload conversations.
Completed worker observations remain session memory until explicitly promoted
through the evidence-gated runtime API; the extension currently exposes no
memory-save command. Configuring an endpoint alone does not create new memories.

Legacy shared records remain available to old clients with the old shared key.
Personal keys see only that user's private space. Shared project memory and
ordinary-chat capture are separate features, not silently enabled by setup.
