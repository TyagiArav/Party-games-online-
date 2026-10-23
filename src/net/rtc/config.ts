/**
 * WebRTC transport settings (static site). Change them here, or at build time with env vars
 * (GitHub Actions passes repository variables of the same names, see .github/workflows/deploy.yml):
 *
 *   VITE_ICE_SERVERS  JSON RTCIceServer[]  e.g. add a TURN server:
 *                     [{"urls":"stun:stun.l.google.com:19302"},
 *                      {"urls":"turn:turn.example.com:3478","username":"u","credential":"p"}]
 *   VITE_TURN_URL     URL that returns TURN credentials as JSON (an RTCIceServer[] like Metered's
 *                     /api/v1/turn/credentials?apiKey=…, or Cloudflare-style {"iceServers": …}).
 *                     Fetched once per page; its servers are added to VITE_ICE_SERVERS / the defaults.
 *   VITE_PEERJS       comma-separated PeerJS server WebSocket URLs (primary signalling)
 *   VITE_NOSTR        comma-separated Nostr relay URLs (fallback signalling)
 *
 * Test/debug only: the same four can be overridden per page with `?ice=`, `?turn=`, `?peerjs=`, `?nostr=`
 * (an empty value disables that signaller). The host copies these overrides into the phones' join
 * link so both ends use the same services.
 */

export interface RtcConfig {
  iceServers: RTCIceServer[];
  /** TURN credentials endpoint ('' = none). Its servers are appended to `iceServers`. */
  turnUrl: string;
  /** PeerJS-protocol signalling servers, as WebSocket URLs with `key` (no id/token). Tried in order. */
  peerjs: string[];
  /** Nostr relays (all used at once). */
  nostr: string[];
}

/**
 * Free public STUN lets phones find a direct route (same Wi-Fi, and many home networks). When no direct
 * route exists (phone on mobile data or another Wi-Fi, guest Wi-Fi with client isolation, carrier NAT)
 * the free public Open Relay TURN server relays the traffic instead, over UDP, TCP or TLS on ports the
 * strictest networks still allow. It is a best-effort community service: for a reliable relay set
 * VITE_TURN_URL (or VITE_ICE_SERVERS) to your own TURN account.
 */
const DEFAULT_ICE: RTCIceServer[] = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  { urls: 'stun:stun.cloudflare.com:3478' },
  {
    urls: [
      'turn:openrelay.metered.ca:80',
      'turn:openrelay.metered.ca:443',
      'turn:openrelay.metered.ca:443?transport=tcp',
      'turns:openrelay.metered.ca:443?transport=tcp',
    ],
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
];

/** Longest a join waits for the TURN credentials endpoint before going on without it. */
const TURN_FETCH_MS = 4000;

/** The free public PeerJS cloud server (no account). */
const DEFAULT_PEERJS = ['wss://0.peerjs.com/peerjs?key=peerjs'];

/** Free public Nostr relays (no account). Used as a fallback channel when PeerJS is down. */
const DEFAULT_NOSTR = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net', 'wss://relay.nostr.band'];

/** Query parameters that override the config (and get copied into join links). */
export const RTC_OVERRIDE_PARAMS = ['ice', 'turn', 'peerjs', 'nostr'] as const;

function list(v: string | undefined | null): string[] | null {
  if (v === undefined || v === null) return null;
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function ice(v: string | undefined | null): RTCIceServer[] | null {
  if (!v) return null;
  try {
    const parsed: unknown = JSON.parse(v);
    if (Array.isArray(parsed)) return parsed as RTCIceServer[];
  } catch {
    console.warn('[rtc] ignoring invalid ICE server JSON');
  }
  return null;
}

function query(): URLSearchParams {
  try {
    return new URLSearchParams(window.location.search);
  } catch {
    return new URLSearchParams();
  }
}

export function rtcConfig(): RtcConfig {
  const q = query();
  const env = import.meta.env;
  return {
    iceServers: ice(q.get('ice')) ?? ice(env.VITE_ICE_SERVERS) ?? DEFAULT_ICE,
    turnUrl: (q.get('turn') ?? env.VITE_TURN_URL ?? '').trim(),
    // An empty build variable means "not set" (CI passes unset repository variables as ''); an empty
    // URL override means "disable this signaller".
    peerjs: list(q.get('peerjs')) ?? list(env.VITE_PEERJS || null) ?? DEFAULT_PEERJS,
    nostr: list(q.get('nostr')) ?? list(env.VITE_NOSTR || null) ?? DEFAULT_NOSTR,
  };
}

/** `RTCIceServer[]` out of a credentials response: a bare list, or `{iceServers: list | one}`. */
function turnServers(body: unknown): RTCIceServer[] {
  const raw = body && typeof body === 'object' && 'iceServers' in body ? (body as { iceServers: unknown }).iceServers : body;
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? [raw] : [];
  return list.filter((s): s is RTCIceServer => !!s && typeof s === 'object' && 'urls' in s);
}

let turnFetch: { url: string; servers: Promise<RTCIceServer[]> } | null = null;

/**
 * The ICE servers to connect with: `cfg.iceServers` plus the ones from `cfg.turnUrl` (fetched once per
 * page). Never rejects and never waits longer than TURN_FETCH_MS: a dead endpoint only costs the relay.
 */
export function resolveIceServers(cfg: RtcConfig): Promise<RTCIceServer[]> {
  if (!cfg.turnUrl) return Promise.resolve(cfg.iceServers);
  if (!turnFetch || turnFetch.url !== cfg.turnUrl) {
    const ctl = new AbortController();
    const timer = window.setTimeout(() => ctl.abort(), TURN_FETCH_MS);
    const servers = fetch(cfg.turnUrl, { signal: ctl.signal, cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(turnServers)
      .catch((err: unknown) => {
        console.warn('[rtc] TURN credentials unavailable, continuing without them:', err);
        turnFetch = null; // try again on the next connection
        return [] as RTCIceServer[];
      })
      .finally(() => window.clearTimeout(timer));
    turnFetch = { url: cfg.turnUrl, servers };
  }
  return turnFetch.servers.then((extra) => [...cfg.iceServers, ...extra]);
}

/** `&peerjs=…&nostr=…` for the overrides present on this page ('' if none). */
export function rtcOverrideQuery(): string {
  const q = query();
  let out = '';
  for (const k of RTC_OVERRIDE_PARAMS) {
    const v = q.get(k);
    if (v !== null) out += `&${k}=${encodeURIComponent(v)}`;
  }
  return out;
}

/** Signalling id of the host page for a room code. Namespaced: the public servers are shared with other apps. */
export function hostPeerId(room: string): string {
  return `partyhub-mz5-v1-${room.toUpperCase()}`;
}
