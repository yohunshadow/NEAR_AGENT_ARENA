import "dotenv/config";
import { connectChain } from "../src/chain.js";
import { loadTickConfig } from "../src/config.js";
import { tick } from "../src/tick.js";

// Vercel cron entry. Hobby plans only allow a daily schedule; see vercel.json.
// GitHub Actions (`.github/workflows/agent-cron.yml`) is the free runner that
// can tick more often. This handler does the same tick as `npm run tick`.
export default async function handler(_request: Request): Promise<Response> {
  try {
    const cfg = loadTickConfig();
    const chain = await connectChain({
      networkId: cfg.networkId,
      rpcUrl: cfg.rpcUrl,
      contractId: cfg.contractId,
      signers: [...cfg.agents, cfg.settler],
    });
    const code = await tick(chain, cfg);
    return Response.json({ ok: code === 0 });
  } catch (error) {
    return Response.json({ ok: false, error: String(error) }, { status: 500 });
  }
}
