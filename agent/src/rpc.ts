// Bounded JSON-RPC for the worker.
//
// near-api-js retries a hung rpc.testnet.near.org call about ten times and
// does not abort the socket. One commit then outlasts the reveal window, the
// tick wakes up in `settle`, and the round finalizes with no moves. This
// client gives each attempt a deadline and walks a fallback list.

export const TESTNET_RPC_FALLBACKS = [
  "https://rpc.testnet.near.org",
  "https://test.rpc.fastnear.com",
] as const;

export const RPC_TIMEOUT_MS = 8_000;
export const RPC_ATTEMPTS = 2;

export class RpcRejected extends Error {
  constructor(readonly body: RpcErrorBody) {
    super(rpcErrorText(body));
    this.name = "RpcRejected";
  }
}

export interface RpcErrorBody {
  code?: number;
  message?: string;
  data?: unknown;
  name?: string;
}

export interface RpcCallOptions {
  timeoutMs?: number;
  attempts?: number;
  fetchImpl?: typeof fetch;
}

export function rpcEndpoints(primary: string, networkId: string, extra?: string | null): string[] {
  const disabled = isOff(extra);
  const urls = splitUrls(primary);
  // Sandbox and local RPCs must not fall through to public testnet.
  if (!disabled && networkId === "testnet") {
    urls.push(...splitUrls(extra));
    urls.push(...TESTNET_RPC_FALLBACKS);
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const url of urls) {
    const normalized = url.replace(/\/+$/, "");
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  if (out.length === 0) throw new Error("no RPC endpoint configured");
  return out;
}

export async function postJsonRpc(
  urls: string[],
  method: string,
  params: unknown,
  options: RpcCallOptions = {},
): Promise<unknown> {
  if (urls.length === 0) throw new Error("no RPC endpoint configured");
  const timeoutMs = options.timeoutMs ?? RPC_TIMEOUT_MS;
  const attempts = options.attempts ?? RPC_ATTEMPTS;
  const fetchImpl = options.fetchImpl ?? fetch;
  let lastError: unknown = new Error("RPC request failed");
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    for (const url of urls) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(url, {
          method: "POST",
          signal: controller.signal,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: "near-agent-arena", method, params }),
        });
        if (!response.ok) {
          const httpError = new Error(`RPC ${url} HTTP ${response.status} for ${method}`);
          if (!isTransientStatus(response.status)) throw httpError;
          lastError = httpError;
          console.warn(`${httpError.message}; trying the next endpoint`);
          continue;
        }
        const body = (await response.json()) as { result?: unknown; error?: RpcErrorBody };
        if (body.error) {
          if (isTransientRpcError(body.error)) {
            lastError = new Error(`RPC ${url} timed out on ${method}`);
            console.warn(`${(lastError as Error).message}; trying the next endpoint`);
            continue;
          }
          throw new RpcRejected(body.error);
        }
        return body.result;
      } catch (error) {
        if (error instanceof RpcRejected) throw error;
        if (!isTransientFetch(error)) throw error;
        lastError = error;
        const reason = error instanceof Error ? error.message : String(error);
        console.warn(`RPC ${url} failed for ${method} (${reason}); trying the next endpoint`);
      } finally {
        clearTimeout(timer);
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function isOff(extra: string | null | undefined): boolean {
  const text = extra?.trim().toLowerCase();
  return text === "off" || text === "none";
}

function splitUrls(value: string | null | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[\s,]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && part.toLowerCase() !== "off" && part.toLowerCase() !== "none");
}

function isTransientStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function isTransientRpcError(error: RpcErrorBody): boolean {
  const data = typeof error.data === "string" ? error.data : "";
  const message = error.message ?? "";
  const name = error.name ?? "";
  const blob = `${name} ${message} ${data}`.toLowerCase();
  return blob.includes("timeout") || blob.includes("timed out") || name === "TIMEOUT_ERROR";
}

function isTransientFetch(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "AbortError") return true;
  const text = `${error.name} ${error.message}`.toLowerCase();
  return (
    text.includes("timeout") ||
    text.includes("etimedout") ||
    text.includes("econnreset") ||
    text.includes("econnrefused") ||
    text.includes("fetch") ||
    text.includes("network") ||
    text.includes("aborted")
  );
}

function rpcErrorText(error: RpcErrorBody): string {
  if (typeof error.data === "string") return error.data;
  if (error.data !== undefined) return JSON.stringify(error.data);
  return error.message || "RPC error";
}
