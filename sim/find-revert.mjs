// Find a recent reverted tx from a wallet and pull the actual revert reason.
//   node sim/find-revert.mjs [walletAddress]

const RPC = "https://rpc.moderato.tempo.xyz";
const WALLET = (process.argv[2] || "0x46c6db1Ec954F9f7D6a4E69997BB02A26b7ADd5B").toLowerCase();

async function rpc(m, p) {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: m, params: p }),
  });
  const j = await r.json();
  if (j.error) throw new Error(JSON.stringify(j.error));
  return j.result;
}

const latestHex = await rpc("eth_blockNumber", []);
const latest = BigInt(latestHex);
console.log(`Wallet: ${WALLET}`);
console.log(`Scanning blocks ${latest - 400n}..${latest} for revert events\n`);

let found = 0;
let okCount = 0;
let revertCount = 0;

for (let bn = latest; bn > latest - 400n && found < 3; bn--) {
  const block = await rpc("eth_getBlockByNumber", ["0x" + bn.toString(16), true]);
  if (!block || !block.transactions) continue;
  for (const tx of block.transactions) {
    if (!tx.from || tx.from.toLowerCase() !== WALLET) continue;
    const receipt = await rpc("eth_getTransactionReceipt", [tx.hash]);
    const reverted = receipt.status === "0x0";
    if (reverted) revertCount++;
    else okCount++;
    if (!reverted) continue;
    found++;
    console.log(`--- REVERTED tx in block ${bn} ---`);
    console.log(`hash:    ${tx.hash}`);
    console.log(`type:    ${tx.type}`);
    console.log(`tx keys: ${Object.keys(tx).join(", ")}`);
    console.log(`tx full: ${JSON.stringify(tx, null, 2).slice(0, 1200)}`);
    console.log(`receipt keys: ${Object.keys(receipt).join(", ")}`);
    console.log(`receipt status:    ${receipt.status}`);
    console.log(`receipt gasUsed:   ${parseInt(receipt.gasUsed)}`);
    console.log(`receipt logs:      ${receipt.logs.length}`);
    if (receipt.logs.length) {
      for (const log of receipt.logs.slice(0, 5)) {
        console.log(`  log topic[0]: ${log.topics[0]}  addr: ${log.address}`);
      }
    }

    // Try debug_traceTransaction
    try {
      const trace = await rpc("debug_traceTransaction", [tx.hash, { tracer: "callTracer" }]);
      console.log(`trace keys:         ${Object.keys(trace).join(", ")}`);
      console.log(`trace.error:        ${trace.error || "(none)"}`);
      console.log(`trace.revertReason: ${trace.revertReason || "(none)"}`);
      if (trace.output) console.log(`trace.output:       ${trace.output.slice(0, 300)}`);
      const walk = (c, depth = 0) => {
        if (!c) return;
        const indent = "  ".repeat(depth);
        if (c.error || c.revertReason || c.output) {
          console.log(`${indent}call ${c.type} -> ${c.to}  err=${c.error || ""}  reason=${c.revertReason || ""}  outLen=${(c.output || "").length}`);
          if (c.output && c.output.length <= 300) console.log(`${indent}  output: ${c.output}`);
        }
        (c.calls || []).forEach(cc => walk(cc, depth + 1));
      };
      walk(trace);
    } catch (e) {
      console.log(`debug_traceTransaction failed: ${e.message.slice(0, 300)}`);
    }
    console.log();
  }
}
console.log(`\nSummary: ${okCount} success, ${revertCount} reverts in scan window`);
