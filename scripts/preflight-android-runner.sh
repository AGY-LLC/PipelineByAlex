#!/usr/bin/env bash
# Preflight for docs/self-hosted-android-runner-setup.md.
#
# Verifies that Blocks A and B actually landed before you burn a single-use
# registration token on Block C. Run it ON THE MAC:
#
#   bash preflight-android-runner.sh              # includes a real headless boot
#   SKIP_BOOT=1 bash preflight-android-runner.sh  # skip the ~2 min boot test
#
# Exit 0 = ready for Block C.

AVD_NAME="${AVD_NAME:-pba-android}"
FAILED=0

pass() { printf "  \033[32mPASS\033[0m  %s\n" "$1"; }
fail() { printf "  \033[31mFAIL\033[0m  %s\n" "$1"; FAILED=$((FAILED + 1)); }
warn() { printf "  \033[33mWARN\033[0m  %s\n" "$1"; }
section() { printf "\n\033[1m%s\033[0m\n" "$1"; }

section "Host"
ARCH=$(uname -m)
ABI=$([ "$ARCH" = "arm64" ] && echo arm64-v8a || echo x86_64)
RAM_GB=$(( $(sysctl -n hw.memsize) / 1073741824 ))
printf "  %s, %s ABI, %s GB RAM\n" "$ARCH" "$ABI" "$RAM_GB"
[ "$RAM_GB" -ge 16 ] || warn "under 16 GB — concurrent iOS+Android runs will swap"

section "Android SDK (Block A)"
: "${ANDROID_HOME:=$(brew --prefix 2>/dev/null)/share/android-commandlinetools}"
if [ -d "$ANDROID_HOME" ]; then
  pass "ANDROID_HOME=$ANDROID_HOME"
else
  fail "ANDROID_HOME not found ($ANDROID_HOME) — Block A step 1 did not run"
fi

EMU="$ANDROID_HOME/emulator/emulator"
for tool in "$ANDROID_HOME/platform-tools/adb" "$EMU" \
            "$ANDROID_HOME/cmdline-tools/latest/bin/avdmanager"; do
  [ -x "$tool" ] && pass "$(basename "$tool") present" \
                 || fail "$(basename "$tool") missing"
done

IMG="$ANDROID_HOME/system-images/android-35/google_apis/$ABI"
[ -d "$IMG" ] && pass "system image android-35/google_apis/$ABI" \
              || fail "system image for $ABI missing — sdkmanager step incomplete"

section "AVD (Block A)"
if [ -x "$EMU" ] && "$EMU" -list-avds 2>/dev/null | grep -qx "$AVD_NAME"; then
  pass "AVD '$AVD_NAME' exists"
  CFG="$HOME/.android/avd/$AVD_NAME.avd/config.ini"
  if grep -q '^hw.ramSize=' "$CFG" 2>/dev/null; then
    pass "config patched ($(grep -E '^(hw.ramSize|disk.dataPartition.size)=' "$CFG" | tr '\n' ' '))"
  else
    warn "config.ini not patched — stock RAM/disk will be tight under Maestro"
  fi
else
  fail "AVD '$AVD_NAME' not found — avdmanager create step did not run"
fi

section "Shared toolchain (installed by the iOS runbook)"
if JH=$(/usr/libexec/java_home 2>/dev/null); then
  pass "JDK $("$JH/bin/java" -version 2>&1 | head -1 | sed 's/.*"\(.*\)".*/\1/') at $JH"
else
  fail "no JDK — Maestro is a JVM app; brew install --cask temurin@25"
fi
[ -x "$HOME/.maestro/bin/maestro" ] && pass "maestro present" \
  || warn "maestro not at ~/.maestro/bin — needed by suites, not by Block C"
gh auth status >/dev/null 2>&1 && pass "gh authenticated (Block C uses it)" \
  || fail "gh not authenticated — Block C's runner-version lookup will fail"

section "Clean state"
AVAIL=$(df -g / | awk 'NR==2 {print $4}')
[ "$AVAIL" -ge 20 ] && pass "${AVAIL} GB free" \
  || warn "only ${AVAIL} GB free — the AVD data partition wants 8 GB"
pgrep -qf qemu-system 2>/dev/null \
  && warn "an emulator is already running — 'adb emu kill' before Block C" \
  || pass "no stale emulator process"
[ -f "$HOME/actions-runner-android/.credentials" ] \
  && warn "~/actions-runner-android already configured — Block C would need './config.sh remove' first" \
  || pass "no existing Android runner install"

if [ "${SKIP_BOOT:-0}" != "1" ] && [ -x "$EMU" ]; then
  section "Headless boot test (Block B) — up to 5 min"
  LOG="${TMPDIR:-/tmp}/preflight-emulator.log"
  "$EMU" -avd "$AVD_NAME" -no-window -no-audio -no-boot-anim -no-snapshot \
    -gpu swiftshader_indirect >"$LOG" 2>&1 &
  "$ANDROID_HOME/platform-tools/adb" wait-for-device 2>/dev/null &
  WAIT_PID=$!
  # Bound `wait-for-device`: it blocks forever if qemu died on launch.
  for i in $(seq 1 30); do kill -0 $WAIT_PID 2>/dev/null || break; sleep 2; done
  kill $WAIT_PID 2>/dev/null

  booted=0
  for i in $(seq 1 150); do
    if [ "$("$ANDROID_HOME/platform-tools/adb" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; then
      booted=1; break
    fi
    sleep 2
  done

  if [ "$booted" = "1" ]; then
    pass "emulator booted headless in ~$((i * 2))s"
    pass "adb sees: $("$ANDROID_HOME/platform-tools/adb" devices | sed -n 2p | tr -s '\t' ' ')"
  else
    fail "emulator never booted — firewall prompt or GPU mode; tail of $LOG:"
    tail -15 "$LOG" | sed 's/^/        /'
  fi
  "$ANDROID_HOME/platform-tools/adb" emu kill >/dev/null 2>&1
else
  section "Headless boot test"
  warn "skipped — this is the check that actually gates Block C"
fi

printf "\n"
if [ "$FAILED" -eq 0 ]; then
  printf "\033[32m✓ Ready for Block C.\033[0m Get a fresh token if the old one is >1h old.\n"
  exit 0
fi
printf "\033[31m✗ %s check(s) failed — fix before Block C.\033[0m\n" "$FAILED"
printf "  Troubleshooting: docs/self-hosted-android-runner-setup.md\n"
exit 1
