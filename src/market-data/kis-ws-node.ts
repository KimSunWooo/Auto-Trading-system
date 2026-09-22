/**
 * Server-only WebSocket factory for KIS PAPER realtime.
 * Prefers the `ws` package so Node deployments do not depend on globalThis.WebSocket.
 * Never used from browser bundles for trading.
 */
import WebSocket from "ws";
import type { WebSocketFactory, WebSocketLike } from "@/src/market-data/kis-realtime-quote-hub";

export class ServerWebSocketUnavailableError extends Error {
  readonly code = "SERVER_WEBSOCKET_UNAVAILABLE" as const;
  constructor(message = "SERVER_WEBSOCKET_UNAVAILABLE: no usable Node WebSocket client") {
    super(message);
    this.name = "ServerWebSocketUnavailableError";
  }
}

type Listener = (ev: { data?: unknown; code?: number; reason?: string }) => void;

/** Adapt `ws` WebSocket to the hub's EventTarget-like interface. */
export function adaptNodeWs(socket: WebSocket): WebSocketLike {
  const wrappers = new Map<string, Map<Listener, (...args: unknown[]) => void>>();

  const on = (type: string, listener: Listener) => {
    let byType = wrappers.get(type);
    if (!byType) {
      byType = new Map();
      wrappers.set(type, byType);
    }
    if (byType.has(listener)) return;

    let wrapped: (...args: unknown[]) => void;
    if (type === "open") {
      wrapped = () => listener({});
    } else if (type === "message") {
      wrapped = (data: unknown) => {
        const raw =
          typeof data === "string"
            ? data
            : Buffer.isBuffer(data)
              ? data.toString("utf8")
              : Array.isArray(data)
                ? Buffer.concat(data as Buffer[]).toString("utf8")
                : String(data ?? "");
        listener({ data: raw });
      };
    } else if (type === "close") {
      wrapped = (code: unknown, reason: unknown) => {
        listener({
          code: typeof code === "number" ? code : undefined,
          reason: reason != null ? String(reason) : undefined,
        });
      };
    } else if (type === "error") {
      wrapped = () => listener({});
    } else {
      wrapped = () => listener({});
    }
    byType.set(listener, wrapped);
    socket.on(type, wrapped);
  };

  const off = (type: string, listener: Listener) => {
    const byType = wrappers.get(type);
    const wrapped = byType?.get(listener);
    if (!wrapped) return;
    socket.off(type, wrapped);
    byType!.delete(listener);
  };

  return {
    get readyState() {
      return socket.readyState;
    },
    send(data: string) {
      socket.send(data);
    },
    close(code?: number, reason?: string) {
      socket.close(code, reason);
    },
    pong(data?: string) {
      socket.pong(data);
    },
    addEventListener(type, listener) {
      on(type, listener);
    },
    removeEventListener(type, listener) {
      off(type, listener);
    },
  };
}

/**
 * Default server factory: always use `ws` package.
 * Throws SERVER_WEBSOCKET_UNAVAILABLE instead of a bare ReferenceError.
 */
export function createServerWebSocketFactory(): WebSocketFactory {
  return (url: string) => {
    if (typeof WebSocket !== "function") {
      throw new ServerWebSocketUnavailableError();
    }
    try {
      return adaptNodeWs(new WebSocket(url));
    } catch (err) {
      if (err instanceof ServerWebSocketUnavailableError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      throw new ServerWebSocketUnavailableError(
        `SERVER_WEBSOCKET_UNAVAILABLE: ${msg}`,
      );
    }
  };
}

/** True when the `ws` package constructor is available in this process. */
export function isServerWebSocketRuntimeAvailable(): boolean {
  return typeof WebSocket === "function";
}
