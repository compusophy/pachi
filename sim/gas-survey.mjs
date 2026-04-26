// Survey gas usage of successful Played txs by ball-count tier.
//   node sim/gas-survey.mjs
const RPC = "https://rpc.moderato.tempo.xyz";

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

const PLAYED_SIG = "0xc6ce98194008ed376863343a2de4f8fef55325811d454082332e83a1280b1409";
const latest = BigInt(await rpc("eth_blockNumber", []));
const fromBlock = latest - 8000n;

const logs = await rpc("eth_getLogs", [{
  topics: [PLAYED_SIG],
  fromBlock: "0x" + fromBlock.toString(16),
  toBlock: "latest",
}]);
console.log(`Found ${logs.length} successful Played events in last 8000 blocks\n`);

const buckets = { 1: [], 10: [], 100: [], other: [] };
const sample = logs.slice(-50);
for (const log of sample) {
  const tx = await rpc("eth_getTransactionByHash", [log.transactionHash]);
  const r  = await rpc("eth_getTransactionReceipt", [log.transactionHash]);
  const data = log.data.slice(2);
  const nBalls = BigInt("0x" + data.slice(64, 128));
  const txGasLimit = parseInt(tx.gas, 16);
  const gasUsed    = parseInt(r.gasUsed, 16);
  const key = [1, 10, 100].includes(Number(nBalls)) ? Number(nBalls) : "other";
  buckets[key].push({ n: nBalls, txGasLimit, gasUsed });
}

for (const k of [1, 10, 100, "other"]) {
  if (!buckets[k] || !buckets[k].length) continue;
  const arr = buckets[k];
  const avg = arr.reduce((s, x) => s + x.gasUsed, 0) / arr.length;
  const max = Math.max(...arr.map(x => x.gasUsed));
  const min = Math.min(...arr.map(x => x.gasUsed));
  const minLim = Math.min(...arr.map(x => x.txGasLimit));
  const maxLim = Math.max(...arr.map(x => x.txGasLimit));
  console.log(`n=${String(k).padEnd(5)}  samples=${arr.length}  gasUsed avg=${Math.round(avg)}  range=${min}-${max}  tx gas limits=${minLim}..${maxLim}`);
}
