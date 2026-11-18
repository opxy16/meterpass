#!/usr/bin/env bash
# Local copy of Aevum testnet with MeterPass deployed, wallets funded and the merchant registered.
#   bash scripts/fork-up.sh        (needs Foundry, Node 22+, pnpm, and `pnpm wallets` run once)
# Chain id 440050 so nothing signed here can be replayed on the real testnet.
set -euo pipefail
cd "$(dirname "$0")/.."
RPC=http://127.0.0.1:8555
TUSD8=0x456569838f1d43009A91ebA4263147Afd7233483
TUSD8_BALANCE_SLOT=11   # FiatToken balances mapping slot on Aevum's tUSD8 implementation

if ! cast chain-id --rpc-url $RPC >/dev/null 2>&1; then
  echo "starting anvil fork of Aevum on $RPC ..."
  anvil --fork-url https://rpc-test.qday.info --chain-id 440050 --hardfork shanghai --port 8555 --block-time 1 --silent &
  for _ in $(seq 1 60); do cast chain-id --rpc-url $RPC >/dev/null 2>&1 && break; sleep 1; done
fi

set -a; . ./.env.wallets; set +a
for a in "$DEPLOYER_ADDRESS" "$OWNER_ADDRESS" "$MERCHANT_ADDRESS"; do
  cast rpc anvil_setBalance "$a" 0x8AC7230489E80000 --rpc-url $RPC >/dev/null      # 10 tQDAY
done
cast rpc anvil_setStorageAt $TUSD8 "$(cast index address "$OWNER_ADDRESS" $TUSD8_BALANCE_SLOT)" \
  0x0000000000000000000000000000000000000000000000000000000000989680 --rpc-url $RPC >/dev/null   # 10 tUSD8
echo "funded DEPLOYER, OWNER, MERCHANT on the fork"

(cd contracts && TOKEN=$TUSD8 forge script script/Deploy.s.sol --rpc-url $RPC --broadcast --legacy --silent)
METERPASS_NETWORK=fork pnpm --silent --filter @meterpass/merchant register
rm -f apps/agent/data/state-440050.json deployments/evidence-440050.json
echo "fork ready: METERPASS_NETWORK=fork pnpm --filter @meterpass/merchant start"
