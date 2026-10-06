#!/bin/sh
set -eu

case "${1:-}" in
    --version|-V) exec /usr/local/bin/mostrod "$@" ;;
esac

identity_file=${MOSTRO_IDENTITY_FILE:-/run/mostro/mostro.nsec}
settings_dir=${MOSTRO_SETTINGS_DIR:-/data}
# Seconds mostrod gets to stop after SIGTERM before SIGKILL. Kept below
# Docker's default 10 s stop timeout so the cleanup below always runs.
stop_grace=${MOSTRO_STOP_GRACE_SECONDS:-8}
# Pause before restarting a daemon that exited on its own.
restart_backoff=${MOSTRO_RESTART_BACKOFF_SECONDS:-5}

fail() {
    printf '%s\n' "Mostro startup refused: $1" >&2
    exit 1
}

[ "${MOSTRO_NSEC_PRIVKEY+x}" != x ] || fail 'pass the identity as a mounted file, not a Docker environment value'

# Refuses to continue unless the identity and settings files are safe to use,
# then exports the identity for mostrod. The nsec never appears in a command
# line, a Docker environment or a log.
load_identity() {
    [ -f "$identity_file" ] && [ ! -L "$identity_file" ] || fail 'private identity file is missing or is a symlink'
    [ "$(stat -c %u "$identity_file")" = "$(id -u)" ] || fail 'private identity file has a different owner'
    case "$(stat -c %a "$identity_file")" in
        400|600) ;;
        *) fail 'private identity file must have mode 0400 or 0600' ;;
    esac
    [ -f "$settings_dir/settings.toml" ] && [ ! -L "$settings_dir/settings.toml" ] || fail 'settings.toml is missing or is a symlink'

    # `read` fails on a file with no trailing newline and on an empty file.
    # Either way the check below decides, so the reason reaches the log.
    MOSTRO_NSEC_PRIVKEY=
    IFS= read -r MOSTRO_NSEC_PRIVKEY < "$identity_file" || true
    case "$MOSTRO_NSEC_PRIVKEY" in
        nsec1*) ;;
        *) fail 'private identity is not an nsec' ;;
    esac
    export MOSTRO_NSEC_PRIVKEY
}

if [ "${STANDBY_IF_UNCONFIGURED:-false}" = "true" ]; then
    standby_dir="$(dirname "$settings_dir")"
    standby_pid_file="${MOSTRO_STANDBY_PID_FILE:-$standby_dir/.mostro_standby.pid}"
    echo "$$" > "$standby_pid_file" 2>/dev/null || true
    child_pid=

    # The panel asks for a restart by creating one of these files. Both live
    # in the configuration volume the two containers share.
    wake_requested() {
        [ -f "$standby_dir/.standby_wake" ] || [ -f "$settings_dir/.standby_wake" ]
    }
    clear_wake() {
        rm -f "$standby_dir/.standby_wake" "$settings_dir/.standby_wake" 2>/dev/null || true
    }

    stop_child() {
        [ -n "$child_pid" ] || return 0
        kill -TERM "$child_pid" 2>/dev/null || true
        waited=0
        while kill -0 "$child_pid" 2>/dev/null && [ "$waited" -lt "$stop_grace" ]; do
            sleep 1
            waited=$((waited + 1))
        done
        kill -KILL "$child_pid" 2>/dev/null || true
        wait "$child_pid" 2>/dev/null || true
        child_pid=
    }

    # Keeps the exit status: a refused start must end the container with an
    # error so its restart policy and logs show it, while a stop request ends
    # cleanly.
    cleanup() {
        status=$1
        trap - EXIT INT TERM
        stop_child
        rm -f "$standby_pid_file" "${standby_pid_file}.sleep" "$settings_dir/mostro.pid" "$settings_dir/mostro.heartbeat" 2>/dev/null || true
        exit "$status"
    }
    trap 'cleanup $?' EXIT
    trap 'cleanup 0' INT TERM

    while true; do
        while [ ! -f "$identity_file" ] || [ ! -f "$settings_dir/settings.toml" ]; do
            printf '%s\n' "Mostro daemon: en espera de activación por el operador en el panel de control..."
            sleep 1 &
            sleep_pid=$!
            echo "$sleep_pid" > "${standby_pid_file}.sleep" 2>/dev/null || true
            wait "$sleep_pid" 2>/dev/null || true
            clear_wake
        done
        rm -f "$standby_pid_file" "${standby_pid_file}.sleep" 2>/dev/null || true
        clear_wake
        printf '%s\n' "Mostro daemon: configuración activa detectada. Iniciando mostrod..."

        load_identity

        started_at=$(date +%s)
        /usr/local/bin/mostrod -d "$settings_dir" "$@" &
        child_pid=$!
        echo "$child_pid" > "$settings_dir/mostro.pid" 2>/dev/null || true
        stop_requested=false

        while kill -0 "$child_pid" 2>/dev/null; do
            touch "$settings_dir/mostro.heartbeat" 2>/dev/null || true
            if wake_requested; then
                clear_wake
                stop_requested=true
                stop_child
                break
            fi
            if [ ! -f "$settings_dir/settings.toml" ]; then
                stop_requested=true
                stop_child
                break
            fi
            sleep 1 2>/dev/null || true
        done
        rm -f "$settings_dir/mostro.pid" "$settings_dir/mostro.heartbeat" 2>/dev/null || true

        # The panel signals the daemon itself when both run in the same
        # process namespace. A daemon found dead while a restart or a stop is
        # pending was asked to stop: that is not a crash to record.
        if [ "$stop_requested" = false ] && { wake_requested || [ ! -f "$settings_dir/settings.toml" ]; }; then
            stop_requested=true
            wait "$child_pid" 2>/dev/null || true
        fi

        if [ "$stop_requested" = false ]; then
            # mostrod ended on its own: LND or the relays were unreachable, the
            # settings were refused, or it crashed. Record it for the panel and
            # wait before trying again instead of spinning.
            exit_code=0
            wait "$child_pid" 2>/dev/null || exit_code=$?
            child_pid=
            ended_at=$(date +%s)
            uptime=$((ended_at - started_at))
            printf '%s %s %s\n' "$ended_at" "$exit_code" "$uptime" > "$settings_dir/mostro.last_exit" 2>/dev/null || true
            printf '%s\n' "Mostro daemon: mostrod terminó con código $exit_code tras $uptime s. Nuevo intento en $restart_backoff s." >&2
            waited=0
            while [ "$waited" -lt "$restart_backoff" ] && [ -f "$settings_dir/settings.toml" ] && ! wake_requested; do
                sleep 1
                waited=$((waited + 1))
            done
        fi
        child_pid=
    done
fi

load_identity
exec /usr/local/bin/mostrod -d "$settings_dir" "$@"
