// Peer-to-peer room built on PeerJS.
//
// Topology is a full mesh: every participant holds a direct audio stream and a
// direct data channel to every other. That keeps latency at one hop and means
// no server ever handles media. The only shared infrastructure is a signalling
// broker used for the initial handshake and a TURN relay for the minority of
// networks that block direct connections.
//
// Room joining resolves without a lobby server by deriving a deterministic
// peer id from the room code. Whoever claims that id first is the host; anyone
// who finds it taken knows a room already exists and joins as a guest. The
// host's only extra duty is telling each newcomer who else is present.
//
// Glare is avoided by a single rule: the newcomer dials everyone already in
// the room, and existing members only ever answer. No pair can dial each other
// simultaneously.

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  // Free public TURN, needed on restrictive corporate networks.
  {
    urls: 'turn:openrelay.metered.ca:80',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
  {
    urls: 'turn:openrelay.metered.ca:443',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
];

const idForRoom = (code) => `lingualive-${code.toLowerCase()}`;

export const normaliseCode = (raw) =>
  (raw || '')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '')
    .slice(0, 32);

export function randomCode() {
  const words = [
    'amber', 'basil', 'cedar', 'delta', 'ember', 'flint', 'grove', 'harbor',
    'indigo', 'jasper', 'kite', 'lunar', 'maple', 'north', 'onyx', 'pearl',
  ];
  const pick = () => words[Math.floor(Math.random() * words.length)];
  return `${pick()}-${pick()}-${Math.floor(100 + Math.random() * 900)}`;
}

export class Room extends EventTarget {
  /**
   * @param {{code:string, displayName:string, localStream:MediaStream,
   *          meta?:object}} opts
   * `meta` is sent in the greeting so peers can learn each other's spoken
   * language and warm up the right translation model before anyone talks.
   */
  constructor({ code, displayName, localStream, meta }) {
    super();
    this.code = normaliseCode(code);
    this.displayName = displayName;
    this.localStream = localStream;
    this.meta = meta || {};
    this.peer = null;
    this.isHost = false;
    this.left = false;
    /** @type {Map<string, {conn:any, call:any, name:string}>} */
    this.peers = new Map();
  }

  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  #status(text) {
    this.#emit('status', { text });
  }

  get participantCount() {
    return this.peers.size + 1;
  }

  async join() {
    if (typeof window.Peer !== 'function') {
      throw new Error('PeerJS failed to load. Check your network and reload.');
    }
    this.#status('Claiming room…');
    const claimed = await this.#tryHost();
    if (this.left) return;
    if (!claimed) await this.#joinAsGuest();
  }

  /** Attempt to own the room's canonical id. Resolves false if already taken. */
  #tryHost() {
    return new Promise((resolve) => {
      const peer = new window.Peer(idForRoom(this.code), {
        config: { iceServers: ICE_SERVERS },
        debug: 1,
      });
      let settled = false;

      peer.on('open', () => {
        if (settled) return;
        settled = true;
        this.peer = peer;
        this.isHost = true;
        this.#wire();
        this.#status('Room open — waiting for others to join');
        this.#emit('ready', { host: true, code: this.code });
        resolve(true);
      });

      peer.on('error', (err) => {
        if (settled) return;
        settled = true;
        peer.destroy();
        // Any id collision means the room already exists.
        if (err?.type === 'unavailable-id') {
          resolve(false);
        } else {
          this.#emit('error', { message: describeError(err) });
          resolve(false);
        }
      });
    });
  }

  #joinAsGuest() {
    return new Promise((resolve, reject) => {
      this.#status('Joining existing room…');
      const peer = new window.Peer(undefined, {
        config: { iceServers: ICE_SERVERS },
        debug: 1,
      });

      peer.on('open', () => {
        this.peer = peer;
        this.isHost = false;
        this.#wire();
        this.#dial(idForRoom(this.code));
        this.#emit('ready', { host: false, code: this.code });
        resolve();
      });

      peer.on('error', (err) => {
        // A dial to a peer that vanished is recoverable; a broker failure is not.
        if (err?.type === 'peer-unavailable') {
          this.#status('A participant left before connecting.');
          return;
        }
        this.#emit('error', { message: describeError(err) });
        if (!this.peer) reject(new Error(describeError(err)));
      });
    });
  }

  /** Wire up handlers for connections other peers initiate towards us. */
  #wire() {
    this.peer.on('connection', (conn) => this.#adoptConn(conn));

    this.peer.on('call', (call) => {
      call.answer(this.localStream);
      this.#adoptCall(call);
    });

    this.peer.on('disconnected', () => {
      if (this.left) return;
      this.#status('Signalling dropped — reconnecting…');
      try {
        this.peer.reconnect();
      } catch {
        /* PeerJS will surface an error event if this fails */
      }
    });
  }

  /** Open both channels to a peer we are joining. Newcomers dial; others answer. */
  #dial(peerId) {
    if (peerId === this.peer.id || this.peers.has(peerId)) return;
    this.#adoptConn(this.peer.connect(peerId, { reliable: true }));
    this.#adoptCall(this.peer.call(peerId, this.localStream));
  }

  #entry(peerId) {
    if (!this.peers.has(peerId)) {
      this.peers.set(peerId, { conn: null, call: null, name: 'Guest', meta: {} });
    }
    return this.peers.get(peerId);
  }

  #adoptConn(conn) {
    if (!conn) return;
    const entry = this.#entry(conn.peer);
    entry.conn = conn;

    conn.on('open', () => {
      conn.send({ type: 'hello', name: this.displayName, meta: this.meta });

      // Only the host knows the full roster, so only the host shares it. The
      // newcomer dials each existing member, which keeps dialling one-sided.
      if (this.isHost) {
        const others = [...this.peers.keys()].filter((id) => id !== conn.peer);
        conn.send({ type: 'roster', peers: others });
      }
    });

    conn.on('data', (data) => {
      if (!data || typeof data !== 'object') return;

      if (data.type === 'hello') {
        entry.name = String(data.name || 'Guest').slice(0, 40);
        entry.meta = data.meta && typeof data.meta === 'object' ? data.meta : {};
        this.#emit('peer-join', {
          peerId: conn.peer,
          name: entry.name,
          meta: entry.meta,
        });
        return;
      }
      if (data.type === 'roster' && Array.isArray(data.peers)) {
        data.peers.forEach((id) => this.#dial(id));
        return;
      }
      this.#emit('message', { peerId: conn.peer, name: entry.name, data });
    });

    conn.on('close', () => this.#drop(conn.peer));
    conn.on('error', () => this.#drop(conn.peer));
  }

  #adoptCall(call) {
    if (!call) return;
    const entry = this.#entry(call.peer);
    entry.call = call;

    call.on('stream', (stream) => {
      this.#emit('stream', { peerId: call.peer, stream, name: entry.name });
    });
    call.on('close', () => this.#drop(call.peer));
    call.on('error', () => this.#drop(call.peer));
  }

  #drop(peerId) {
    const entry = this.peers.get(peerId);
    if (!entry) return;
    this.peers.delete(peerId);
    try {
      entry.conn?.close();
      entry.call?.close();
    } catch {
      /* already torn down */
    }
    this.#emit('peer-leave', { peerId, name: entry.name });
  }

  /** Send an object to every connected peer. */
  broadcast(payload) {
    this.peers.forEach((entry) => {
      if (entry.conn?.open) {
        try {
          entry.conn.send(payload);
        } catch {
          /* peer is going away; the close handler will clean up */
        }
      }
    });
  }

  leave() {
    this.left = true;
    this.peers.forEach((_, id) => this.#drop(id));
    try {
      this.peer?.destroy();
    } catch {
      /* nothing useful to do */
    }
    this.peer = null;
  }
}

function describeError(err) {
  switch (err?.type) {
    case 'browser-incompatible':
      return 'This browser cannot do WebRTC calls. Use Chrome or Edge.';
    case 'network':
    case 'server-error':
      return 'Could not reach the signalling server. Check your connection.';
    case 'webrtc':
      return 'The peer connection failed, most likely a firewall.';
    case 'unavailable-id':
      return 'That room code is already in use.';
    default:
      return err?.message || 'Connection error.';
  }
}
