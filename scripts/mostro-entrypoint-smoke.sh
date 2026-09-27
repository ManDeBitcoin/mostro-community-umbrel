#!/bin/sh
set -eu

cd "$(dirname "$0")/.."
temp_dir=$(mktemp -d)
trap 'rm -rf "$temp_dir"' EXIT HUP INT TERM
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
echo 'Mostro entrypoint smoke passed'
