# Adding an Android runner to the same Mac (AGY-LLC org)

Companion to [`self-hosted-runner-setup.md`](./self-hosted-runner-setup.md),
which stands up the iOS/Maestro runner. This one adds an **Android smoke path on
the same Mac**: a *second* runner instance labelled
`[self-hosted, macOS, android]` driving a **headless emulator (AVD)**.

Why a second instance rather than adding an `android` label to the existing
runner: **one runner instance runs exactly one job at a time.** Sharing the
runner means an Android smoke suite queues behind an iOS one (and vice versa).
Two instances on the same host let both land in parallel — at the cost of a
Simulator and an emulator competing for RAM, so see [§B7](#b7-resource-budget).

Parts **A** and **C** are identical to the iOS runbook (org-side registration
token, then confirming the runner is Idle) — they are summarised here, not
repeated in full.

---

## Part A — Registration token (org admin)

Registration tokens expire in ~1 hour and are **single-use per runner**, so get a
fresh one even if you registered the iOS runner earlier today:

```bash
gh api -X POST /orgs/AGY-LLC/actions/runners/registration-token --jq .token
```

The `Default` runner group already grants access to all org repos — same as the
iOS runner. Nothing else to create.

---

## Part B — On the macOS host

> Assumes the iOS runbook's **B0** (Homebrew, `gh`) and **B1** (Node, Temurin
> JDK, Maestro) are already done — Maestro and the JDK are shared by both
> platforms. Starting from a Mac that has *never* run the iOS setup? Do B0/B1
> from that doc first, skipping the Xcode/CocoaPods parts if you only want
> Android.

### B1. Install the Android SDK, emulator, and a system image

```bash
# sdkmanager + avdmanager. The cask is the headless SDK (no Android Studio).
brew install --cask android-commandlinetools

# Every later command needs this. Apple Silicon: /opt/homebrew/share/...
# Intel: /usr/local/share/... — `brew --prefix` resolves either.
export ANDROID_HOME="$(brew --prefix)/share/android-commandlinetools"
echo "export ANDROID_HOME=\"$ANDROID_HOME\"" >> ~/.zshrc
echo 'export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc

yes | sdkmanager --licenses    # must accept, or installs fail silently later

# ABI must match the HOST, not the phone you ship to: Apple Silicon needs
# arm64-v8a, an Intel Mac needs x86_64. Getting this wrong boots nothing.
ABI=$([ "$(uname -m)" = "arm64" ] && echo arm64-v8a || echo x86_64)
echo "host ABI: $ABI"

sdkmanager \
  "platform-tools" \
  "emulator" \
  "platforms;android-35" \
  "system-images;android-35;google_apis;$ABI"

adb --version && emulator -version   # both must print
```

> **`google_apis` vs `default` image.** Use `google_apis` — Play-services-backed
> images. Expo/React Native apps that touch Maps, Firebase, or push notifications
> fail or behave oddly on a `default` image. Avoid `google_apis_playstore`: those
> images are non-rootable, so `adb root` and some Maestro operations are blocked.

### B2. Create the AVD the smoke suite will boot

```bash
ABI=$([ "$(uname -m)" = "arm64" ] && echo arm64-v8a || echo x86_64)
echo no | avdmanager create avd \
  --name pba-android \
  --package "system-images;android-35;google_apis;$ABI" \
  --device pixel_7 \
  --force
```

Default AVDs are RAM- and disk-starved for a real app under Maestro. Patch the
config (this rewrites existing keys rather than appending duplicates):

```bash
AVD_CFG="$HOME/.android/avd/pba-android.avd/config.ini"
for kv in hw.ramSize=4096 vm.heapSize=576 disk.dataPartition.size=8192M hw.keyboard=yes; do
  k=${kv%%=*}
  if grep -q "^$k=" "$AVD_CFG"; then sed -i '' "s|^$k=.*|$kv|" "$AVD_CFG"
  else echo "$kv" >> "$AVD_CFG"; fi
done
grep -E 'ramSize|dataPartition|keyboard' "$AVD_CFG"   # sanity-check
```

### B3. Boot it once by hand — before any runner is involved

Do this interactively. It shakes out the two failures that are painful to debug
from a CI log: the macOS firewall prompt, and a bad GPU mode.

```bash
"$ANDROID_HOME/emulator/emulator" -avd pba-android \
  -no-window -no-audio -no-boot-anim -no-snapshot -gpu swiftshader_indirect &

adb wait-for-device
for i in $(seq 1 150); do
  [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ] && break
  sleep 2
done
adb shell input keyevent 82    # dismiss the keyguard
adb devices                    # expect: emulator-5554   device
adb emu kill
```

Two things to know:

- **Launch the emulator by its full path** (`$ANDROID_HOME/emulator/emulator`),
  never through a symlink elsewhere on `PATH`. Launched from a foreign
  directory it fails with `PANIC: Cannot find AVD system path`.
- **macOS may show a firewall prompt** ("Do you want the application
  `qemu-system-x86_64` to accept incoming network connections?"). Under a
  launchd service there is no one to click Allow and the boot hangs forever.
  Approving it once here is usually enough; to be certain (the binary is
  arch-specific — `darwin-x86_64` on Intel, `darwin-aarch64` on Apple Silicon):
  ```bash
  QEMU=$(ls "$ANDROID_HOME"/emulator/qemu/darwin-*/qemu-system-* | head -1)
  sudo /usr/libexec/ApplicationFirewall/socketfilterfw --add "$QEMU"
  sudo /usr/libexec/ApplicationFirewall/socketfilterfw --unblockapp "$QEMU"
  ```
- **`-gpu swiftshader_indirect` is deliberate.** `-gpu host` needs a window
  server the launchd service does not have; it hangs or crashes headless.
  Software rendering is slower but is the only reliable mode for a service.

### B4. Download a second runner into its own directory

```bash
mkdir -p ~/actions-runner-android && cd ~/actions-runner-android
VER=$(gh api /repos/actions/runner/releases/latest --jq .tag_name | tr -d v)
# Must match the host: osx-arm64 on Apple Silicon, osx-x64 on Intel.
RARCH=$([ "$(uname -m)" = "arm64" ] && echo osx-arm64 || echo osx-x64)
curl -Lo runner.tar.gz \
  "https://github.com/actions/runner/releases/download/v${VER}/actions-runner-${RARCH}-${VER}.tar.gz"
tar xzf runner.tar.gz && rm runner.tar.gz
```

> Its own directory is required — two runner instances cannot share an install
> dir or a `_work` dir.

### B5. Configure it with Android labels and a distinct name

```bash
./config.sh \
  --url https://github.com/AGY-LLC \
  --token <PASTE_FRESH_TOKEN_FROM_PART_A> \
  --runnergroup Default \
  --labels self-hosted,macOS,android \
  --name "$(hostname)-android" \
  --work _work \
  --unattended
```

> `--name` **must differ** from the iOS runner's (`$(hostname)-ios`). Names are
> unique per org, and the launchd service label is derived from the name — reuse
> one and you either get a registration error or clobber the iOS service.

### B6. Give the service the Android toolchain (the part everyone misses)

Same trap as the iOS runbook's B3.5: the launchd service ignores `~/.zshrc`, so
`adb`, `emulator`, and `JAVA_HOME` are invisible to jobs even though they work in
your terminal. The runner loads a **literal** `.env` from its install dir.

**The runner does not expand `$VARS` in `.env`** — every value must be written
out resolved. Using double quotes below makes your shell expand them *now*:

```bash
cd ~/actions-runner-android

echo "JAVA_HOME=$(/usr/libexec/java_home -v 25)" >> .env
echo "ANDROID_HOME=$ANDROID_HOME" >> .env
echo "ANDROID_SDK_ROOT=$ANDROID_HOME" >> .env
echo "ANDROID_AVD_HOME=$HOME/.android/avd" >> .env
echo "PATH=$(/usr/libexec/java_home -v 25)/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$ANDROID_HOME/cmdline-tools/latest/bin:$HOME/.maestro/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" >> .env

cat .env    # every path must be absolute — no literal '$' anywhere
```

Then install and start it:

```bash
./svc.sh install
./svc.sh start
./svc.sh status     # "started"
```

> Already installed the service before writing `.env`? Reload it:
> `./svc.sh stop && ./svc.sh start`.

The always-on / auto-recovery settings from the iOS runbook's **B5** (`pmset`,
auto-login, disabling unattended macOS updates) are host-wide — already done,
nothing to repeat.

### B7. Resource budget

An Android emulator with the config above reserves ~4 GB RAM and pins a couple
of cores under software rendering. If an iOS Simulator job is running at the same
time on the sibling runner, a 16 GB Mac will swap hard and both suites get flaky.

- **16 GB Mac:** drop `hw.ramSize` to `3072`, or accept that concurrent
  iOS+Android runs are slow.
- **32 GB+:** the config above is comfortable.
- **Intel Mac:** the emulator still gets hardware acceleration (Hypervisor
  framework, `-accel auto` — HAXM is dead and not needed), but with software
  rendering on top, expect boots nearer the 90-120 s end and hotter thermals on
  a laptop. If boots creep past the 300 s deadline in the run script, raise the
  `seq 1 150` loop bound rather than switching GPU modes.
- Prefer serialising instead? Give both runners the *same* labels and let GitHub
  pick — but then you are back to one job at a time, and the second instance
  buys you nothing.

---

## Part C — Confirm GitHub sees both runners

```bash
gh api /orgs/AGY-LLC/actions/runners \
  --jq '.runners[] | {name, status, labels: [.labels[].name]}'
```

Expect two **Idle** entries: `…-ios` with `self-hosted, macOS, ios` and
`…-android` with `self-hosted, macOS, android`.

---

## Part D — Point a `pba` smoke suite at it

The smoke path is generic — suite = runner labels + a script — so this needs no
interpreter change. Add the suite to the app repo's `pba.yml`:

```yaml
smoke:
  android-acceptance:
    runner: ["self-hosted", "macOS", "android"]
    setup: node
    environment: staging          # binds env-scoped secrets / reviewers
    env:
      AVD_NAME: pba-android
      MAESTRO_FLOW_DIR: .maestro/acceptance
      EAS_PROFILE: preview        # must be an APK profile — see the note below
    run: |
      set -euo pipefail

      # Maestro per-job keeps the host clean; skip if already on PATH via .env.
      if ! command -v maestro >/dev/null; then
        curl -Ls https://get.maestro.mobile.dev | bash
        export PATH="$HOME/.maestro/bin:$PATH"
      fi

      # Always tear the emulator down, including on failure.
      trap 'adb emu kill >/dev/null 2>&1 || true' EXIT

      adb start-server
      "$ANDROID_HOME/emulator/emulator" -avd "$AVD_NAME" \
        -no-window -no-audio -no-boot-anim -no-snapshot -wipe-data \
        -gpu swiftshader_indirect >"$RUNNER_TEMP/emulator.log" 2>&1 &

      adb wait-for-device
      booted=0
      for i in $(seq 1 150); do
        if [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; then
          booted=1; break
        fi
        sleep 2
      done
      [ "$booted" = "1" ] || { echo "emulator never booted"; tail -50 "$RUNNER_TEMP/emulator.log"; exit 1; }
      adb shell input keyevent 82

      # Pull the newest finished Android build. EXPO_TOKEN is already forwarded
      # by the central smoke workflow's secret passthrough.
      URL=$(npx --yes eas-cli build:list \
              --platform android --status finished --limit 1 \
              --profile "$EAS_PROFILE" --json --non-interactive \
            | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const b=JSON.parse(s)[0];if(!b)process.exit(1);console.log(b.artifacts.buildUrl)})')
      curl -fLo "$RUNNER_TEMP/app.apk" "$URL"
      adb install -r "$RUNNER_TEMP/app.apk"

      maestro test "$MAESTRO_FLOW_DIR"
```

Then dispatch it through the app repo's existing thin smoke caller (the same
`.github/workflows/smoke.yml` the iOS suite uses — no second caller needed):

```bash
gh workflow run smoke.yml -f suite=android-acceptance
gh run watch
```

The `plan` job on Ubuntu interprets `pba.yml`; the matrix job picks up
`runs-on: ["self-hosted","macOS","android"]` and lands on the new instance.

> **APK, not AAB.** EAS `production` Android builds produce an `.aab`, which
> `adb install` cannot take. Use a profile with `android.buildType: apk` (the
> stock `preview` profile does this) in `eas.json`:
> ```json
> { "build": { "preview": { "android": { "buildType": "apk" }, "distribution": "internal" } } }
> ```

> **The APK must carry a slice for the emulator's ABI.** EAS APK builds are
> universal by default, but a repo that enables ABI splits (or a library that
> ships arm-only `.so` files) fails on an x86_64 emulator with
> `INSTALL_FAILED_NO_MATCHING_ABIS`. Check before blaming the runner:
> ```bash
> adb shell getprop ro.product.cpu.abilist    # what the emulator accepts
> unzip -l app.apk | grep -o 'lib/[^/]*' | sort -u   # what the APK ships
> ```

> **`-wipe-data` on every run** gives each suite a clean device — worth the
> ~60-90 s boot. Drop it (keep `-no-snapshot`) if you would rather trade
> isolation for speed.

---

## Part E — Or use the reusable block (non-`pba` repos)

Repos on the central `agy-ci` scaffold instead of `pba.yml` get the same thing
from [`examples/agy-ci/.github/workflows/android-maestro.yml`](../examples/agy-ci/.github/workflows/android-maestro.yml),
the Android twin of `ios-maestro.yml`. The `mobile-app.yml` bundle wires it in
behind an `android-ui: true` toggle (off by default, so existing callers are
unaffected):

```yaml
jobs:
  pipeline:
    uses: agy/agy-ci/.github/workflows/mobile-app.yml@v1
    with:
      android-ui: true
      android-runner: '["self-hosted","macOS","android"]'
    secrets: inherit
```

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Java runtime not found` | `JAVA_HOME` missing from `~/actions-runner-android/.env` (B6). Maestro is a JVM app. |
| `adb: command not found` in a job, works in your shell | `platform-tools` not on the `.env` `PATH`. The service never reads `~/.zshrc`. |
| `PANIC: Cannot find AVD system path` | Emulator launched via a symlink, or `ANDROID_SDK_ROOT`/`ANDROID_AVD_HOME` unset in `.env`. Use the full `$ANDROID_HOME/emulator/emulator` path. |
| Boot hangs forever, log stops after `qemu` starts | macOS firewall prompt with no one to click Allow, or `-gpu host` under launchd. See B3. |
| `INSTALL_FAILED_NO_MATCHING_ABIS` | APK built for a different ABI than the system image (arm64 emulator + x86-only APK, or vice versa). Rebuild, or recreate the AVD with the matching image. |
| `device offline` / stale `emulator-5554` | Orphaned emulator from a killed job: `adb kill-server && pkill -f qemu-system` on the host, then re-run. The `trap` in Part D prevents most of these. |
| `adb install` fails with `INSTALL_FAILED_ALREADY_EXISTS` | Missing `-r`, or a debug/release signature mismatch — `adb uninstall <applicationId>` first. |
| Both suites suddenly flaky when run together | RAM contention with the iOS Simulator. See B7. |
| Runner shows Offline after a reboot | `cd ~/actions-runner-android && ./svc.sh status` — `svc.sh` must be run from its own root, not by absolute path. |

---

## Security

Same posture as the iOS runner, and it now applies to a second instance on the
same physical box: anyone who can edit a workflow in any AGY-LLC repo can
schedule jobs on this Mac. Keep org repos private, keep the smoke caller
`workflow_dispatch`-only, and treat the host's keychain/SSH keys as reachable by
org workflow authors. Full notes in
[`self-hosted-runner-setup.md`](./self-hosted-runner-setup.md#security-from-10).

---

## Teardown (Android instance only — leaves iOS untouched)

```bash
cd ~/actions-runner-android
./svc.sh stop && ./svc.sh uninstall
./config.sh remove --token $(gh api -X POST /orgs/AGY-LLC/actions/runners/remove-token --jq .token)

# Optional: reclaim the SDK + AVD (~10 GB)
avdmanager delete avd -n pba-android
brew uninstall --cask android-commandlinetools
```
