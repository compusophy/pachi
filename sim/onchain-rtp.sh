#!/usr/bin/env bash
# Run N plays of K balls against the deployed Pachi, then aggregate the
# Played events into a real on-chain RTP measurement.

set -e

RPC=https://rpc.moderato.tempo.xyz
PACHI=0xbc42C1a7815098BA4321B7bc1Bce0137Fd055E56
TOKEN=0x20c0000000000000000000000000000000000001
KEY=0xd3dd2940e09d14bea2b8714497b57a703162bc9695a37fcb5f3993f4a2347171

PLAYS=${1:-10}
BALLS=${2:-100}

echo "=== Running $PLAYS plays of $BALLS balls (=$((PLAYS * BALLS)) ball samples) ==="
echo

WAGERED_RAW=0
PAID_RAW=0
RECEIPTS=()

for i in $(seq 1 $PLAYS); do
  RECEIPT=$(cast send "$PACHI" "play(uint256)" "$BALLS" \
    --rpc-url "$RPC" --private-key "$KEY" --tempo.fee-token "$TOKEN" --json 2>&1)

  # Extract Played event data
  RAW=$(echo "$RECEIPT" | python -c "
import sys, json
d = json.loads(sys.stdin.read())
log = next((l for l in d['logs'] if l['address'].lower() == d['to'].lower()), None)
if log is None:
  print('NO_EVENT')
  sys.exit(1)
hex = log['data'][2:]
def at(i): return int(hex[i*64:(i+1)*64], 16)
stake = at(0)
nballs = at(1)
totalBps = at(4)
payout = at(5)
print(f'{stake} {nballs} {totalBps} {payout}')
")
  read -r STAKE NBALLS TOTALBPS PAYOUT <<< "$RAW"
  WAGERED=$((STAKE * NBALLS))
  WAGERED_RAW=$((WAGERED_RAW + WAGERED))
  PAID_RAW=$((PAID_RAW + PAYOUT))
  printf "  play %2d  wagered=\$%6.2f  paid=\$%6.2f  ratio=%.3f×\n" \
    "$i" "$(echo "$WAGERED/1000000" | bc -l)" \
    "$(echo "$PAYOUT/1000000" | bc -l)" \
    "$(echo "scale=3; $PAYOUT/$WAGERED" | bc -l)"
done

echo
echo "=== Aggregate ==="
printf "  Total wagered: \$%.2f\n" "$(echo "$WAGERED_RAW/1000000" | bc -l)"
printf "  Total paid:    \$%.2f\n" "$(echo "$PAID_RAW/1000000" | bc -l)"
printf "  Net (house):   \$%.2f\n" "$(echo "($WAGERED_RAW-$PAID_RAW)/1000000" | bc -l)"
printf "  Real RTP:      %.3f%%\n" "$(echo "scale=4; 100*$PAID_RAW/$WAGERED_RAW" | bc -l)"
printf "  Real edge:     %.3f%%  (target: 1.618%%)\n" \
  "$(echo "scale=4; 100*($WAGERED_RAW-$PAID_RAW)/$WAGERED_RAW" | bc -l)"
