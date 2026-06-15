// WebSocket relay connection for real-time TCP streaming
// Connects the browser (viewer) to the HidenHost relay at wss://veltrix.hidenfree.com

const RELAY_WS_URL = "wss://veltrix.hidenfree.com";
const RELAY_AUTH_KEY = "ilovenrattingppl"; // must match HIDEN_AUTH_KEY on the relay

export type RelayMessage = {
  type: string;
  payload?: any;
  from?: string;
  viewerId?: string;
  deviceId?: string;
  [k: string]: any;
};

type Listener = (msg: RelayMessage) => void;

export class RelaySocket {
  private ws: WebSocket | null = null;
  private deviceId: string;
  private listeners = new Set<Listener>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private alive = true;
  private _connected = false;

  constructor(deviceId: string) {
    this.deviceId = deviceId;
  }

  get connected() {
    return this._connected;
  }

  connect() {
    if (this.ws || this.connectTimer) return;
    this.alive = true;
    // React dev StrictMode mounts/unmounts effects once before the real mount.
    // Opening the socket on the next tick lets that fake cleanup cancel cleanly,
    // avoiding "WebSocket is closed before the connection is established" noise.
    this.connectTimer = setTimeout(() => {
      this.connectTimer = null;
      this._tryConnect();
    }, 0);
  }

  private _tryConnect() {
    if (!this.alive) return;
    try {
      const url = `${RELAY_WS_URL}/?key=${encodeURIComponent(RELAY_AUTH_KEY)}&role=viewer&device=${encodeURIComponent(this.deviceId)}`;
      this.ws = new WebSocket(url);

      this.ws.onopen = () => {
        if (!this.alive) {
          this.ws?.close();
          return;
        }
        this._connected = true;
        this._emit({ type: "_connected" });
        // Send hello handshake
        this._send({ type: "hello", role: "viewer", deviceId: this.deviceId });
      };

      this.ws.onmessage = (ev) => {
        try {
          const msg: RelayMessage = JSON.parse(ev.data);
          this._emit(msg);
        } catch { /* ignore non-JSON */ }
      };

      this.ws.onclose = () => {
        this._connected = false;
        this.ws = null;
        this._emit({ type: "_disconnected" });
        if (this.alive) {
          this.reconnectTimer = setTimeout(() => this._tryConnect(), 2000);
        }
      };

      this.ws.onerror = () => {
        // onclose will fire after this
      };
    } catch {
      if (this.alive) {
        this.reconnectTimer = setTimeout(() => this._tryConnect(), 3000);
      }
    }
  }

  send(msg: RelayMessage) {
    this._send(msg);
  }

  private _send(msg: any) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  on(fn: Listener) {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private _emit(msg: RelayMessage) {
    for (const fn of this.listeners) {
      try { fn(msg); } catch { /* swallow */ }
    }
  }

  disconnect() {
    this.alive = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.reconnectTimer = null;
    this.connectTimer = null;
    if (this.ws) {
      this.ws.onclose = null;
      if (this.ws.readyState === WebSocket.OPEN) this.ws.close();
      this.ws = null;
    }
    this._connected = false;
  }
}

// Hook for React components
import { useEffect, useRef, useState, useCallback } from "react";

export function useRelaySocket(deviceId: string) {
  const relayRef = useRef<RelaySocket | null>(null);
  const [connected, setConnected] = useState(false);
  const listenersRef = useRef(new Set<Listener>());

  useEffect(() => {
    const relay = new RelaySocket(deviceId);
    relayRef.current = relay;

    relay.on((msg) => {
      if (msg.type === "_connected") setConnected(true);
      if (msg.type === "_disconnected") setConnected(false);
      for (const fn of listenersRef.current) {
        try { fn(msg); } catch { /* swallow */ }
      }
    });

    relay.connect();

    return () => {
      relay.disconnect();
      relayRef.current = null;
      setConnected(false);
    };
  }, [deviceId]);

  const send = useCallback((msg: RelayMessage) => {
    relayRef.current?.send(msg);
  }, []);

  const onMessage = useCallback((fn: Listener) => {
    listenersRef.current.add(fn);
    return () => { listenersRef.current.delete(fn); };
  }, []);

  return { connected, send, onMessage };
}
