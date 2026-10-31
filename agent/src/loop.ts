import "dotenv/config";
import { connectChain } from "./chain.js";
import { loadTickConfig } from "./config.js";
import { tick } from "./tick.js";

const requested = Number(process.env.TICK_INTERVAL_MS ?? "60000");
const waitMs = Number.isFinite(requested) && requested >= 5000 ? requested : 60000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

console.log(`near-agent-arena loop every ${waitMs}ms`);
for (;;) {
  try {
    const cfg = loadTickConfig();
    const chain = await connectChain({
      networkId: cfg.networkId,
      rpcUrl: cfg.rpcUrl,
      contractId: cfg.contractId,
      signers: [...cfg.agents, cfg.settler],
    });
    const code = await tick(chain, cfg);
    console.log(`tick finished with status ${code}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
  }
  await sleep(waitMs);
}
