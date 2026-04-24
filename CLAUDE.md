# CLAUDE.md — PACHI project guide for AI sessions

## What this is

PACHI is a multi-ball Plinko game running on the Tempo blockchain. Currently
on **Tempo Moderato testnet** (chain 42431). Heading to Tempo mainnet next.

Live: https://pachi-six.vercel.app — Repo: https://github.com/compusophy/pachi

## Live state (Phase 2, April 2026)

| | |
|---|---|
| **Diamond (stable)** | `0x71e767bf661d6294c88953d640f0fc792a4c5086` |
| **PachiUSD (game stake)** | `0x576da0a989d574a3f9568007daceea919db6c53b` |
| **AlphaUSD (gas)** | `0x20c0000000000000000000000000000000000001` (Tempo system token) |
| **RPC** | `https://rpc.moderato.tempo.xyz` |
| **Explorer** | `https://explore.moderato.tempo.xyz` |
| **APP_VERSION** | 2 |

## Repo layout

```
public/                ← Vercel static (frontend)
  index.html
  shell.js             ← wallet, ctx, version check, modal wiring
  styles.css           ← shell + brand palette (gold scale + ink scale)
  cards/pachi.js       ← Plinko card: physics, audio, gold intensity
  analytics.js         ← StatsFacet view-call dashboard
api/
  faucet.js            ← Vercel serverless: tempo_fundAddress proxy
contracts/             ← Foundry project
  src/
    Diamond.sol            ← EIP-2535 proxy
    PachiUSD.sol           ← in-game ERC20 token
    diamond/               ← LibDiamond, Cut/Loupe/Ownership facets
    pachi/
      LibPachi.sol         ← AppStorage struct (APPEND ONLY!)
      GameFacet.sol        ← play(), reads, on-chain stats counters
      StatsFacet.sol       ← view aggregates for analytics
      AdminFacet.sol       ← setStake/withdraw/fund/setMults/bumpVersion
      OnboardingFacet.sol  ← register, claimDailyAllowance
      PachiInit.sol        ← initial cut delegate
      PhaseTwoInit.sol     ← Phase 2 init (token swap, version bump)
    Pachi.sol, Wave.sol, Pull.sol  ← legacy pre-diamond, kept for reference
  script/
    DeployPachiDiamond.s.sol  ← initial diamond deploy
    Phase2Cut.s.sol           ← Phase 2 cut: PachiUSD + Onboarding
  test/                ← forge tests (Diamond, PachiUSD, Onboarding)
sim/                   ← Node verification toolkit
  aim-validate.mjs     ← pure-math aim formula across all 4096 paths
  pachi-sim.mjs        ← Monte Carlo theoretical RTP
  physics-drift.mjs    ← real Matter.js drift simulation
  onchain-rtp.mjs      ← aggregates Played events from chain
foundry.toml           ← (under contracts/) via_ir + optimizer enabled
vercel.json, package.json
```

## Architecture in one paragraph

EIP-2535 Diamond at a stable address, with facets routed by selector. AppStorage
in `LibPachi` lives at one slot, accessible from any facet via `LibPachi.s()`.
**Append-only** — never reorder/remove fields. Facets: Cut/Loupe/Ownership
(generic), Game (play + reads), Stats (analytics views), Admin (setStake,
withdraw, fund, setMults, bumpVersion, appVersion), Onboarding (register,
claimDailyAllowance). PachiUSD is a separate ERC20 contract; the diamond is
its only minter. Frontend uses viem with `tempoActions` for AA-style
transactions, per-user wallets generated and stored in `localStorage`.

## Versioning policy (load-bearing, see memory: project_pachi_versioning)

- **Bump trigger**: REPLACE/REMOVE of a selector the client calls, OR change
  to semantics of an existing call. NOT for purely additive changes.
- **Order**: contract first (`AdminFacet.bumpVersion(N+1)`), then bump
  `APP_VERSION` in `public/shell.js`, then deploy frontend.
- **Stale tabs**: client `checkVersion()` is action-triggered, caches match
  for 60s, mismatch sticky. Stale modal blocks plays + offers refresh.
- **Address changes**: AVOID. Version system only protects facet upgrades
  on the same diamond. If you ever change `PACHI_DIAMOND`, drain the old
  contract's bankroll first (`withdraw`).

## Common workflows

```bash
# Local frontend dev
cd public && python -m http.server 8787

# Run all tests
cd contracts && forge test

# Run sim suite (any of)
npm run sim:aim       # aim formula proof — instant
npm run sim:rtp       # theoretical Monte Carlo
npm run sim:drift     # real Matter.js drift, 5000 trials = ~14s
npm run sim:onchain   # aggregate live Played events

# Deploy frontend
vercel --prod

# Deploy a NEW facet (additive — no version bump)
cd contracts
PRIVATE_KEY=... DIAMOND=... forge script script/MyCut.s.sol \
  --rpc-url https://rpc.moderato.tempo.xyz \
  --tempo.fee-token 0x20c0000000000000000000000000000000000001 \
  --broadcast

# Bump version (after a breaking facet change)
cast send 0x71e767bf661d6294c88953d640f0fc792a4c5086 \
  'bumpVersion(uint256)' 3 \
  --rpc-url https://rpc.moderato.tempo.xyz \
  --private-key $KEY \
  --tempo.fee-token 0x20c0000000000000000000000000000000000001
# Then: edit shell.js APP_VERSION = 3, commit, deploy
```

## Roadmap (Phase 2.B → mainnet)

- **Invite mutual rewards**: `register(inviter)` mints to inviter on first
  invitee play — Sybil-resistant via Farcaster FID binding (binding logic TBD).
- **Farcaster mini-app**: use Warpcast wallet instead of localStorage burner;
  invite codes work as Frame links.
- **Stripe credit-card on-ramp**: Tempo has heavy Stripe integration — direct
  fiat → USDC on-chain. Closes the "first dollar" problem for normies.
- **Mainnet deploy**: same code, different RPC/chain ID, fund with real assets.
- **Convertible PACHI ↔ USDC peg** (Option B from architecture menu, see
  memory: project_pachi_target_architecture). Until then PACHI is closed-loop
  play money.
- **Leaderboard** (separate from analytics — analytics is for the operator,
  leaderboard is for players).

## Behavioral / style guardrails (mirror of memory)

- Don't address the user by name. Don't infer it from path/email/git.
- No AI-template UI: no decorative gradients, no scanlines, no fake counters.
  Procedural visuals tied to real state. Brand palette is gold scale +
  ink scale (CSS vars in `styles.css`).
- "Real games not charts": visible mechanics, combos, cascades. Slot
  multipliers / ball physics / things that bounce.
- UI text discipline: action verbs stay constant ("DROP" never becomes
  "AGAIN"); no descriptive prefix labels on screens.
- Never surface house-edge / RTP / EV math in player UI. Operator/dev only.
- Don't introduce decorative color systems that fight a semantic one
  already in use (slot colors encode value — don't add rainbow elsewhere).
- Don't ask the user to run shell commands; use the Bash tool.
- Single typeface throughout: IBM Plex Mono.

## Sim is the trust layer

Whenever physics or contract math changes, re-run the sim BEFORE deploying:
- `sim:aim` proves the aim formula
- `sim:rtp` proves theoretical RTP
- `sim:drift` proves visual ↔ contract slot match (target < 3% drift)
- `sim:onchain` confirms real on-chain RTP matches theory within sample noise

Current measurements: aim 100% correct, theoretical RTP 98.39%, visual
drift 0.10%, on-chain RTP within 0.31pp of target over 9.8K balls.
