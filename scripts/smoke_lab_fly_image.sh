#!/bin/sh
# Build and smoke the Fly lab image using the real start-seller entrypoint.
# Synthetic offline fixture only. No Fly deploy, no production seller-deploy.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
IMAGE=${IMAGE:-402signal-lab-ci}
NAME=${NAME:-lab-fly-image-smoke}
SMOKE="$ROOT/integration/lab/config/seller-deploy.smoke.json"
cd "$ROOT"
test -f "$SMOKE"
test -d integration/lab/sdk/route-guard
docker build -f integration/lab/Dockerfile.fly -t "$IMAGE" integration

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; docker volume rm -f "${NAME}-labdata" >/dev/null 2>&1 || true; }
cleanup
docker volume create "${NAME}-labdata" >/dev/null

# Privilege drop: start as root, check-startup must report uid 1000.
check=$(docker run --rm --user 0 \
  -e LAB_STARTUP_SMOKE=1 \
  -v "${NAME}-labdata:/labdata" \
  -v "$SMOKE:/app/config/seller-deploy.json:ro" \
  "$IMAGE" node /app/start-seller.mjs --check-startup)
echo "$check"
echo "$check" | grep -q '"uid":1000'
echo "$check" | grep -q '"ok":true'

# Production app-name pin still refuses without smoke.
if docker run --rm --user 0 \
  -e FLY_APP_NAME=wrong-app \
  -v "${NAME}-labdata:/labdata" \
  -v "$SMOKE:/app/config/seller-deploy.json:ro" \
  "$IMAGE" node /app/start-seller.mjs --check-startup; then
  echo 'expected fly_app_refused' >&2
  exit 1
fi

docker run -d --name "$NAME" --user 0 \
  -e LAB_STARTUP_SMOKE=1 \
  -v "${NAME}-labdata:/labdata" \
  -v "$SMOKE:/app/config/seller-deploy.json:ro" \
  "$IMAGE" node /app/start-seller.mjs
trap cleanup EXIT

i=0
while [ "$i" -lt 30 ]; do
  if docker exec "$NAME" node --input-type=module -e "const r=await fetch('http://127.0.0.1:4021/health'); if (!r.ok) process.exit(1);" \
    >/dev/null 2>&1; then
    break
  fi
  i=$((i + 1))
  sleep 1
done
test "$i" -lt 30
test "$(docker inspect -f '{{.State.Running}}' "$NAME")" = true
uid=$(docker exec "$NAME" node -e "const fs=require('fs'); const m=fs.readFileSync('/proc/1/status','utf8').match(/^Uid:\\s+(\\d+)/m); if (!m || m[1] !== '1000') process.exit(1); console.log(m[1]);")
test "$uid" = "1000"

docker exec "$NAME" node --input-type=module -e "
const health = await fetch('http://127.0.0.1:4021/health');
const ready = await fetch('http://127.0.0.1:4021/ready');
const challenge = await fetch('http://127.0.0.1:4021/base/payload/sha256');
if (health.status !== 200 || ready.status !== 200 || challenge.status !== 402) process.exit(1);
const hb = await health.json(), rb = await ready.json();
if (hb.ok !== true || rb.ok !== true) process.exit(1);
"

docker exec "$NAME" node --input-type=module -e "
import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
if (!lstatSync('/mpp-algorand').isSymbolicLink()) process.exit(1);
if (readlinkSync('/mpp-algorand') !== '/app/native-mpp/algorand') process.exit(1);
const merchant = resolve('/app/dist/src', '../../../mpp-algorand/lab-merchant.mjs');
if (merchant !== '/mpp-algorand/lab-merchant.mjs') process.exit(1);
if (realpathSync(merchant) !== '/app/native-mpp/algorand/lab-merchant.mjs') process.exit(1);
const m = await import(merchant);
if (typeof m.createNativeAlgorandLabMerchant !== 'function') process.exit(1);
"

echo '{"result":"PASS","entrypoint":"node /app/start-seller.mjs","uid":1000,"health":200,"ready":200,"challenge":402}'
