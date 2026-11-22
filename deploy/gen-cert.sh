#!/bin/sh
# Self-signed certificate for RTSPS. Clients pin its public key (the API hands
# out the hash), so no CA is involved and the names in it are informational.
# Pass --force to replace an existing certificate (clients pick up the new pin
# on their next recording).
set -e
dir="$(dirname "$0")/certs"
mkdir -p "$dir"
if [ -f "$dir/rtsp.crt" ] && [ "$1" != "--force" ]; then
  echo "certificate already exists in $dir (use --force to replace it)"
  exit 0
fi
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 3650 \
  -subj "/CN=meeting-md" -addext "subjectAltName=DNS:meeting-md,DNS:localhost,IP:127.0.0.1" \
  -keyout "$dir/rtsp.key" -out "$dir/rtsp.crt" 2>/dev/null
chmod 644 "$dir/rtsp.key" "$dir/rtsp.crt"
echo "wrote $dir/rtsp.crt"
