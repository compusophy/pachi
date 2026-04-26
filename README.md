# pachi

Multi-ball Plinko on the Tempo blockchain. Per-user wallets, on-chain RNG,
1.618% house edge, EIP-2535 Diamond architecture for upgrade-without-redeploy.

**Live:** https://pachi-six.vercel.app  ·  **Network:** Tempo Moderato (chain 42431)

## What's in the repo

| Path | What |
|---|---|
| `public/` | Static frontend (no build step). Vercel serves from here. |
| `public/flux.js` | Viewport canvas overlay; animates balls between DOM elements. |
| `public/.well-known/farcaster.json` | Mini App manifest. Frame fields populated; signing optional. |
| `api/faucet.js` | Vercel serverless: proxies `tempo_fundAddress` for new wallets. |
| `api/redeem-invite.js` | Vercel serverless: validates invite code → adminMint PachiUSD. |
| `contracts/` | Foundry project — Diamond + facets + PachiUSD. |
| `sim/` | Node Monte Carlo + real-physics drift simulator + on-chain RTP aggregator. |
| `CLAUDE.md` | Project guide for AI sessions / quick orientation. |
| `vercel.json`, `package.json` | Vercel + npm config. |

## Live deployments

| Contract | Address |
|---|---|
| **Diamond (stable)** | `0x71e767bf661d6294c88953d640f0fc792a4c5086` |
| **PachiUSD** (game stake) | `0x576da0a989d574a3f9568007daceea919db6c53b` |
| **AlphaUSD** (gas) | `0x20c0000000000000000000000000000000000001` (Tempo system token) |

The diamond's address is permanent. Future game logic ships via `diamondCut`,
not by deploying a new diamond. The frontend's `PACHI_DIAMOND` constant should
never change.

## Architecture

EIP-2535 Diamond at a stable address. Selectors route to facets. AppStorage
in `LibPachi` is shared across facets (append-only — never reorder fields).

Facets installed:
- `DiamondCutFacet`, `DiamondLoupeFacet`, `OwnershipFacet` (generic)
- `GameFacet` — `play(uint256 n)`, on-chain stats counters
- `StatsFacet` — O(1) view aggregates for analytics
- `AdminFacet` — `setStake/withdraw/fund/setMults/bumpVersion/appVersion/resetStats/adminMint`
- `OnboardingFacet` — `register/claimDailyAllowance`

PachiUSD is a separate ERC20 (6 decimal). The diamond is its only minter.

Each play deterministically computes a slot per ball via
`popcount(keccak(player, nonce, prevrandao, blockNumber)[12bits])` — the
Plinko binomial — and pays `stake × multiplier_table[slot] / 10_000`.
Multiplier table is calibrated for **1.618% house edge**.

## Running locally

```bash
# Frontend (no install)
cd public && python -m http.server 8787

# Contracts
cd contracts && forge build && forge test

# Simulators
npm run sim:aim       # aim formula correctness across all 4096 paths
npm run sim:rtp       # theoretical Monte Carlo (closed-form RTP)
npm run sim:drift     # real Matter.js visual-vs-contract drift
npm run sim:onchain   # aggregate live Played events for real RTP
```

## Verification numbers (current)

| Metric | Value |
|---|---|
| Theoretical RTP | 98.392% |
| Theoretical edge | 1.608% (target: 1.618%) |
| Aim formula correctness | 100% across all 4096 paths |
| Physics drift (visual ↔ contract slot) | 0.10% over 1000 trials |
| On-chain RTP (last batch) | 98.690% over 9,897 ball samples |

Drift threshold for "rare in production": <3%. We're well under.

## Versioning policy

**Read this before changing the contract.** See `CLAUDE.md` for the full rules.

- Bump `appVersion` only on **breaking** changes (replace/remove a selector
  the client calls, or change semantics of an existing call).
- Order: contract first (`AdminFacet.bumpVersion(N+1)`), then `APP_VERSION`
  in `public/shell.js`, then deploy frontend.
- The client's `checkVersion()` runs on every action (cached 60s for match,
  sticky for mismatch). Stale tabs see a "PACHI updated — refresh" modal.

## Deploying

```bash
# Frontend (Vercel)
vercel --prod

# A new facet (additive — no version bump needed)
cd contracts
PRIVATE_KEY=… DIAMOND=0x71e767bf661d6294c88953d640f0fc792a4c5086 \
forge script script/MyCut.s.sol:MyCut \
  --rpc-url https://rpc.moderato.tempo.xyz \
  --tempo.fee-token 0x20c0000000000000000000000000000000000001 \
  --broadcast

# A breaking change — bump version too
cast send 0x71e767bf661d6294c88953d640f0fc792a4c5086 \
  'bumpVersion(uint256)' 3 \
  --rpc-url https://rpc.moderato.tempo.xyz \
  --private-key $KEY \
  --tempo.fee-token 0x20c0000000000000000000000000000000000001
# then: edit public/shell.js APP_VERSION = 3 → commit → vercel --prod
```

## Roadmap → mainnet

- ✅ Hand-distributed invite system (`/invite/<code>` URLs, server-side
  treasury that adminMints PachiUSD on redeem)
- ✅ Farcaster Mini App embed (meta tag + manifest — operator can sign
  the manifest later to enable discovery; the embed already works)
- PACHI ↔ USDC peg working on testnet (must be solid before mainnet)
- Player leaderboard (separate surface from operator analytics)
- Mainnet deploy (same code, different RPC, real funds)
- Stripe credit-card → on-chain USDC (Tempo's Stripe integration)

The closed visual loop (wallet → game → outcome → wallet, with the SAME
yellow gradient ball moving between every surface via the `flux.js`
canvas overlay) is in place. Optimistic balance updates instantly on
DROP. See `CLAUDE.md` § "The closed loop" for the full model.

## License

MIT.
