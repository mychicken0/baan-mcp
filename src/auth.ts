// Built-in OAuth 2.1 authorization server. The "login" step is a password page served by baan itself,
// so users don't need Google Cloud, GitHub apps or any outside account. Clients (Gemini, Claude, ChatGPT...)
// register themselves with Dynamic Client Registration and use PKCE.
import type { Request, Response } from "express";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { InvalidGrantError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { Config } from "./config.ts";
import { State, randomToken, sha256, type TokenRecord } from "./state.ts";

interface Pending { clientId: string; params: AuthorizationParams; expires: number }
interface Code { clientId: string; params: AuthorizationParams; expires: number }

const PENDING_TTL = 10 * 60 * 1000;
const CODE_TTL = 2 * 60 * 1000;
export const LOGIN_PATH = "/baan/login";

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function loginPage(o: { id: string; clientName: string; redirectHost: string; error?: string }): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>baan — sign in</title><style>
body{font-family:system-ui,sans-serif;max-width:380px;margin:12vh auto;padding:0 20px;color:#222}
h1{font-size:1.4rem}.box{border:1px solid #ddd;border-radius:10px;padding:20px}
input{width:100%;padding:10px;font-size:1rem;box-sizing:border-box;margin:8px 0 14px}
button{padding:10px 16px;font-size:1rem;border-radius:8px;border:1px solid #888;cursor:pointer}
.go{background:#222;color:#fff;border-color:#222}.err{color:#b00020}.muted{color:#666;font-size:.9rem}
</style></head><body><h1>baan</h1><div class="box">
<p><b>${esc(o.clientName)}</b> wants to use the tools on this computer.</p>
<p class="muted">It will be sent back to <b>${esc(o.redirectHost)}</b>. Only allow apps you started connecting yourself.</p>
${o.error ? `<p class="err">${esc(o.error)}</p>` : ""}
<form method="post" action="${LOGIN_PATH}"><input type="hidden" name="request" value="${esc(o.id)}">
<label>Password<input type="password" name="password" autocomplete="current-password" autofocus></label>
<button class="go" name="action" value="allow">Allow</button> <button name="action" value="deny">Deny</button>
</form></div></body></html>`;
}

export class BaanAuthProvider implements OAuthServerProvider {
  private pending = new Map<string, Pending>();
  private codes = new Map<string, Code>();
  private failures: number[] = [];

  private state: State;
  private config: Config;

  constructor(state: State, config: Config) {
    this.state = state;
    this.config = config;
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    const s = this.state;
    return {
      getClient: (id: string) => s.data.clients[id],
      registerClient: (client) => {
        const full = client as OAuthClientInformationFull;
        s.data.clients[full.client_id] = full;
        s.save();
        return full;
      },
    };
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const now = Date.now();
    for (const [k, v] of this.pending) if (v.expires < now) this.pending.delete(k);
    const id = randomToken(24);
    this.pending.set(id, { clientId: client.client_id, params, expires: now + PENDING_TTL });
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Frame-Options", "DENY");
    res.type("html").send(loginPage({ id, clientName: client.client_name || "An app", redirectHost: new URL(params.redirectUri).host }));
  }

  /** POST /baan/login — password check, then redirect back to the client with a one-time code. */
  handleLogin = async (req: Request, res: Response): Promise<void> => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Frame-Options", "DENY");
    const id = String(req.body?.request ?? "");
    const p = this.pending.get(id);
    if (!p || p.expires < Date.now()) {
      res.status(400).type("text").send("This sign-in link expired. Go back to the app and connect again.");
      return;
    }
    const client = this.state.data.clients[p.clientId];
    const back = new URL(p.params.redirectUri);
    if (p.params.state !== undefined) back.searchParams.set("state", p.params.state);

    if (req.body?.action === "deny") {
      this.pending.delete(id);
      back.searchParams.set("error", "access_denied");
      res.redirect(302, back.href);
      return;
    }

    const { maxFailedLogins, lockoutSec } = this.config.auth;
    const now = Date.now();
    this.failures = this.failures.filter((t) => t > now - lockoutSec * 1000);
    const render = (error: string) =>
      res.status(401).type("html").send(loginPage({ id, clientName: client?.client_name || "An app", redirectHost: back.host, error }));
    if (this.failures.length >= maxFailedLogins) {
      render(`Too many wrong passwords. Try again in ${Math.ceil(lockoutSec / 60)} minutes.`);
      return;
    }
    if (!(await this.state.checkPassword(String(req.body?.password ?? "")))) {
      this.failures.push(now);
      console.warn(`[auth] wrong password (${this.failures.length}/${maxFailedLogins})`);
      render("Wrong password.");
      return;
    }

    this.pending.delete(id);
    const code = randomToken(32);
    this.codes.set(code, { clientId: p.clientId, params: p.params, expires: now + CODE_TTL });
    console.log(`[auth] approved client "${client?.client_name ?? p.clientId}"`);
    back.searchParams.set("code", code);
    res.redirect(302, back.href);
  };

  private takeCode(client: OAuthClientInformationFull, code: string, consume: boolean): Code {
    const c = this.codes.get(code);
    if (!c || c.expires < Date.now() || c.clientId !== client.client_id) throw new InvalidGrantError("Invalid or expired authorization code");
    if (consume) this.codes.delete(code);
    return c;
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    return this.takeCode(client, code, false).params.codeChallenge;
  }

  private issue(clientId: string, scopes: string[], resource?: string): OAuthTokens {
    const now = Math.floor(Date.now() / 1000);
    const { accessTokenTtlSec, refreshTokenTtlSec } = this.config.auth;
    const access = randomToken(32);
    const refresh = randomToken(32);
    this.state.data.accessTokens[sha256(access)] = { clientId, scopes, resource, expiresAt: now + accessTokenTtlSec };
    this.state.data.refreshTokens[sha256(refresh)] = { clientId, scopes, resource, expiresAt: now + refreshTokenTtlSec };
    this.state.save();
    return { access_token: access, token_type: "bearer", expires_in: accessTokenTtlSec, refresh_token: refresh, scope: scopes.join(" ") || undefined };
  }

  async exchangeAuthorizationCode(client: OAuthClientInformationFull, code: string, _verifier?: string, redirectUri?: string, resource?: URL): Promise<OAuthTokens> {
    const c = this.takeCode(client, code, true);
    if (redirectUri && redirectUri !== c.params.redirectUri) throw new InvalidGrantError("redirect_uri does not match");
    return this.issue(client.client_id, c.params.scopes ?? [], (resource ?? c.params.resource)?.href);
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, scopes?: string[]): Promise<OAuthTokens> {
    const key = sha256(refreshToken);
    const r: TokenRecord | undefined = this.state.data.refreshTokens[key];
    if (!r || r.clientId !== client.client_id || r.expiresAt < Date.now() / 1000) throw new InvalidGrantError("Invalid refresh token");
    delete this.state.data.refreshTokens[key]; // rotate
    const keep = scopes?.length ? scopes.filter((s) => r.scopes.includes(s)) : r.scopes;
    return this.issue(client.client_id, keep, r.resource);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const r = this.state.data.accessTokens[sha256(token)];
    if (!r || r.expiresAt < Date.now() / 1000) throw new InvalidTokenError("Invalid or expired token");
    return { token, clientId: r.clientId, scopes: r.scopes, expiresAt: r.expiresAt, resource: r.resource ? new URL(r.resource) : undefined };
  }

  async revokeToken(client: OAuthClientInformationFull, req: OAuthTokenRevocationRequest): Promise<void> {
    const key = sha256(req.token);
    for (const bag of [this.state.data.accessTokens, this.state.data.refreshTokens])
      if (bag[key]?.clientId === client.client_id) delete bag[key];
    this.state.save();
  }
}
