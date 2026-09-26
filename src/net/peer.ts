/**
 * WebRTC connections via PeerJS.
 *
 * Signaling uses the free public PeerJS broker by default (best-effort, no
 * guarantees) or a self-hosted PeerJS server configured at build time with
 * VITE_PEER_HOST / VITE_PEER_PORT / VITE_PEER_PATH / VITE_PEER_SECURE /
 * VITE_PEER_KEY. Only public STUN servers are used: no TURN relay, so photos
 * travel directly phone-to-phone and never touch a server.
 */
import { Peer, type DataConnection, type PeerOptions } from 'peerjs';
import { Emitter, type Link, type WireData } from '../core/link';
import { formatRoomCode, peerIdForRoom } from '../core/roomCode';

export const ICE_SERVERS: RTCIceServer[] = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

export interface SignalingConfig {
  host?: string;
  port?: number;
  path?: string;
  secure?: boolean;
  key?: string;
}

export function signalingFromEnv(): SignalingConfig {
  const env = import.meta.env;
  const cfg: SignalingConfig = {};
  if (env.VITE_PEER_HOST) cfg.host = env.VITE_PEER_HOST;
  if (env.VITE_PEER_PORT) cfg.port = Number(env.VITE_PEER_PORT);
  if (env.VITE_PEER_PATH) cfg.path = env.VITE_PEER_PATH;
  if (env.VITE_PEER_SECURE) cfg.secure = env.VITE_PEER_SECURE !== 'false';
  if (env.VITE_PEER_KEY) cfg.key = env.VITE_PEER_KEY;
  return cfg;
}

export const usingPublicBroker = (cfg: SignalingConfig = signalingFromEnv()) => !cfg.host;

function peerOptions(cfg: SignalingConfig): PeerOptions {
  return { ...cfg, config: { iceServers: ICE_SERVERS }, debug: 1 } as PeerOptions;
}

/** Readable explanations for PeerJS error types. */
export function explainPeerError(type: string, roomCode?: string): string {
  switch (type) {
    case 'browser-incompatible':
      return "This browser can't make direct phone-to-phone connections (WebRTC). Try Chrome or Safari.";
    case 'peer-unavailable':
      return roomCode
        ? `No moment with code ${formatRoomCode(roomCode)} is open. Check the code, and ask the host to keep their screen on.`
        : 'The host is not reachable any more.';
    case 'network':
    case 'server-error':
    case 'socket-error':
    case 'socket-closed':
      return "Can't reach the connection service. Check your internet connection and try again — or use manual mode.";
    case 'ssl-unavailable':
      return 'Secure connections are unavailable here.';
    case 'webrtc':
      return 'The direct connection failed. Join the same Wi-Fi as the host (or the host’s hotspot) and try again — or use manual mode.';
    default:
      return 'Something went wrong while connecting.';
  }
}

export class ConnectError extends Error {
  constructor(
    message: string,
    readonly kind: 'not-found' | 'signaling' | 'ice' | 'timeout' | 'unsupported' | 'other',
  ) {
    super(message);
  }
}

const ICE_HELP =
  'Your phone found the host but could not connect directly. Join the same Wi-Fi as the host (or turn on the host’s hotspot and join it), then try again — or use manual mode.';

/** A PeerJS data connection presented as a Link. */
class PeerLink implements Link {
  readonly id: string;
  private readonly messages = new Emitter<[WireData]>();
  private readonly closes = new Emitter<[]>();
  private closed = false;
  private iceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly conn: DataConnection) {
    this.id = conn.connectionId;
    conn.on('data', (data) => {
      if (typeof data === 'string' || data instanceof ArrayBuffer) this.messages.emit(data);
      else if (ArrayBuffer.isView(data)) {
        const view = data as ArrayBufferView;
        this.messages.emit(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer);
      }
    });
    conn.on('close', () => this.markClosed());
    conn.on('error', () => this.close());
    conn.on('iceStateChanged', (state) => {
      if (state === 'failed' || state === 'closed') this.close();
      else if (state === 'disconnected') {
        // Often recovers (Wi-Fi hiccup); give it a few seconds.
        if (!this.iceTimer) this.iceTimer = setTimeout(() => this.close(), 8000);
      } else if (this.iceTimer) {
        clearTimeout(this.iceTimer);
        this.iceTimer = null;
      }
    });
  }

  send(data: WireData): void {
    if (this.closed) throw new Error('connection closed');
    void this.conn.send(data);
  }

  bufferedAmount(): number {
    return this.conn.dataChannel?.bufferedAmount ?? 0;
  }

  isOpen(): boolean {
    return !this.closed && this.conn.open;
  }

  onMessage(cb: (data: WireData) => void): () => void {
    return this.messages.on(cb);
  }

  onClose(cb: () => void): () => void {
    return this.closes.on(cb);
  }

  close(): void {
    if (this.closed) return;
    try {
      this.conn.close();
    } catch {
      /* already gone */
    }
    this.markClosed();
  }

  private markClosed(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.iceTimer) clearTimeout(this.iceTimer);
    this.closes.emit();
    this.messages.clear();
  }
}

export type SignalingStatus = 'online' | 'reconnecting' | 'offline';

/** The host's presence on the signaling server under the room's peer ID. */
export class HostSignaling {
  readonly connections = new Emitter<[Link]>();
  readonly statusChanged = new Emitter<[SignalingStatus]>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  private constructor(
    readonly code: string,
    private readonly peer: Peer,
  ) {
    peer.on('connection', (conn) => {
      if (conn.serialization !== 'raw' || !conn.reliable) {
        conn.close();
        return;
      }
      conn.on('open', () => this.connections.emit(new PeerLink(conn)));
    });
    peer.on('disconnected', () => {
      if (this.destroyed) return;
      this.statusChanged.emit('reconnecting');
      this.scheduleReconnect(1000);
    });
    peer.on('open', () => this.statusChanged.emit('online'));
    peer.on('error', (err) => {
      if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) {
        this.statusChanged.emit('reconnecting');
        this.scheduleReconnect(3000);
      }
    });
  }

  private scheduleReconnect(ms: number): void {
    if (this.reconnectTimer || this.destroyed) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.destroyed || this.peer.destroyed) return;
      if (this.peer.disconnected) {
        try {
          this.peer.reconnect();
        } catch {
          this.scheduleReconnect(5000);
        }
      }
    }, ms);
  }

  /** Register the room; rejects with `taken: true` if the code is already in use. */
  static open(code: string, cfg: SignalingConfig = signalingFromEnv(), timeoutMs = 15_000): Promise<HostSignaling> {
    return new Promise((resolve, reject) => {
      let peer: Peer;
      try {
        peer = new Peer(peerIdForRoom(code), peerOptions(cfg));
      } catch {
        reject(new ConnectError(explainPeerError('browser-incompatible'), 'unsupported'));
        return;
      }
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        peer.destroy();
        reject(new ConnectError("The connection service didn't answer in time. Check your internet connection.", 'timeout'));
      }, timeoutMs);
      peer.once('open', () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(new HostSignaling(code, peer));
      });
      peer.once('error', (err) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        peer.destroy();
        if (err.type === 'unavailable-id') reject(Object.assign(new ConnectError('Room code taken', 'other'), { taken: true }));
        else reject(new ConnectError(explainPeerError(err.type), err.type === 'browser-incompatible' ? 'unsupported' : 'signaling'));
      });
    });
  }

  destroy(): void {
    this.destroyed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.peer.destroy();
  }
}

/**
 * A shooter's connection factory for one room. Each call opens a new data
 * connection to the host (reusing the signaling connection when possible).
 */
export class RoomConnector {
  private peer: Peer | null = null;

  constructor(
    readonly code: string,
    private readonly cfg: SignalingConfig = signalingFromEnv(),
  ) {}

  private async ensurePeer(timeoutMs: number): Promise<Peer> {
    if (this.peer && !this.peer.destroyed && !this.peer.disconnected && this.peer.open) return this.peer;
    if (this.peer && !this.peer.destroyed && this.peer.disconnected) {
      const peer = this.peer;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new ConnectError(explainPeerError('network'), 'signaling')), timeoutMs);
        peer.once('open', () => {
          clearTimeout(timer);
          resolve();
        });
        try {
          peer.reconnect();
        } catch {
          clearTimeout(timer);
          reject(new ConnectError(explainPeerError('network'), 'signaling'));
        }
      }).catch((err) => {
        peer.destroy();
        this.peer = null;
        throw err;
      });
      return peer;
    }
    const peer = new Peer(peerOptions(this.cfg));
    this.peer = peer;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new ConnectError("The connection service didn't answer in time. Check your internet connection.", 'timeout'));
      }, timeoutMs);
      peer.once('open', () => {
        clearTimeout(timer);
        resolve();
      });
      peer.once('error', (err) => {
        clearTimeout(timer);
        reject(new ConnectError(explainPeerError(err.type, this.code), err.type === 'browser-incompatible' ? 'unsupported' : 'signaling'));
      });
    }).catch((err) => {
      peer.destroy();
      this.peer = null;
      throw err;
    });
    return peer;
  }

  /** Open a reliable, ordered data connection to the host. */
  async connect(timeoutMs = 20_000): Promise<Link> {
    const peer = await this.ensurePeer(Math.min(timeoutMs, 15_000));
    return new Promise<Link>((resolve, reject) => {
      let settled = false;
      const conn = peer.connect(peerIdForRoom(this.code), { reliable: true, serialization: 'raw' });
      if (!conn) {
        reject(new ConnectError(explainPeerError('network'), 'signaling'));
        return;
      }
      const fail = (err: ConnectError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        peer.off('error', onPeerError);
        try {
          conn.close();
        } catch {
          /* ignore */
        }
        reject(err);
      };
      const onPeerError = (err: { type: string }) => {
        if (err.type === 'peer-unavailable') fail(new ConnectError(explainPeerError('peer-unavailable', this.code), 'not-found'));
        else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type))
          fail(new ConnectError(explainPeerError(err.type), 'signaling'));
      };
      const timer = setTimeout(() => fail(new ConnectError(ICE_HELP, 'timeout')), timeoutMs);
      peer.on('error', onPeerError);
      conn.on('iceStateChanged', (state) => {
        if (state === 'failed') fail(new ConnectError(ICE_HELP, 'ice'));
      });
      conn.on('error', () => fail(new ConnectError(ICE_HELP, 'ice')));
      conn.on('open', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        peer.off('error', onPeerError);
        resolve(new PeerLink(conn));
      });
    });
  }

  destroy(): void {
    this.peer?.destroy();
    this.peer = null;
  }
}
