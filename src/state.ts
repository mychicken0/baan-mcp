// Small JSON state file (password hash, OAuth clients, hashed tokens) so restarts don't disconnect clients.
import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export interface TokenRecord { clientId: string; scopes: string[]; expiresAt: number; resource?: string }

export interface StateData {
  passwordHash?: string;
  clients: Record<string, OAuthClientInformationFull>;
  accessTokens: Record<string, TokenRecord>;
  refreshTokens: Record<string, TokenRecord>;
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");

export class State {
  readonly file: string;
  data: StateData;

  constructor(dataDir: string) {
    this.file = join(dataDir, "state.json");
    this.data = existsSync(this.file)
      ? { clients: {}, accessTokens: {}, refreshTokens: {}, ...JSON.parse(readFileSync(this.file, "utf8")) }
      : { clients: {}, accessTokens: {}, refreshTokens: {} };
  }

  save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const now = Date.now() / 1000;
    for (const bag of [this.data.accessTokens, this.data.refreshTokens])
      for (const [k, v] of Object.entries(bag)) if (v.expiresAt < now) delete bag[k];
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
    try { chmodSync(this.file, 0o600); } catch { /* not supported on Windows */ }
  }

  async setPassword(password: string): Promise<void> {
    const salt = randomBytes(16);
    const hash = await scryptAsync(password.normalize("NFKC"), salt, 32);
    this.data.passwordHash = `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
    // A new password signs out every connected client.
    this.data.accessTokens = {};
    this.data.refreshTokens = {};
    this.save();
  }

  async checkPassword(password: string): Promise<boolean> {
    const [kind, salt, hash] = (this.data.passwordHash ?? "").split("$");
    if (kind !== "scrypt" || !salt || !hash) return false;
    const expected = Buffer.from(hash, "base64");
    const got = await scryptAsync(password.normalize("NFKC"), Buffer.from(salt, "base64"), expected.length);
    return timingSafeEqual(got, expected);
  }
}
