import "dotenv/config";
import { connectChain } from "./chain.js";
import { loadTickConfig } from "./config.js";
import { tick } from "./tick.js";

const cfg = loadTickConfig();
const chain = await connectChain({
  networkId: cfg.networkId,
  rpcUrl: cfg.rpcUrl,
  contractId: cfg.contractId,
  signers: [...cfg.agents, cfg.settler],
});
const code = await tick(chain, cfg);
process.exit(code);
