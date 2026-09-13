#!/usr/bin/env bash
# Operator wrapper for the replay instance fence (ops/replay-postgres-fence.sql).
#
#   replay_fence.sh status
#       Classify the fence. While pinned, record the external WAL high-water.
#       Exits 0 when pinned, 3 otherwise.
#   replay_fence.sh repin-restart
#       Re-pin a verified plain restart.
#   replay_fence.sh report [hours]
#       Pending/unknown identities and recent fence events for reconciliation.
#   replay_fence.sh repin-attested <admitted_count> "<note>"
#       Re-pin after reconciliation. admitted_count must equal the status value.
#
# Environment:
#   FENCE_CLUSTER      Managed Postgres cluster id (required)
#   FENCE_DATABASE     replay database name (required)
#   FENCE_OWNER_USER   schema owner login (default fly-user)
#   FENCE_STATE_DIR    external high-water directory (default ~/.402signal-fence)
#
# Connects with `flyctl mpg connect`, which supplies the credential, and never
# prints a connection string. Keep FENCE_STATE_DIR outside the database.
set -euo pipefail

usage() { sed -n '2,20p' "$0" >&2; exit 2; }

: "${FENCE_CLUSTER:?set FENCE_CLUSTER}"
: "${FENCE_DATABASE:?set FENCE_DATABASE}"
OWNER="${FENCE_OWNER_USER:-fly-user}"
STATE_DIR="${FENCE_STATE_DIR:-$HOME/.402signal-fence}"
FLYCTL="${FLYCTL:-flyctl}"
[[ "$FENCE_CLUSTER" =~ ^[a-z0-9]{8,40}$ ]] || { echo "invalid FENCE_CLUSTER" >&2; exit 2; }
[[ "$FENCE_DATABASE" =~ ^[A-Za-z_][A-Za-z0-9_-]{0,62}$ ]] || { echo "invalid FENCE_DATABASE" >&2; exit 2; }
[[ "$OWNER" =~ ^[A-Za-z_][A-Za-z0-9_-]{0,62}$ ]] || { echo "invalid FENCE_OWNER_USER" >&2; exit 2; }
STATE="$STATE_DIR/$FENCE_CLUSTER.$FENCE_DATABASE.high-water"
mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"

run_sql() {
  { printf '%s\n' '\set ON_ERROR_STOP on' '\pset pager off'; cat; } \
    | "$FLYCTL" mpg connect "$FENCE_CLUSTER" -u "$OWNER" -d "$FENCE_DATABASE" 2>&1 \
    | { grep -vE 'FlyV1|fm2_|password|postgres(ql)?://|^Proxying ' || true; }
}

high_water_args() {
  local timeline lsn
  if [ -s "$STATE" ]; then
    read -r timeline lsn < "$STATE"
    if [[ ! "$timeline" =~ ^[0-9]{1,10}$ || ! "$lsn" =~ ^[0-9A-F]{1,8}/[0-9A-F]{1,8}$ ]]; then
      echo "corrupt high-water file: $STATE" >&2
      return 1
    fi
    printf "'%s'::pg_lsn, %s" "$lsn" "$timeline"
  else
    printf 'NULL::pg_lsn, NULL::bigint'
  fi
}

lsn_value() {
  local hi="${1%/*}" lo="${1#*/}"
  echo $(( 16#$hi * 4294967296 + 16#$lo ))
}

record_high_water() {
  local timeline="$1" lsn="$2" old_timeline old_lsn
  if [ -s "$STATE" ]; then
    read -r old_timeline old_lsn < "$STATE"
    if [ "$old_timeline" = "$timeline" ] && [ "$(lsn_value "$lsn")" -le "$(lsn_value "$old_lsn")" ]; then
      return 0
    fi
  fi
  printf '%s %s\n' "$timeline" "$lsn" > "$STATE.tmp"
  mv "$STATE.tmp" "$STATE"
  echo "recorded external high-water: timeline $timeline wal $lsn"
}

HW="$(high_water_args)" || exit 2

case "${1:-}" in
  status)
    out="$(printf '%s\n' '\x on' \
      "SELECT s.*, CASE WHEN s.classification = 'pinned' THEN 'HIGH_WATER ' || s.current_timeline || ' ' || s.wal_lsn END AS record FROM signal_replay.fence_status($HW) s;" \
      | run_sql)" || { printf '%s\n' "$out"; exit 1; }
    printf '%s\n' "$out"
    if hw="$(printf '%s\n' "$out" | grep -oE 'HIGH_WATER [0-9]+ [0-9A-F]+/[0-9A-F]+')"; then
      read -r _ timeline lsn <<<"$hw"
      record_high_water "$timeline" "$lsn"
      exit 0
    fi
    exit 3
    ;;
  repin-restart)
    out="$(printf "SELECT signal_replay.fence_repin('restart', NULL, NULL, %s) AS result;\n" "$HW" \
      | run_sql)" || { printf '%s\n' "$out"; exit 1; }
    printf '%s\n' "$out"
    echo "next: run status to confirm the pin and record the new high-water"
    ;;
  report)
    hours="${2:-24}"
    [[ "$hours" =~ ^[0-9]{1,4}$ ]] || usage
    out="$(run_sql <<SQL
SELECT count(*) FILTER (WHERE state = 'settlement_pending') AS pending,
       count(*) FILTER (WHERE state = 'unknown') AS unknown_state,
       count(*) AS admitted_in_window
  FROM signal_replay.entries
 WHERE created_at >= extract(epoch FROM now()) - $hours * 3600;
SELECT left(fp_hash, 16) AS fingerprint_prefix, state, to_timestamp(created_at) AS created
  FROM signal_replay.entries
 WHERE state IN ('settlement_pending', 'unknown')
 ORDER BY created_at DESC
 LIMIT 200;
SELECT event_id, recorded_at, actor, kind, classification, admitted_count, pending_count, unknown_count, note
  FROM signal_replay.fence_events
 ORDER BY event_id DESC
 LIMIT 10;
\x on
SELECT * FROM signal_replay.fence_status($HW);
SQL
)" || { printf '%s\n' "$out"; exit 1; }
    printf '%s\n' "$out"
    ;;
  repin-attested)
    admitted="${2:-}"
    note="${3:-}"
    note_re='^[A-Za-z0-9 .,:;()/_#+-]{20,500}$'
    [[ "$admitted" =~ ^[0-9]{1,19}$ ]] || usage
    [[ "$note" =~ $note_re ]] || { echo "note must be 20-500 characters of letters, digits, spaces and .,:;()/_#+-" >&2; exit 2; }
    out="$(printf "SELECT signal_replay.fence_repin('attested', %s, '%s', %s) AS result;\n" "$admitted" "$note" "$HW" \
      | run_sql)" || { printf '%s\n' "$out"; exit 1; }
    printf '%s\n' "$out"
    echo "next: run status to confirm the pin and record the new high-water"
    ;;
  *)
    usage
    ;;
esac
