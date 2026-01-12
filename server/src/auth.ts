import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const AUTH_BASE_URL = "https://app.letta.com";
const DEFAULT_API_BASE_URL = "https://api.letta.com";
const CLIENT_ID = "ci-let-724dea7e98f4af6f8f370f4b1466200c";

export type StoredAuth = {
  apiBaseUrl: string;
  accessToken: string;
  refreshToken?: string;
  accessTokenExpiresAt?: number;
  deviceId: string;
};

type DeviceCodeResponse = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
};

type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in: number;
  scope?: string;
};

type OAuthError = {
  error: string;
  error_description?: string;
};

export type PendingAuth =
  | {
      status: "pending";
      authId: string;
      verificationUrl: string;
      userCode: string;
      expiresAt: number;
    }
  | {
      status: "success";
      authId: string;
    }
  | {
      status: "error";
      authId: string;
      message: string;
    };

type PendingRecord = {
  authId: string;
  deviceCode: string;
  deviceId: string;
  intervalSec: number;
  expiresAt: number;
  userCode: string;
  verificationUrl: string;
  status: PendingAuth["status"];
  errorMessage?: string;
};

const pending = new Map<string, PendingRecord>();

function authFilePath(): string {
  const dir = path.join(os.homedir(), ".config", "letta-web-tui");
  return path.join(dir, "auth.json");
}

function ensureAuthDir(): string {
  const dir = path.dirname(authFilePath());
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function readStoredAuth(): StoredAuth | null {
  try {
    const p = authFilePath();
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, "utf8");
    const parsed = JSON.parse(raw) as Partial<StoredAuth>;
    if (!parsed || typeof parsed !== "object") return null;
    if (
      typeof parsed.accessToken !== "string" ||
      typeof parsed.deviceId !== "string"
    ) {
      return null;
    }
    const auth: StoredAuth = {
      apiBaseUrl:
        typeof parsed.apiBaseUrl === "string"
          ? parsed.apiBaseUrl
          : DEFAULT_API_BASE_URL,
      accessToken: parsed.accessToken,
      deviceId: parsed.deviceId,
    };

    if (typeof parsed.refreshToken === "string") {
      auth.refreshToken = parsed.refreshToken;
    }
    if (typeof parsed.accessTokenExpiresAt === "number") {
      auth.accessTokenExpiresAt = parsed.accessTokenExpiresAt;
    }

    return auth;
  } catch {
    return null;
  }
}

export function writeStoredAuth(auth: StoredAuth): void {
  ensureAuthDir();
  const p = authFilePath();
  const data = JSON.stringify(auth, null, 2);
  fs.writeFileSync(p, data, { mode: 0o600 });
}

export function clearStoredAuth(): void {
  try {
    fs.rmSync(authFilePath(), { force: true });
  } catch {
    // ignore
  }
}

async function requestDeviceCode(): Promise<DeviceCodeResponse> {
  const response = await fetch(`${AUTH_BASE_URL}/api/oauth/device/code`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: CLIENT_ID }),
  });

  if (!response.ok) {
    const error = (await response.json()) as OAuthError;
    throw new Error(
      error.error_description ||
        `Failed to request device code: ${error.error}`,
    );
  }

  return (await response.json()) as DeviceCodeResponse;
}

async function pollForToken(
  deviceCode: string,
  deviceId: string,
  intervalSec: number,
  expiresAt: number,
): Promise<TokenResponse> {
  const start = Date.now();
  let pollIntervalMs = Math.max(1, intervalSec) * 1000;

  while (Date.now() < expiresAt && Date.now() - start < 20 * 60 * 1000) {
    await new Promise((r) => setTimeout(r, pollIntervalMs));

    const response = await fetch(`${AUTH_BASE_URL}/api/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: CLIENT_ID,
        device_code: deviceCode,
        device_id: deviceId,
      }),
    });

    const result = (await response.json()) as TokenResponse | OAuthError;

    if (response.ok) {
      return result as TokenResponse;
    }

    const err = result as OAuthError;
    if (err.error === "authorization_pending") {
      continue;
    }
    if (err.error === "slow_down") {
      pollIntervalMs += 5000;
      continue;
    }
    throw new Error(err.error_description || `OAuth error: ${err.error}`);
  }

  throw new Error("Timed out waiting for Letta authorization");
}

export async function startDeviceLogin(
  apiBaseUrl?: string,
): Promise<PendingAuth> {
  const resolvedApiBaseUrl = apiBaseUrl?.trim() || DEFAULT_API_BASE_URL;
  const deviceId = readStoredAuth()?.deviceId ?? crypto.randomUUID();
  const dc = await requestDeviceCode();
  const authId = crypto.randomUUID();
  const expiresAt = Date.now() + dc.expires_in * 1000;

  const rec: PendingRecord = {
    authId,
    deviceCode: dc.device_code,
    deviceId,
    intervalSec: dc.interval,
    expiresAt,
    userCode: dc.user_code,
    verificationUrl: dc.verification_uri_complete,
    status: "pending",
  };
  pending.set(authId, rec);

  void (async () => {
    try {
      const token = await pollForToken(
        rec.deviceCode,
        rec.deviceId,
        rec.intervalSec,
        rec.expiresAt,
      );
      const accessTokenExpiresAt = Date.now() + token.expires_in * 1000;
      const next: StoredAuth = {
        apiBaseUrl: resolvedApiBaseUrl,
        accessToken: token.access_token,
        accessTokenExpiresAt,
        deviceId: rec.deviceId,
      };
      if (token.refresh_token) {
        next.refreshToken = token.refresh_token;
      }
      writeStoredAuth(next);
      rec.status = "success";
    } catch (err) {
      rec.status = "error";
      rec.errorMessage = err instanceof Error ? err.message : String(err);
    }
  })();

  return {
    status: "pending",
    authId,
    verificationUrl: dc.verification_uri_complete,
    userCode: dc.user_code,
    expiresAt,
  };
}

export function getPendingAuth(authId: string): PendingAuth | null {
  const rec = pending.get(authId);
  if (!rec) return null;
  if (rec.status === "pending") {
    return {
      status: "pending",
      authId: rec.authId,
      verificationUrl: rec.verificationUrl,
      userCode: rec.userCode,
      expiresAt: rec.expiresAt,
    };
  }
  if (rec.status === "success") {
    return { status: "success", authId: rec.authId };
  }
  return {
    status: "error",
    authId: rec.authId,
    message: rec.errorMessage ?? "Authentication failed",
  };
}

export async function revokeRefreshToken(refreshToken: string): Promise<void> {
  try {
    await fetch(`${AUTH_BASE_URL}/api/oauth/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        token: refreshToken,
        token_type_hint: "refresh_token",
      }),
    });
  } catch {
    // ignore
  }
}
