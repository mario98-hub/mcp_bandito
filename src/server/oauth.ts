/**
 * OAuth 2.0 Resource Server helpers for a hosted Conti.
 *
 * Identity is delegated to an external Authorization Server (an IdP); this
 * server only *verifies* the access token it receives and maps the token's
 * subject to a tenant. The JWT/JWKS verification is built on `node:crypto`, so
 * there is no extra dependency. The verifier implements the SDK's
 * `OAuthTokenVerifier` and throws `OAuthError(InvalidToken)` on any problem, so
 * the bearer-auth middleware answers `401` with the right `WWW-Authenticate`
 * challenge.
 */
import { createPublicKey, createHash, verify as cryptoVerify, type KeyObject, type JsonWebKeyInput } from 'node:crypto';
import { OAuthError, OAuthErrorCode, type AuthInfo, type OAuthMetadata, type OAuthTokenVerifier } from '@modelcontextprotocol/server';
import { DEFAULT_TENANT } from '../store/store.js';

type Jwk = { kid?: string; kty: string; alg?: string; use?: string; n?: string; e?: string; crv?: string; x?: string; y?: string };

/** Supported JWS algorithms → digest + whether it is an EC (raw r||s) signature. */
const ALGS: Record<string, { hash: 'sha256' | 'sha384' | 'sha512'; ec?: boolean }> = {
  RS256: { hash: 'sha256' },
  RS384: { hash: 'sha384' },
  RS512: { hash: 'sha512' },
  ES256: { hash: 'sha256', ec: true },
  ES384: { hash: 'sha384', ec: true },
  ES512: { hash: 'sha512', ec: true },
};

const b64urlToBuf = (s: string) => Buffer.from(s, 'base64url');
const b64urlToJson = (s: string) => JSON.parse(b64urlToBuf(s).toString('utf8'));

export interface JwtVerifierConfig {
  /** Expected token issuer (the `iss` claim); identifies the Authorization Server. */
  issuer: string;
  /** JWKS source: a URL to fetch and cache (production) or static keys (tests). */
  jwks: { uri: string } | { keys: Jwk[] };
  /** Expected audience (RFC 8707 resource id). When set, the token's `aud` must include it. */
  audience?: string;
  /** Resource identifier stamped on `AuthInfo.resource`. Defaults to `audience`. */
  resource?: string;
  /** JWKS cache TTL in ms (remote only). Default 10 minutes. */
  jwksTtlMs?: number;
}

/** Stable, opaque tenant id for an authenticated user: `u:` + a hash of issuer + subject. */
export function tenantForUser(issuer: string, subject: string): string {
  return 'u:' + createHash('sha256').update(`${issuer}\n${subject}`).digest('base64url').slice(0, 24);
}

/** The tenant an authenticated request belongs to; the default tenant for the self-host / secret-link path. */
export function tenantOf(authInfo: AuthInfo | undefined): string {
  const t = authInfo?.extra?.tenant;
  return typeof t === 'string' && t ? t : DEFAULT_TENANT;
}

function importJwk(jwk: Jwk): KeyObject {
  return createPublicKey({ key: jwk, format: 'jwk' } as unknown as JsonWebKeyInput);
}

/** Build an access-token verifier. Fully offline when given static `jwks.keys`. */
export function createJwtVerifier(cfg: JwtVerifierConfig): OAuthTokenVerifier {
  const ttl = cfg.jwksTtlMs ?? 10 * 60 * 1000;
  let cache: { at: number; keys: Jwk[] } | null = null;

  async function keys(force = false): Promise<Jwk[]> {
    if ('keys' in cfg.jwks) return cfg.jwks.keys;
    const now = Date.now();
    if (!force && cache && now - cache.at < ttl) return cache.keys;
    let res: Response;
    try {
      res = await fetch(cfg.jwks.uri, { headers: { accept: 'application/json' } });
    } catch (e) {
      throw new OAuthError(OAuthErrorCode.ServerError, `Could not reach JWKS endpoint: ${(e as Error).message}`);
    }
    if (!res.ok) throw new OAuthError(OAuthErrorCode.ServerError, `JWKS fetch failed (${res.status})`);
    const json = (await res.json()) as { keys?: Jwk[] };
    cache = { at: now, keys: json.keys ?? [] };
    return cache.keys;
  }

  async function findKey(kid: string | undefined, alg: string): Promise<KeyObject> {
    const pick = (ks: Jwk[]) => ks.find((k) => (kid ? k.kid === kid : true) && (!k.alg || k.alg === alg) && (!k.use || k.use === 'sig'));
    let jwk = pick(await keys());
    if (!jwk) jwk = pick(await keys(true)); // refresh once on a miss (handles key rotation)
    if (!jwk) throw new OAuthError(OAuthErrorCode.InvalidToken, 'No matching signing key for the token');
    return importJwk(jwk);
  }

  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      const parts = token.split('.');
      if (parts.length !== 3) throw new OAuthError(OAuthErrorCode.InvalidToken, 'Malformed bearer token');
      const [h, p, s] = parts;
      let header: { alg?: string; kid?: string };
      let claims: Record<string, unknown>;
      try {
        header = b64urlToJson(h!);
        claims = b64urlToJson(p!);
      } catch {
        throw new OAuthError(OAuthErrorCode.InvalidToken, 'Unparseable bearer token');
      }
      const spec = header.alg ? ALGS[header.alg] : undefined;
      if (!spec) throw new OAuthError(OAuthErrorCode.InvalidToken, `Unsupported token algorithm: ${header.alg}`);

      const key = await findKey(header.kid, header.alg!);
      const data = Buffer.from(`${h}.${p}`);
      const sig = b64urlToBuf(s!);
      const valid = spec.ec
        ? cryptoVerify(spec.hash, data, { key, dsaEncoding: 'ieee-p1363' }, sig)
        : cryptoVerify(spec.hash, data, key, sig);
      if (!valid) throw new OAuthError(OAuthErrorCode.InvalidToken, 'Bad token signature');

      const now = Math.floor(Date.now() / 1000);
      const exp = claims.exp;
      if (typeof exp !== 'number' || exp <= now) throw new OAuthError(OAuthErrorCode.InvalidToken, 'Token has expired');
      if (typeof claims.nbf === 'number' && claims.nbf > now + 60) throw new OAuthError(OAuthErrorCode.InvalidToken, 'Token not yet valid');
      if (cfg.issuer && claims.iss !== cfg.issuer) throw new OAuthError(OAuthErrorCode.InvalidToken, 'Token issuer mismatch');
      if (cfg.audience) {
        const aud = Array.isArray(claims.aud) ? claims.aud : claims.aud != null ? [claims.aud] : [];
        if (!aud.includes(cfg.audience)) throw new OAuthError(OAuthErrorCode.InvalidToken, 'Token audience mismatch');
      }
      const sub = typeof claims.sub === 'string' ? claims.sub : '';
      if (!sub) throw new OAuthError(OAuthErrorCode.InvalidToken, 'Token has no subject');

      const scopes =
        typeof claims.scope === 'string' ? claims.scope.split(' ').filter(Boolean) : Array.isArray(claims.scopes) ? (claims.scopes as string[]) : [];
      const resource = cfg.resource ?? cfg.audience;
      return {
        token,
        clientId: String(claims.client_id ?? claims.azp ?? claims.cid ?? sub),
        scopes,
        expiresAt: exp,
        resource: resource ? new URL(resource) : undefined,
        extra: {
          sub,
          iss: typeof claims.iss === 'string' ? claims.iss : cfg.issuer,
          email: claims.email,
          name: claims.name,
          tenant: tenantForUser(cfg.issuer, sub),
        },
      };
    },
  };
}

export interface OAuthServerConfig {
  /** The Authorization Server issuer URL (e.g. https://auth.example.com). */
  issuer: string;
  /** Expected audience / RFC 8707 resource id (usually this MCP server's public URL). */
  audience?: string;
  /** Resource id stamped on AuthInfo.resource; defaults to `audience`. */
  resource?: string;
}

/**
 * Discover an Authorization Server's metadata (OIDC / RFC 8414) from its issuer
 * and build a verifier from the advertised JWKS. Called once at startup; throws
 * on a misconfigured or unreachable issuer so the server fails fast.
 */
export async function discoverOAuth(cfg: OAuthServerConfig): Promise<{ metadata: OAuthMetadata; verifier: OAuthTokenVerifier }> {
  const base = cfg.issuer.replace(/\/+$/, '');
  const candidates = [`${base}/.well-known/openid-configuration`, `${base}/.well-known/oauth-authorization-server`];
  let metadata: Record<string, unknown> | null = null;
  let lastErr: unknown;
  for (const url of candidates) {
    try {
      const r = await fetch(url, { headers: { accept: 'application/json' } });
      if (r.ok) {
        metadata = (await r.json()) as Record<string, unknown>;
        break;
      }
      lastErr = new Error(`${url} → ${r.status}`);
    } catch (e) {
      lastErr = e;
    }
  }
  if (!metadata) throw new Error(`Could not fetch OAuth metadata for issuer ${cfg.issuer}: ${lastErr}`);
  const jwksUri = metadata.jwks_uri;
  if (typeof jwksUri !== 'string') throw new Error(`OAuth metadata for ${cfg.issuer} has no jwks_uri`);
  const issuer = typeof metadata.issuer === 'string' ? metadata.issuer : cfg.issuer;
  const verifier = createJwtVerifier({ issuer, jwks: { uri: jwksUri }, audience: cfg.audience, resource: cfg.resource });
  return { metadata: metadata as unknown as OAuthMetadata, verifier };
}
