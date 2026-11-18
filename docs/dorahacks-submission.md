# DoraHacks submission: MeterPass

Copy each field into the BUIDL form at https://dorahacks.io/hackathon/qday (Submit Build).
You click Submit yourself. Replace the one placeholder (demo video link) first.

---

## Short fields

**Project name**
MeterPass

**One-line description / tagline** (≤ 120 characters)
Pay per request without a transaction per request: AI agents pay with vouchers, merchants settle hundreds of calls in one tx.

**Track**
The public page lists no tracks. Pick **Decentralized Payments** (and **Native AI Assistants** too, if the
form allows a second one). Prizes are overall, not per track.

**Tags / technologies**
Solidity, Foundry, x402, ERC-4337, Kernel v3.1, session keys, ERC-8004, EIP-712, EIP-3009, tUSD8, viem, Next.js, TypeScript

**GitHub**
https://github.com/opxy16/meterpass

**Live demo**
https://meterpass.vercel.app

**Demo video**
`<paste the YouTube / Loom link here>`

**Network**
QDay Aevum testnet (chain 44005)

---

## Description (paste into the main description field)

### The problem
AI agents increasingly pay for what they use: an API call, a page of data, an inference. x402 brought
HTTP 402 "Payment Required" back for this, but in its usual form every request is its own on-chain
payment. At fractions of a cent per call, that means a fee on every call (often more than the price),
a wait on every call, and an agent holding a wallet it can be talked into emptying.

### What MeterPass does
MeterPass is a prepaid meter for agents, built on QDay Aevum with tUSD8.

1. **The owner approves once.** One transaction creates a Kernel v3.1 smart account and installs a
   scoped session key for the agent: which ERC-8004 merchants, how much in total, until when.
2. **The agent opens a pass** with only its session key, through `bundler.qday.info`. A pass is an
   ERC-721 that escrows tUSD8 for one merchant; the owner keeps the NFT.
3. **Every API call is paid with a voucher**: an EIP-712 signature of the running total
   ("pass 7, 0.502 tUSD8 used so far"). No gas, about 1–2 ms to sign. The merchant verifies it without
   touching the chain.
4. **The merchant settles in bulk**: one `claimBatch` transaction pays every call since its last claim.
5. **Unused credit is refundable**, the pass can be handed to another agent, and the owner can revoke
   the agent at any time.

It speaks x402 v2 (standard `PAYMENT-REQUIRED` / `PAYMENT-SIGNATURE` / `PAYMENT-RESPONSE` headers) with a
new scheme, **`batch-settlement`**, on network `eip155:44005`. As far as we could find (checked 18 Nov), it
is the first x402 batch settlement on Aevum, and no other entry in this challenge uses vouchers or payment
channels.

### Measured on Aevum testnet
The same 250 API calls at 0.002 tUSD8 each:

| | Per-call (250 EIP-3009 transfers) | MeterPass |
|---|---|---|
| On-chain transactions | 250 | **1** |
| Gas | 21,527,668 | **120,653** (≈ **178× less**) |
| Time | 93 s of transactions | 250 calls in 4.7 s, 0 transactions |

Settlement: https://explorer-test.qday.info/tx/0x1118b2a97743c65c94eaac697e3858b967a45bd935d7b1145510f081a66e387c

### Safety and controls
- **Least privilege on-chain:** the session-key module (`MeterPassSessionValidator`, a Kernel v3.1
  validator) only allows `PassVault.open/topUp`, for allowlisted ERC-8004 merchants, passes owned by the
  owner, within a total budget and a validity window, with no ETH value.
- **Prompt-injection resistant:** the agent's only payment tool is "voucher for my pass, my merchant,
  under my price limit". An over-priced 402 is refused before signing; an injected "send 5 tUSD8 to …"
  has no tool to call, and the session key is rejected by the account if it tries (`TargetNotAllowed`).
- **Revocation:** the owner revokes the pass; on Aevum the merchant refused the next request 2.3 s after
  the revoke's block (11 calls, 0.022 tUSD8, were served in that window and paid from the deposit).
- **No money leaks:** cumulative vouchers can't be replayed or reordered; they are bound to chain id,
  vault and pass; claims never exceed the deposit; refunds wait for the merchant's settlement window.
- **Tested:** 60 Foundry tests (unit tests, 7 fuzz tests at 1,024 runs, 5 invariants over thousands of
  random actions, and 4 fork tests against the real Aevum EntryPoint, Kernel and tUSD8) plus 7 SDK
  round-trip tests.

### Aevum / QDay integration
- **tUSD8**: unit of every pass and voucher; EIP-3009 `receiveWithAuthorization` for one-signature pass
  opening (the signature's nonce binds every pass term, so a relayer can't change them).
- **ERC-4337 EntryPoint v0.7 + Kernel v3.1**: owner smart account plus our session-key validator module.
- **bundler.qday.info**: every agent action (open and top-up passes) is a user operation through it.
- **ERC-8004**: minimal Identity and Reputation registries deployed on Aevum; merchants are registered
  agents (the demo merchant is agent #1), passes are opened per agent id, and
  `PassVault.settledVolume(agentId)` is verifiable revenue.
- **Shanghai EVM** (OpenZeppelin 5.1, bytecode checked for Cancun opcodes) and the **1,000-block
  `eth_getLogs` limit** (chunked, parallel reads).

### Contracts on Aevum testnet (chain 44005)
- PassVault: `0xa81D0B14D94036C51D7f15e492Ed11637Bd21B13`
- MeterPassSessionValidator: `0xE276a5f14A12B5B5ccC8FD6c1d74d2B03D4791EF`
- ERC-8004 Identity: `0x6486Cc21360b79A59FB1eFcC7e7e925485ef9Af1`
- ERC-8004 Reputation: `0xd69B3e2796Dd4e641d8C914ae606cCf70ea8460f`

The explorer can't verify source yet, so the deployed source is pinned to commit `4f43bd5` in the repo
(contract source unchanged since). The README lists every demo transaction with explorer links.

### Try it
https://meterpass.vercel.app: watch the meter, inspect passes and their on-chain art, or open the
playground, connect a wallet with a little tUSD8, sign once, and let a browser agent pay per call.

### What's reusable
`@meterpass/sdk` (MIT): a paying `fetch` for agents with spending rules, a merchant verifier, batch
settlement, a Kernel session-key account adapter for Aevum, the x402 `batch-settlement` codec, and a
1,000-block-aware log reader. Plus the contracts, a demo merchant and agent, and a local Aevum fork
script.

### Business model and roadmap
API and data sellers charge agents per request at sub-cent prices with no fee per call; agent owners get
hard limits and refunds. Revenue: a basis-point fee on settlement, a hosted settlement service for
merchants, and transferable prepaid passes. Next: USD8 mainnet (Q1 2027) with gas paid in USD8 via
QDay's paymaster, multi-merchant passes, push-based revocation under one block, and an MCP tool so any
agent framework can pay `batch-settlement` APIs.

### Honest notes
Testnet only: tUSD8 has no value and all activity shown is our own test runs. Account creation is one
ordinary transaction because Aevum's Kernel factory isn't staked (ERC-7562 bundler rules); everything
after that goes through the bundler.
