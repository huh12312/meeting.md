import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';

/**
 * Event socket. The SDK opens one socket per consumer (mic transcript, system
 * audio transcript, scene index, session events), reads the first frame for
 * its `connection_id`, then hands that id back to REST calls as
 * `ws_connection_id` to say where events for a stream should be delivered.
 */
const sockets = new Map(); // connection_id -> { ws, owner }
const wss = new WebSocketServer({ noServer: true });

export function handleUpgrade(req, socket, head, owner) {
  wss.handleUpgrade(req, socket, head, (ws) => {
    const connectionId = crypto.randomUUID();
    sockets.set(connectionId, { ws, owner });
    ws.on('close', () => sockets.delete(connectionId));
    ws.on('error', () => sockets.delete(connectionId));
    ws.send(JSON.stringify({ connection_id: connectionId }));
  });
}

const deliver = (ws, message) => {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
};

/** Sends to one connection; returns false when it is gone. */
export function sendTo(connectionId, message) {
  const entry = connectionId && sockets.get(connectionId);
  if (!entry) return false;
  deliver(entry.ws, message);
  return true;
}

/** Sends to every socket the owner has open. */
export function broadcast(owner, message) {
  for (const entry of sockets.values()) {
    if (entry.owner === owner) deliver(entry.ws, message);
  }
}

setInterval(() => {
  for (const { ws } of sockets.values()) {
    if (ws.readyState === ws.OPEN) ws.ping();
  }
}, 30000).unref();
