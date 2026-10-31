import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface PendingReveal {
  move: number;
  saltHex: string;
  reasoning: string;
  commitmentHex: string;
}

export class RevealStore {
  private readonly path: string;
  private data: Record<string, PendingReveal>;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.path = join(dir, "reveals.json");
    try {
      this.data = JSON.parse(readFileSync(this.path, "utf8")) as Record<string, PendingReveal>;
    } catch {
      this.data = {};
    }
  }

  key(roundId: number, agentId: number): string {
    return `${roundId}:${agentId}`;
  }

  get(roundId: number, agentId: number): PendingReveal | undefined {
    return this.data[this.key(roundId, agentId)];
  }

  save(roundId: number, agentId: number, pending: PendingReveal): void {
    this.data[this.key(roundId, agentId)] = pending;
    writeFileSync(this.path, JSON.stringify(this.data, null, 2));
  }
}
