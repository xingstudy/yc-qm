# Browse provider: local (Chromium in your own sandbox)

No API key, no keychain service, no remote account — the browser is the `chromium` binary
already on your computer, launched headless and driven over its own CDP port. Everything
stays on this machine: no third party sees the pages you visit or the data you enter.
The trade-offs against a hosted stealth provider: no stealth fingerprinting (bot walls
that block datacenter browsers may block this one), no live-view link, and no managed
sign-in flow. There is no profile credential either — the profile is a directory on
disk, so the shared keychain profile snippets in SKILL.md don't apply here; skip them
entirely. The sections below own the whole flow.

## Profiles

The profile is a Chromium `--user-data-dir` in your home, which is a durable per-scope
volume — sign-ins saved there survive across runs and redeploys. In a DM use the durable
dir; in a channel or group use a throwaway one (the DM-only rule, unchanged):

```bash
PROFILE_DIR="$HOME/.browse/profile"   # DM
PROFILE_DIR="$(mktemp -d /tmp/browse-profile.XXXXXX)"   # channel or group
```

Chromium locks its profile dir, so only one browser per profile at a time — the create
step below kills any previous launch first, which also means two concurrent browse runs
in the same DM scope will steal the browser from each other. Run one at a time.

## Create the browser

```bash
mkdir -p "$PROFILE_DIR"
[ -f /tmp/chromium.pid ] && kill "$(cat /tmp/chromium.pid)" 2>/dev/null; sleep 1
nohup chromium --headless=new --no-sandbox --disable-dev-shm-usage \
  --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1 \
  --user-data-dir="$PROFILE_DIR" about:blank >/tmp/chromium.log 2>&1 &
echo $! > /tmp/chromium.pid
for i in $(seq 1 50); do
  curl -fsS http://127.0.0.1:9222/json/version -o /tmp/cdp.json 2>/dev/null && break
  sleep 0.2
done
CDP_URL=$(python3 -c "import json;print(json.load(open('/tmp/cdp.json'))['webSocketDebuggerUrl'])")
LIVE_VIEW=""
```

If the loop never produces `/tmp/cdp.json`, read `/tmp/chromium.log` — a crash at launch
shows up there immediately. `--no-sandbox` is required because chromium refuses to run
as root without it; the container remains the security boundary. `CDP_URL` is
loopback-only and carries no credential, but
treat it the same as the shared flow says: runner argument, never chat.

The browser shares your computer's network: it can reach the public internet and, unlike
a hosted provider's browser, anything your computer reaches — host services included, via
`host.docker.internal`.

## Giving the browser a file

The browser runs on your own computer, so no upload step exists — name the workspace path
directly in the task and pass it via `BROWSE_FILES` per SKILL.md.

## Routing a sign-in wall

There is no live view to hand over and no managed-auth flow — when the runner reports
`SIGNIN_NEEDED`, say so plainly: the site needs an interactive sign-in this local browser
can't accept. Two ways forward, both the person's choice:

- If they already signed in to the site in an earlier run in this DM, the session is in
  the durable profile — relaunch and retry before declaring the wall.
- Otherwise the task can't proceed past the wall here. Never work around it by asking for
  their password in chat or feeding credentials to the runner — the runner's guard
  against handling sign-ins holds in local mode too.

## Clean up

```bash
kill "$(cat /tmp/chromium.pid)" 2>/dev/null; rm -f /tmp/chromium.pid
```

In a channel or group also remove the throwaway profile dir (`rm -rf "$PROFILE_DIR"`).
In a DM, leave the durable profile dir in place — it IS the person's signed-in state.
