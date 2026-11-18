# MeterPass demo video: script and shot list

Target length **about 4 minutes** (DoraHacks needs a demo video; the top 5 present 3 to 5 minutes on
15 Dec). Plain English, one idea per scene. Every number below was measured on Aevum testnet and is in
`deployments/metrics-44005.json`.

## Before you record

- [ ] **Never show `.env.wallets`, `apps/web/.env.local` or Vercel's environment variables on screen.**
      Close those files and any editor tab that has them. The terminal only ever prints addresses and
      transaction hashes.
- [ ] Screen at 1920×1080, browser zoom 110 %, terminal font 16 pt or larger, notifications off.
- [ ] Browser tabs, in order: `https://meterpass.vercel.app`, the explorer
      (`https://explorer-test.qday.info`), the GitHub repo.
- [ ] Two terminals side by side, both in `apps/agent`:
      left: the merchant server, right: the agent.
- [ ] Start the merchant against Aevum (terminal 1):
      ```bash
      cd apps/merchant
      METERPASS_NETWORK=aevum SETTLE_INTERVAL_SECONDS=240 pnpm start
      ```
- [ ] To show the merchant's live feed on the dashboard while recording, run the dashboard locally
      pointed at that merchant (`NEXT_PUBLIC_MERCHANT_URL=http://localhost:8787` in `apps/web/.env.local`,
      then `pnpm --filter @meterpass/web dev`). The hosted site shows its own merchant.
- [ ] A fresh smart account for a clean run (the first one's budget is spent): about 1.3 tUSD8 and
      0.06 tQDAY on the owner. Then `pnpm demo setup --new` once before recording, or record it as scene 3.
- [ ] Rehearse once. If a live step misbehaves, cut to the transaction already on the explorer (links in
      the "Fallback" column).

## Scenes

| # | Time | On screen | Say (voice-over) | Fallback |
|---|---|---|---|---|
| 1 | 0:00–0:20 | Dashboard hero: the odometer ticking | "AI agents are starting to pay for what they use: an API call, a page of data. Paid per call on-chain, every request becomes a transaction, and the fee is often bigger than the price." | – |
| 2 | 0:20–0:45 | Scroll to **250 calls, two ways**; let the vouchers collapse into one bar | "MeterPass is a prepaid meter for agents. The agent pays every call with a signed voucher: no gas, a couple of milliseconds. The merchant collects hundreds of calls in one transaction. On Aevum, 250 calls cost 178 times less gas." | – |
| 3 | 0:45–1:15 | Right terminal: `pnpm demo setup --new`, then `pnpm demo open --amount 1`; open both transactions on the explorer | "The owner approves once. One transaction creates a Kernel smart account, installs a session key for the agent and approves a budget. Then the agent, using only that key, opens a pass through Aevum's bundler. The pass is an NFT that holds tUSD8 for one ERC-8004 merchant, and the owner keeps it." | setup [`0xb576…189d`](https://explorer-test.qday.info/tx/0xb5765153c959d508133cff0524a772f684b9da1a87d50a7a1cf0d8267260189d), open [`0x26b3…a85d`](https://explorer-test.qday.info/tx/0x26b359c54d5d9c1ecb4d712f0eb339ea8d587b041ad38baceab6e87ba15fa85d) |
| 4 | 1:15–1:55 | `pnpm demo run --calls 250` next to the dashboard (meter and receipt tape moving); then `pnpm demo settle --requests 250`; open the settlement on the explorer | "Now 250 paid API calls. Each one: a 402 from the API, a voucher from the agent, data back. Four or five seconds, and zero transactions. When the merchant wants its money, one claimBatch transaction settles all 250: 120 thousand gas, instead of 21 and a half million for 250 separate payments." | settlement [`0x1118…387c`](https://explorer-test.qday.info/tx/0x1118b2a97743c65c94eaac697e3858b967a45bd935d7b1145510f081a66e387c), per-call sample [`0xa2b4…2fec`](https://explorer-test.qday.info/tx/0xa2b4d5475223f1778428428e5baf2d0f65bbbf6374b15aee3ed7aa13303d2fec) |
| 5 | 1:55–2:25 | `pnpm demo inject` | "An agent with money is a target. If the API quotes five tUSD8 for one call, the agent refuses before signing anything. If a page says 'send five tUSD8 to this address', the agent has no tool to do it, and even a stolen session key can't: the smart account rejects any call to the token." | – |
| 6 | 2:25–2:55 | Open a fresh pass, then `pnpm demo run --calls 20 --revoke-after 10 --interval-ms 100`; highlight the `402 pass_revoked` line | "The owner can stop the agent at any moment. I revoke the pass while the agent keeps calling. About two seconds after the revoke lands on-chain, the merchant refuses the next request with 402. The few calls served in between are paid from the deposit the owner already committed." | revoke [`0x504b…4989`](https://explorer-test.qday.info/tx/0x504b1ae988aab0cd40dfe8dd573982870bd6a5a8e3371aa61a6805b7e34d4989) |
| 7 | 2:55–3:15 | `pnpm demo reassign`, `pnpm demo run --agent B --calls 25` | "The pass can be handed to another agent. Agent B checks agent A's last voucher, carries on from the same running total, and the merchant settles both." | reassign [`0x65f8…71c`](https://explorer-test.qday.info/tx/0x65f863e2fc93855624c62558d5dbfbba338ab01cc509975a9a565ada49ce371c) |
| 8 | 3:15–3:35 | Dashboard **Passes** page: the on-chain card art, a closed pass | "Unused credit goes back to the owner after expiry, but only once the merchant's settlement window has passed, so nobody can run off with what they owe. The card art is drawn on-chain from the pass's live state." | refund [`0x3f06…a776`](https://explorer-test.qday.info/tx/0x3f06eaaafbfea18f7648ae0fb9d3cc7eaabe8e7754a08cdf99685f512c5fa776) |
| 9 | 3:35–3:55 | Dashboard **Try it**: connect a wallet, open a 0.05 pass with one signature, run 20 calls | "You can try it yourself on the live site. Connect a wallet, sign once, and a relayer opens the pass. A throwaway key in your browser then pays per call." | live-site settlement [`0x93fc…b7b`](https://explorer-test.qday.info/tx/0x93fc4f0bffd764aec9e6fed14697f891278b9800f0053204290fabb84fe12b7b) |
| 10 | 3:55–4:15 | GitHub README: diagrams, tests table | "Everything is open source under MIT: the contracts with 60 Foundry tests including fuzz and invariant tests, an SDK for agents and merchants, and the x402 batch-settlement scheme. MeterPass: pay per request, settle once." | – |

## Lines to keep accurate

- Say **"about two seconds after the revoke lands"**, not "instantly". Measured: 2.3 s after the block,
  11 calls (0.022 tUSD8) accepted in between.
- Say **"178 times less gas"** for the 250-call comparison (21,527,668 gas vs 120,653).
- The owner's setup is **one transaction**, not one signature through the bundler: Aevum's Kernel
  factory isn't staked, so account creation can't go through the bundler. Everything the agent does
  does go through `bundler.qday.info`.
- Everything is **testnet**; tUSD8 has no value. Don't present demo activity as real users.

## 60-second cut (if a shorter video is useful)

Scenes 1 → 2 → 4 (settlement only) → 5 (first line) → 6 (the 402 line) → 10, about 15 seconds each with
shorter lines.
