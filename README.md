# pachi

Multi-ball Plinko on the Tempo Moderato testnet. Per-user wallets in localStorage,
auto-funded via a serverless faucet. All game math (RNG, payout, RTP) is
on-chain — frontend just renders.

## What's where

- `public/` — static frontend (no build step). `index.html`, `shell.js`, card modules under `cards/`.
- `api/faucet.js` — Vercel serverless function. Calls `tempo_fundAddress` for new wallets, rate-limited per IP.
- `contracts/` — Foundry project. `src/Pachi.sol` is the live game contract; `test/Pachi.t.sol` covers RTP, distribution, bankroll guards.
- `sim/pachi-sim.mjs` — Node Monte Carlo. Replicates contract math to sanity-check expected value before deploying.

## Live testnet contract

`0xbc42C1a7815098BA4321B7bc1Bce0137Fd055E56` on Tempo Moderato (chain id 42431).

Multiplier table tuned to a 1.618% house edge — golden-ratio house, so to speak.

## Local dev

Frontend (no install):

```
cd public && python -m http.server 8787
```

Contracts:

```
cd contracts && forge build && forge test
```

Sim:

```
node sim/pachi-sim.mjs
```

## Deploy

`vercel` (project is configured via `vercel.json`).
