#!/bin/sh
set -eu

cd "$(dirname "$0")/.."
temp_dir=$(mktemp -d)
entry_pid=
cleanup() {
    [ -z "$entry_pid" ] || kill -KILL "$entry_pid" 2>/dev/null || true
    rm -rf "$temp_dir"
}
trap cleanup EXIT HUP INT TERM
mkdir "$temp_dir/settings"
touch "$temp_dir/settings/settings.toml"
printf '%s\n' 'nsec1synthetic-test-only' > "$temp_dir/mostro.nsec"
chmod 600 "$temp_dir/mostro.nsec"

# Replace only the daemon executable in an isolated copy. No real Mostro or LND
# process is started by this test.
sed "s@/usr/local/bin/mostrod@$temp_dir/mostrod@g" docker/mostro-entrypoint.sh > "$temp_dir/entrypoint"
cat > "$temp_dir/mostrod" <<'SH'
#!/bin/sh
[ "$MOSTRO_NSEC_PRIVKEY" = nsec1synthetic-test-only ] || exit 1
[ "$1" = -d ] && [ "$2" = "$MOSTRO_SETTINGS_DIR" ] || exit 1
SH
chmod 700 "$temp_dir/mostrod"
/bin/sh -n "$temp_dir/entrypoint"

run_entrypoint() {
    MOSTRO_IDENTITY_FILE="$temp_dir/mostro.nsec" \
    MOSTRO_SETTINGS_DIR="$temp_dir/settings" \
    /bin/sh "$temp_dir/entrypoint" 2>/dev/null
}

# ── Direct mode: starts only with a safe identity and settings ───────────────
run_entrypoint
chmod 644 "$temp_dir/mostro.nsec"
if run_entrypoint; then exit 1; fi
chmod 600 "$temp_dir/mostro.nsec"
mv "$temp_dir/mostro.nsec" "$temp_dir/real.nsec"
ln -s "$temp_dir/real.nsec" "$temp_dir/mostro.nsec"
if run_entrypoint; then exit 1; fi
rm "$temp_dir/mostro.nsec"
mv "$temp_dir/real.nsec" "$temp_dir/mostro.nsec"
rm "$temp_dir/settings/settings.toml"
if run_entrypoint; then exit 1; fi
touch "$temp_dir/settings/settings.toml"
if MOSTRO_NSEC_PRIVKEY='nsec1docker-environment' run_entrypoint; then exit 1; fi
# An identity without a trailing newline is accepted; an empty one is refused
# with the reason in the log, not with a silent exit.
printf '%s' 'nsec1synthetic-test-only' > "$temp_dir/mostro.nsec"
run_entrypoint
: > "$temp_dir/mostro.nsec"
refusal=$(MOSTRO_IDENTITY_FILE="$temp_dir/mostro.nsec" MOSTRO_SETTINGS_DIR="$temp_dir/settings" /bin/sh "$temp_dir/entrypoint" 2>&1) && exit 1
case "$refusal" in
    *'private identity is not an nsec'*) ;;
    *) printf '%s\n' "empty identity refused without a reason: $refusal" >&2; exit 1 ;;
esac
printf '%s\n' 'nsec1synthetic-test-only' > "$temp_dir/mostro.nsec"

# ── Standby mode: the supervisor loop used by the Umbrel package ─────────────
fail() {
    printf '%s\n' "entrypoint smoke failed: $1" >&2
    exit 1
}
wait_for() {
    # wait_for <seconds> <test expression...>
    remaining=$(($1 * 10))
    shift
    until "$@"; do
        remaining=$((remaining - 1))
        [ "$remaining" -gt 0 ] || return 1
        sleep 0.1
    done
}
standby_dir="$temp_dir/standby"
active="$standby_dir/active"
mkdir -p "$active"
start_standby() {
    STANDBY_IF_UNCONFIGURED=true \
    MOSTRO_IDENTITY_FILE="$temp_dir/mostro.nsec" \
    MOSTRO_SETTINGS_DIR="$active" \
    MOSTRO_RESTART_BACKOFF_SECONDS=1 \
    MOSTRO_STOP_GRACE_SECONDS=2 \
    /bin/sh "$temp_dir/entrypoint" >/dev/null 2>&1 &
    entry_pid=$!
}

# 1. A refused start ends with an error status, not a silent success that
#    would leave the container stopped under `restart: on-failure`.
touch "$active/settings.toml"
chmod 644 "$temp_dir/mostro.nsec"
start_standby
status=0
wait "$entry_pid" || status=$?
entry_pid=
[ "$status" -ne 0 ] || fail 'a refused start in standby exited with status 0'
[ ! -e "$active/mostro.pid" ] || fail 'pid file left after a refused start'
chmod 600 "$temp_dir/mostro.nsec"

# 2. A daemon that dies on its own is recorded and retried after a pause.
cat > "$temp_dir/mostrod" <<SH
#!/bin/sh
echo run >> "$temp_dir/runs"
exit 3
SH
rm -f "$active/settings.toml"
start_standby
sleep 0.3
[ ! -e "$temp_dir/runs" ] || fail 'the daemon started without settings'
touch "$active/settings.toml"
wait_for 5 test -s "$active/mostro.last_exit" || fail 'the exit of the daemon was not recorded'
read -r _ exit_code uptime < "$active/mostro.last_exit"
[ "$exit_code" = 3 ] || fail "recorded exit code $exit_code instead of 3"
[ "$uptime" -le 2 ] || fail "recorded uptime $uptime"
sleep 2.5
runs=$(wc -l < "$temp_dir/runs")
[ "$runs" -ge 2 ] || fail 'the daemon was not restarted'
[ "$runs" -le 4 ] || fail "the daemon was restarted $runs times in under 4 s: no backoff"
kill -TERM "$entry_pid"
status=0
wait "$entry_pid" || status=$?
entry_pid=
[ "$status" -eq 0 ] || fail "a stop request ended with status $status"

# 3. A running daemon gets a heartbeat, is restarted on a wake request and is
#    stopped when the settings are withdrawn.
cat > "$temp_dir/mostrod" <<SH
#!/bin/sh
echo "\$\$" >> "$temp_dir/pids"
exec sleep 300
SH
rm -f "$temp_dir/runs" "$active/mostro.last_exit"
start_standby
wait_for 5 test -s "$active/mostro.pid" || fail 'no pid file for a running daemon'
wait_for 5 test -e "$active/mostro.heartbeat" || fail 'no heartbeat for a running daemon'
first=$(cat "$active/mostro.pid")
kill -0 "$first" 2>/dev/null || fail 'the recorded pid is not running'
touch "$standby_dir/.standby_wake"
# Between the two daemons the pid file does not exist: only a new, non-empty
# pid counts as a restart.
wait_for 8 sh -c "pid=\$(cat '$active/mostro.pid' 2>/dev/null) && [ -n \"\$pid\" ] && [ \"\$pid\" != '$first' ]" || fail 'the wake request did not restart the daemon'
! kill -0 "$first" 2>/dev/null || fail 'the previous daemon survived the restart'
[ ! -e "$standby_dir/.standby_wake" ] || fail 'the wake request was not consumed'
[ ! -e "$active/mostro.last_exit" ] || fail 'a requested restart was recorded as a crash'
second=$(cat "$active/mostro.pid")
rm "$active/settings.toml"
wait_for 8 sh -c "! kill -0 '$second' 2>/dev/null" || fail 'the daemon kept running without settings'
wait_for 5 sh -c "[ ! -e '$active/mostro.pid' ] && [ ! -e '$active/mostro.heartbeat' ]" || fail 'runtime markers left after deactivation'
kill -0 "$entry_pid" 2>/dev/null || fail 'the supervisor exited instead of returning to standby'
kill -TERM "$entry_pid"
wait "$entry_pid" || true
entry_pid=

echo 'Mostro entrypoint smoke passed'
