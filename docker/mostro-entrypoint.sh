#!/bin/sh
set -eu

# Version inspection must work before provisioning any live credentials.
case "${1:-}" in
    --version|-V) exec /usr/local/bin/mostrod "$@" ;;
esac

identity_file=${MOSTRO_IDENTITY_FILE:-/run/mostro/mostro.nsec}
settings_dir=${MOSTRO_SETTINGS_DIR:-/data}

fail() {
    printf '%s\n' "Mostro startup refused: $1" >&2
    exit 1
}

[ "${MOSTRO_NSEC_PRIVKEY+x}" != x ] || fail 'pass the identity as a mounted file, not a Docker environment value'
[ -f "$identity_file" ] && [ ! -L "$identity_file" ] || fail 'private identity file is missing or is a symlink'
[ "$(stat -c %u "$identity_file")" = "$(id -u)" ] || fail 'private identity file has a different owner'
case "$(stat -c %a "$identity_file")" in
    400|600) ;;
    *) fail 'private identity file must have mode 0400 or 0600' ;;
esac
[ -f "$settings_dir/settings.toml" ] && [ ! -L "$settings_dir/settings.toml" ] || fail 'settings.toml is missing or is a symlink'

MOSTRO_NSEC_PRIVKEY=
IFS= read -r MOSTRO_NSEC_PRIVKEY < "$identity_file" || [ -n "$MOSTRO_NSEC_PRIVKEY" ]
case "$MOSTRO_NSEC_PRIVKEY" in
    nsec1*) ;;
    *) fail 'private identity is not an nsec' ;;
esac
export MOSTRO_NSEC_PRIVKEY
exec /usr/local/bin/mostrod -d "$settings_dir" "$@"
