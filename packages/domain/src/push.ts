import type { FlareMoDb, PushSubscriptionRow, UserRow } from "@flaremo/db";
import { pushSubscriptions } from "@flaremo/db";
import { and, eq } from "drizzle-orm";

/**
 * Web Push (RFC 8030 / RFC 8291 / RFC 8292) for proactive reminders.
 * Implemented directly on WebCrypto so it runs inside the Worker without a
 * Node dependency: an ES256 VAPID JWT plus the aes128gcm payload envelope.
 * Both VAPID keys must be configured (FLAREMO_VAPID_PUBLIC_KEY /
 * FLAREMO_VAPID_PRIVATE_KEY); without them push is disabled end-to-end.
 */

export type PushKeys = {
  publicKey: string;
  privateKey: string;
};

export type PushPayload = {
  title: string;
  body: string;
  /** App path to open when the notification is clicked. */
  url?: string;
};

export function pushKeysConfigured(keys: PushKeys | null): boolean {
  return Boolean(keys?.publicKey && keys?.privateKey);
}

function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(
    normalized.length + ((4 - (normalized.length % 4)) % 4),
    "=",
  );
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

// ---------------------------------------------------------------------------
// Subscription storage
// ---------------------------------------------------------------------------

export async function listPushSubscriptions(
  db: FlareMoDb,
  userId: string,
): Promise<PushSubscriptionRow[]> {
  return db
    .select()
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.userId, userId));
}

export async function savePushSubscription(
  db: FlareMoDb,
  user: UserRow,
  input: { endpoint: string; p256dh: string; auth: string },
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .insert(pushSubscriptions)
    .values({
      id: `push/${crypto.randomUUID()}`,
      userId: user.id,
      endpoint: input.endpoint,
      p256dh: input.p256dh,
      auth: input.auth,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: pushSubscriptions.endpoint,
      set: { p256dh: input.p256dh, auth: input.auth, updatedAt: now },
    });
}

export async function deletePushSubscription(
  db: FlareMoDb,
  user: UserRow,
  endpoint: string,
): Promise<void> {
  await db
    .delete(pushSubscriptions)
    .where(
      and(
        eq(pushSubscriptions.userId, user.id),
        eq(pushSubscriptions.endpoint, endpoint),
      ),
    );
}

/** Send a payload to every subscription; dead endpoints are pruned. */
export async function pushNotificationToUser(
  db: FlareMoDb,
  keys: PushKeys,
  userId: string,
  payload: PushPayload,
): Promise<number> {
  const subscriptions = await listPushSubscriptions(db, userId);
  if (subscriptions.length === 0) return 0;
  let delivered = 0;
  for (const subscription of subscriptions) {
    try {
      await sendWebPush(
        keys,
        {
          endpoint: subscription.endpoint,
          p256dh: subscription.p256dh,
          auth: subscription.auth,
        },
        payload,
      );
      delivered += 1;
    } catch (error) {
      // 404/410 mean the browser is gone; drop the subscription row.
      if (error instanceof PushEndpointExpiredError) {
        await db
          .delete(pushSubscriptions)
          .where(eq(pushSubscriptions.id, subscription.id));
      }
    }
  }
  return delivered;
}

export class PushEndpointExpiredError extends Error {}

// ---------------------------------------------------------------------------
// Crypto: VAPID JWT (ES256) + RFC 8291 aes128gcm envelope
// ---------------------------------------------------------------------------

async function importVapidPrivateKey(privateKeyBase64Url: string) {
  const raw = base64UrlToBytes(privateKeyBase64Url);
  // Accept both a 32-byte scalar (standard web-push format) and a PKCS#8 DER.
  if (raw.length === 32) {
    // Build a minimal PKCS#8 wrapper so WebCrypto can import the raw scalar.
    const pkcs8 = new Uint8Array(48);
    pkcs8.set([0x30, 0x2e, 0x02, 0x01, 0x01, 0x04, 0x20], 0);
    pkcs8.set(raw, 7);
    return crypto.subtle.importKey(
      "pkcs8",
      pkcs8,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
  }
  return crypto.subtle.importKey(
    "pkcs8",
    raw as unknown as ArrayBuffer,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
}

async function signVapidJwt(
  keys: PushKeys,
  audience: string,
  now: number,
): Promise<string> {
  const header = bytesToBase64Url(
    new TextEncoder().encode(JSON.stringify({ typ: "JWT", alg: "ES256" })),
  );
  const claims = bytesToBase64Url(
    new TextEncoder().encode(
      JSON.stringify({
        aud: audience,
        exp: now + 12 * 60 * 60,
        sub: "mailto:flaremo@localhost",
      }),
    ),
  );
  const key = await importVapidPrivateKey(keys.privateKey);
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      new TextEncoder().encode(`${header}.${claims}`),
    ),
  );
  return `${header}.${claims}.${bytesToBase64Url(signature)}`;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * Encrypt a Web Push payload with the RFC 8291 aes128gcm scheme. Returns the
 * RFC 8291 binary body (salt + rs + id-length + ciphertext).
 */
export async function encryptPushPayload(
  p256dhBase64Url: string,
  authBase64Url: string,
  payload: PushPayload,
): Promise<Uint8Array> {
  const { body } = await encryptPushPayloadForTest(
    p256dhBase64Url,
    authBase64Url,
    payload,
  );
  return body;
}

export type EncryptPushResult = {
  body: Uint8Array;
  serverPublicKey: Uint8Array;
};

/** Full envelope plus the ephemeral server public key, for test round-trips. */
export async function encryptPushPayloadForTest(
  p256dhBase64Url: string,
  authBase64Url: string,
  payload: PushPayload,
): Promise<EncryptPushResult> {
  // Ephemeral server key pair for this message.
  const serverKeys = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  const serverPublicKey = new Uint8Array(
    await crypto.subtle.exportKey("raw", serverKeys.publicKey),
  );

  const clientPublicKey = base64UrlToBytes(p256dhBase64Url);
  const authSecret = base64UrlToBytes(authBase64Url);

  // ECDH shared secret with the client's public key.
  const clientKey = await crypto.subtle.importKey(
    "raw",
    clientPublicKey as unknown as BufferSource,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: clientKey },
      serverKeys.privateKey,
      256,
    ),
  );

  const encoder = new TextEncoder();
  const clientPub = clientPublicKey;
  const serverPub = serverPublicKey;
  // RFC 8291 IKM: HKDF(auth secret, ECDH secret, "WebPush: info" || 0x00 ||
  // (0x02 for aes128gcm) || client pubkey || server pubkey).
  const infoKey = concatBytes(
    encoder.encode("WebPush: info\x00"),
    // 0x02 = aes128gcm content-encoding key (RFC 8291 §4.2).
    new Uint8Array([2]),
    clientPub,
    serverPub,
  );
  const ikm = await hkdfBytes(ecdhSecret, authSecret, infoKey, 32);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdfBytes(
    ikm,
    salt,
    encoder.encode("Content-Encoding: aes128gcm\x00"),
    16,
  );
  const nonce = await hkdfBytes(
    ikm,
    salt,
    encoder.encode("Content-Encoding: nonce\x00"),
    12,
  );

  const plaintext = encoder.encode(JSON.stringify(payload));
  // RFC 8291 padding: a 0x01 delimiter followed by zeros.
  const padded = new Uint8Array(1 + plaintext.length);
  padded[0] = 2; // last-record delimiters flag (single record)
  padded.set(plaintext, 1);

  const keyData = await crypto.subtle.importKey(
    "raw",
    cek as unknown as BufferSource,
    "AES-GCM",
    false,
    ["encrypt"],
  );
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce as unknown as BufferSource },
      keyData,
      padded as unknown as BufferSource,
    ),
  );

  // Envelope: salt(16) + rs(4, big-endian) + id length(1) + key id (empty).
  const rs = 4096;
  if (plaintext.length > rs - 17) {
    throw new Error("Web Push payload exceeds a single aes128gcm record");
  }
  const header = new Uint8Array(21);
  header.set(salt, 0);
  header[16] = (rs >>> 24) & 0xff;
  header[17] = (rs >>> 16) & 0xff;
  header[18] = (rs >>> 8) & 0xff;
  header[19] = rs & 0xff;
  header[20] = 0; // zero-length key id
  const body = new Uint8Array(header.length + ciphertext.length);
  body.set(header, 0);
  body.set(ciphertext, header.length);
  return { body, serverPublicKey: serverPub };
}

async function hkdfBytes(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    ikm as unknown as BufferSource,
    "HKDF",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: salt as unknown as BufferSource,
      info: info as unknown as BufferSource,
    },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

/** Push one encrypted payload to a browser endpoint. */
export async function sendWebPush(
  keys: PushKeys,
  subscription: { endpoint: string; p256dh: string; auth: string },
  payload: PushPayload,
): Promise<void> {
  const audience = new URL(subscription.endpoint).origin;
  const now = Date.now();
  const jwt = await signVapidJwt(keys, audience, now);
  const body = await encryptPushPayload(
    subscription.p256dh,
    subscription.auth,
    payload,
  );
  const response = await fetch(subscription.endpoint, {
    method: "POST",
    headers: {
      authorization: `vapid t=${jwt}, k=${keys.publicKey}`,
      "content-encoding": "aes128gcm",
      ttl: "2419200",
      urgency: "normal",
    },
    body: body as unknown as BodyInit,
  });
  if (response.status === 404 || response.status === 410) {
    throw new PushEndpointExpiredError("push subscription expired");
  }
  if (!response.ok) {
    throw new Error(`push delivery failed: http_${response.status}`);
  }
}

// ---------------------------------------------------------------------------
// Cron wiring helpers
// ---------------------------------------------------------------------------

/**
 * Push today's review + overdue-task reminder to every subscription of the
 * users who received new notifications. Fire-and-forget: push failures never
 * affect the notification rows.
 */
export async function pushReminders(
  db: FlareMoDb,
  keys: PushKeys,
  entries: Array<{ userId: string; payload: PushPayload }>,
): Promise<void> {
  if (!pushKeysConfigured(keys)) return;
  for (const entry of entries) {
    await pushNotificationToUser(db, keys, entry.userId, entry.payload).catch(
      () => undefined,
    );
  }
}
