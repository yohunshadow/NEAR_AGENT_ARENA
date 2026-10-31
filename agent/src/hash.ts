import { createHash, randomBytes } from "node:crypto";
import { preimage } from "./rules.js";

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function commitmentHex(moveId: number, salt: Uint8Array, reasoning: string): string {
  return sha256Hex(preimage(moveId, salt, reasoning));
}

export function randomSalt(): Uint8Array {
  return new Uint8Array(randomBytes(32));
}
