# Standing up the self-hosted macOS runner (AGY-LLC org)

Runbook for the iOS / Maestro smoke path described in
[`centralized-ci.md` §10](./centralized-ci.md). Once a runner with the right
labels is **Idle** in the org, the `runner: [...]` field on a `smoke:` suite in
`pba.yml` resolves to a real `runs-on` target and the central `smoke.yml`
matrix job lands on your Mac.

Run everything in **Part B** on the macOS host. Parts A/C are GitHub-side.

---

## Part A — GitHub org setup (one-time, needs org admin)

**Goal: any AGY-LLC repo that adds the smoke flag to its `pba.yml` can use the
runner.** That's exactly what GitHub's built-in **Default** runner group already
provides — it grants access to *all* repositories in the org. So you do **not**
need a custom runner group; just register the runner into `Default` (Part B3).

> If you ever want to narrow it later, create a group with
> "All repositories" access (`visibility=all`) or a selected list. For
> "every repo in the org," `Default` is the simplest correct choice.

1. **(Optional) Confirm the Default group is org-wide.**
   Org → Settings → Actions → Runner groups → `Default` → Repository access
   should read **All repositories**. (It does by default.)

2. **Get a registration token** (short-lived, ~1 hour):
   ```bash
   gh api -X POST /orgs/AGY-LLC/actions/runners/registration-token --jq .token
   ```
   Copy the token; you'll paste it in Part B.

---

## Part B — On the macOS host

> **Starting from a completely blank Mac?** Do **B0** first. If the Mac already
> has Homebrew, `gh`, and full Xcode, skip to B1.

### B0. Bootstrap a blank Mac (one-time)
```bash
# 1. Full Xcode — REQUIRED for the iOS Simulator (command-line tools alone are
#    NOT enough). Install from the App Store (search "Xcode", ~7-12 GB), or:
xcode-select --install            # command-line tools (compilers, git)
# ...then install the full Xcode app from the App Store and launch it once so it
# finishes "Installing components". Then point the toolchain at it:
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
sudo xcodebuild -license accept
xcrun simctl list devices available | grep -i iphone   # must list a simulator

# 2. Homebrew (package manager — not preinstalled on macOS)
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
# Apple Silicon only: put brew on PATH for this + future shells
echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> ~/.zprofile
eval "$(/opt/homebrew/bin/brew shellenv)"

# 3. GitHub CLI (used to pin the runner version in B2)
brew install gh
gh auth login          # log in as a user with access to AGY-LLC
```

### B1. Prerequisites (toolchain the smoke suite needs)
```bash
# Node (the smoke suite uses setup: node) + Maestro (iOS UI test runner)
brew install node fastlane

# Java — REQUIRED by Maestro, which is a JVM app and needs a JDK (17+). Without
# it, `maestro test` fails with "Java runtime not found". The Temurin *cask*
# (not the keg-only `openjdk` formula) installs a real .jdk bundle into
# /Library/Java/JavaVirtualMachines, so /usr/libexec/java_home finds it with no
# symlink dance. 25 is the current release; 17 or 21 (LTS) also work.
brew install --cask temurin@25
/usr/libexec/java_home -v 25      # must print a path — proves macOS resolved it

curl -Ls https://get.maestro.mobile.dev | bash
echo 'export PATH="$HOME/.maestro/bin:$PATH"' >> ~/.zshrc && source ~/.zshrc
maestro --version                 # picks up JAVA_HOME from your login shell here
```

> **Why `--version` working in your terminal isn't enough.** The lines above
> only set up your *interactive login shell*. The runner, once installed as a
> launchd service in **B4**, does **not** source `~/.zshrc` — so jobs run with a
> bare PATH and no `JAVA_HOME`, and Maestro fails with "Java runtime not found"
> even though it works when you type `maestro` yourself. **B3.5** fixes that.

### B2. Download the runner (latest version, pinned by the API)
```bash
mkdir -p ~/actions-runner && cd ~/actions-runner
VER=$(gh api /repos/actions/runner/releases/latest --jq .tag_name | tr -d v)
# Apple Silicon: arm64. Intel Macs: replace osx-arm64 with osx-x64.
curl -Lo runner.tar.gz \
  "https://github.com/actions/runner/releases/download/v${VER}/actions-runner-osx-arm64-${VER}.tar.gz"
tar xzf runner.tar.gz && rm runner.tar.gz
```

### B3. Configure against the org + runner group, with matching labels
```bash
./config.sh \
  --url https://github.com/AGY-LLC \
  --token <PASTE_REGISTRATION_TOKEN_FROM_PART_A2> \
  --runnergroup Default \
  --labels self-hosted,macOS,ios \
  --name "$(hostname)-ios" \
  --work _work \
  --unattended
```
> The `--labels` must be a **superset** of every label your smoke suite lists.
> A suite with `runner: ["self-hosted","macOS","ios"]` requires all three here.
> (`self-hosted` is always applied automatically, but listing it is harmless.)

### B3.5. Make the toolchain visible to the service (the part everyone misses)
The launchd service started in B4 runs with a minimal environment — it ignores
`~/.zshrc`, so `JAVA_HOME` and the `maestro`/Homebrew bins from B1 won't be on
the job's PATH. The runner loads a **`.env` file in its install dir** at startup
and injects those into every job. Populate it once:

```bash
cd ~/actions-runner

# JAVA_HOME — resolved from the Temurin JDK installed in B1
echo "JAVA_HOME=$(/usr/libexec/java_home -v 25)" >> .env

# PATH — include the JDK, Maestro, and Homebrew bins. Apple Silicon brew lives
# in /opt/homebrew/bin; Intel in /usr/local/bin — keep both, harmless if absent.
echo "PATH=$(/usr/libexec/java_home -v 25)/bin:$HOME/.maestro/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" >> .env

cat .env      # sanity-check the two lines
```
> Already installed the service before adding `.env`? Reload it so the new
> environment takes effect: `./svc.sh stop && ./svc.sh start`.

### B4. Run it as a background service (survives logout/reboot)
```bash
./svc.sh install
./svc.sh start
./svc.sh status    # should show "started"
```
Run interactively instead (for a first smoke test) with `./run.sh`.

### B5. Make the Mac always-on and self-recovering
The runner only picks up jobs while the Mac is awake and the service is running.
A laptop that sleeps, or a Mac that reboots to a login screen and never logs in,
silently stops processing the queue. Lock these down:

```bash
# --- Power: never sleep while on AC; never sleep the disk ---
sudo pmset -c sleep 0 disksleep 0          # system + disk stay awake on AC power
sudo pmset -c displaysleep 10              # screen can sleep (fine); system won't
sudo pmset -c powernap 1                   # wake for background tasks

# --- Auto-recover from power loss / kernel panic ---
sudo pmset -a autorestart 1                # restart automatically after a power failure
sudo systemsetup -setRestartFreeze on      # restart automatically if the system freezes

# Verify
pmset -g custom
```

**Laptop with the lid closed (clamshell)?** macOS sleeps on lid-close unless on
AC *and* an external display/keyboard is attended — or you force it:
```bash
sudo pmset -c disablesleep 1               # prevent lid-close sleep on AC (Apple silicon/Intel)
```

**Survive a reboot unattended — enable auto-login** so the launchd service the
runner installed actually starts (a Mac sitting at the login window runs nothing):
- System Settings → **Users & Groups** → *Automatically log in as* → your user.
  (FileVault blocks auto-login; if FileVault is on, either turn it off on this
  dedicated box or accept that someone must log in after each reboot.)

**Stop unattended OS updates from rebooting mid-job:**
- System Settings → General → Software Update → Automatic Updates → turn **off**
  *Install macOS updates* (keep security responses on if you like). Patch on a
  schedule you control instead.

After a reboot, confirm the runner came back:
```bash
~/actions-runner/svc.sh status     # "started"
```

---

## Part C — Confirm GitHub sees it

Org → Settings → Actions → Runners → group `Default`: your runner should be
**Idle** with labels `self-hosted, macOS, ios`. Or:
```bash
gh api /orgs/AGY-LLC/actions/runners --jq '.runners[] | {name, status, labels: [.labels[].name]}'
```

---

## Part D — Make the pba flag actually target it

1. **Declare a smoke suite** in the app repo's `pba.yml` with labels that match
   the runner (this is the "flag" you wanted live):
   ```yaml
   smoke:
     ios-acceptance:
       runner: ["self-hosted", "macOS", "ios"]
       setup: node
       environment: staging          # binds env-scoped secrets / reviewers
       env:
         MAESTRO_FLOW_DIR: .maestro/acceptance
       run: |
         curl -Ls https://get.maestro.mobile.dev | bash
         xcrun simctl boot "iPhone 15" || true
         maestro test "$MAESTRO_FLOW_DIR"
   ```

2. **Add the thin smoke caller** in the app repo
   (`.github/workflows/smoke.yml`) — `workflow_dispatch` → the central reusable
   `smoke.yml`, with `secrets: inherit`. Example:
   ```yaml
   name: smoke
   on:
     workflow_dispatch:
       inputs:
         suite: { description: "One suite (empty = all)", type: string, default: "" }
   jobs:
     smoke:
       uses: AGY-LLC/pipelinebyalex/.github/workflows/smoke.yml@v1
       with:
         suite: ${{ inputs.suite }}
       secrets: inherit
   ```

3. **Dispatch and watch it land on the Mac:**
   ```bash
   gh workflow run smoke.yml -f suite=ios-acceptance
   gh run watch
   ```
   The `plan` job (Ubuntu) interprets `pba.yml`; the `smoke` matrix job picks up
   `runs-on: ["self-hosted","macOS","ios"]` and executes on your runner.

---

## Security (from §10)

Because the runner is in the `Default` group, **every repo in AGY-LLC** can
schedule jobs on your Mac — so the blast radius is "anyone who can edit a
workflow in any org repo." That's fine while all org repos are **private** and
trusted. Risks to keep in mind:

- Self-hosted runners on a **public** repo let fork PRs run code on your Mac. If
  any AGY-LLC repo is (or goes) public, either move the runner to a group that
  excludes it, or require approval for fork-PR workflow runs
  (Org → Settings → Actions → "Fork pull request workflows from outside
  collaborators" → *Require approval for all outside collaborators*).
- The smoke caller is `workflow_dispatch` only, so it can't be triggered by an
  untrusted fork — keep it that way.
- The Mac runs jobs as your login user with your toolchain; treat anything it
  can reach (keychain, SSH keys, local creds) as exposed to org workflow authors.

## Teardown
```bash
cd ~/actions-runner
./svc.sh stop && ./svc.sh uninstall
./config.sh remove --token $(gh api -X POST /orgs/AGY-LLC/actions/runners/remove-token --jq .token)
```
