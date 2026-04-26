// Quick contract state inspector — prints bankroll, stake, max payout
// at each n, version, and the multiplier table. Read-only, no key.
//
//   node sim/query-state.mjs

import { encodeFunctionData } from "viem";

const RPC     = "https://rpc.moderato.tempo.xyz";
const DIAMOND = "0x71e767bf661d6294c88953d640f0fc792a4c5086";

async function rpc(method, params) {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(JSON.stringify(j.error));
  return j.result;
}

async function call(name, abi, args = []) {
  const data = encodeFunctionData({ abi: [abi], functionName: name, args });
  const r = await rpc("eth_call", [{ to: DIAMOND, data }, "latest"]);
  return r;
}

const u256 = (h) => BigInt(h);

const bankrollHex = await call("bankroll",
  { type: "function", name: "bankroll", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] });
const stakeHex = await call("stake",
  { type: "function", name: "stake", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] });
const versionHex = await call("appVersion",
  { type: "function", name: "appVersion", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] });

const bankroll = u256(bankrollHex);
const stake    = u256(stakeHex);
const version  = u256(versionHex);

const fmt = (raw) => "$" + (Number(raw) / 1e6).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

console.log("=== PACHI diamond state ===\n");
console.log(`  Diamond:     ${DIAMOND}`);
console.log(`  appVersion:  ${version}`);
console.log(`  Stake/ball:  ${fmt(stake)}`);
console.log(`  Bankroll:    ${fmt(bankroll)}\n`);

// Read all 13 mults
const multsAbi = { type: "function", name: "mults", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "uint32" }] };
const mults = [];
for (let i = 0; i < 13; i++) {
  const h = await call("mults", multsAbi, [BigInt(i)]);
  mults.push(Number(BigInt(h)));
}
console.log(`  MULTS: [${mults.join(", ")}]`);
console.log(`  Max mult: ${Math.max(...mults)} bps = ${Math.max(...mults) / 10000}×\n`);

const maxMult = BigInt(Math.max(...mults));

console.log("=== Max payout per n (must be ≤ bankroll) ===");
for (const n of [1, 10, 100]) {
  const maxPayout = (BigInt(n) * maxMult * stake) / 10_000n;
  const ok = bankroll >= maxPayout;
  const marker = ok ? "OK  " : "FAIL";
  console.log(`  ${marker}  n=${String(n).padStart(3)}  max payout = ${fmt(maxPayout)}  ${ok ? "" : `(short by ${fmt(maxPayout - bankroll)})`}`);
}

console.log("\n=== Diamond's PachiUSD balance check (raw token call) ===");
// Direct ERC20 balanceOf on PachiUSD
const PACHI_USD = "0x576da0a989d574a3f9568007daceea919db6c53b";
const balanceData = encodeFunctionData({
  abi: [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }],
  functionName: "balanceOf", args: [DIAMOND],
});
const balRaw = await rpc("eth_call", [{ to: PACHI_USD, data: balanceData }, "latest"]);
console.log(`  PachiUSD.balanceOf(diamond) = ${fmt(BigInt(balRaw))}`);
console.log(`  bankroll() view             = ${fmt(bankroll)}`);
console.log(`  match: ${BigInt(balRaw) === bankroll ? "yes" : "NO — drift!"}`);
