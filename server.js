/**
 * AirParty signaling server (WebSocket)
 * - Rooms
 * - Host/peers membership
 * - Relay messages (signaling + sync)
 * - Ping/Pong to estimate server time offset
 *
 * WS endpoint: /ws
 * Health endpoint: /
 */

const http = require("http");
const { WebSocketServer } = require("ws");
const { URL } = require("url");

const PORT = process.env.PORT || 8080;

// rooms: roomId -> { hostId: string, clients: Map<clientId, ws> }
const rooms = new Map();

// ws -> { id, room }
const meta = new WeakMap();

function safeJsonParse(str) {
  try { return JSON.parse(str); } catch { return null; }
}

function send(ws, obj) {
  if (!ws || ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify(obj));
}

function now() {
  return Date.now();
}

function getRoom(roomId) {
  return rooms.get(roomId);
}

function ensureRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, { hostId: "", clients: new Map() });
  }
  return rooms.get(roomId);
}

function removeClientFromRoom(clientId, roomId) {
  const r = rooms.get(roomId);
  if (!r) return;
  r.clients.delete(clientId);

  // If host left, pick another host (first remaining) or clear
  if (r.hostId === clientId) {
    const first = r.clients.keys().next().value || "";
    r.hostId = first || "";
  }

  // Notify remaining peers
  for (const [pid, pws] of r.clients.entries()) {
    send(pws, { type: "peer_left", peerId: clientId });
  }

  // If empty, delete room
  if (r.clients.size === 0) rooms.delete(roomId);
}

function addClientToRoom(clientId, roomId, ws) {
  const r = ensureRoom(roomId);
  r.clients.set(clientId, ws);

  // Notify others that a peer joined
  for (const [pid, pws] of r.clients.entries()) {
    if (pid !== clientId) send(pws, { type: "peer_joined", peerId: clientId });
  }
}

function relay(roomId, fromId, to, payload) {
  const r = rooms.get(roomId);
  if (!r) return;

  // Fan-out
  if (to === "*" || to === "all") {
    for (const [pid, pws] of r.clients.entries()) {
      if (pid === fromId) continue;
      send(pws, { type: "relay", from: fromId, payload, serverNow: now() });
    }
    return;
  }

  // Direct
  const targetWs = r.clients.get(to);
  if (targetWs) {
    send(targetWs, { type: "relay", from: fromId, payload, serverNow: now() });
  }
}

// ---------- HTTP server (for Render health checks) ----------
const server = http.createServer((req, res) => {
  if (req.url === "/" || req.url.startsWith("/health")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, ts: now() }));
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("Not found");
});

// ---------- WebSocket server (noServer: we handle upgrade) ----------
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  if (u.pathname !== "/ws") {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

wss.on("connection", (ws) => {
  // Until hello arrives, client has no id/room
  meta.set(ws, { id: "", room: "" });

  // Basic hello ack when client identifies
  ws.on("message", (data) => {
    const msg = safeJsonParse(data.toString());
    if (!msg || typeof msg !== "object") return;

    const m = meta.get(ws) || { id: "", room: "" };

    // Time sync ping/pong
    if (msg.type === "ping") {
      send(ws, { type: "pong", t0: msg.t0, serverNow: now() });
      return;
    }

    // Identify client
    if (msg.type === "hello") {
      const id = String(msg.id || "").trim();
      if (!id) {
        send(ws, { type: "error", message: "Missing id in hello" });
        return;
      }
      m.id = id;
      meta.set(ws, m);
      send(ws, { type: "hello_ack", serverNow: now(), id });
      return;
    }

    // Must have id after hello
    if (!m.id) {
      send(ws, { type: "error", message: "Send {type:'hello', id:'...'} first" });
      return;
    }

    // Create room (host)
    if (msg.type === "create_room") {
      const roomId = String(msg.room || "").trim();
      if (!roomId) {
        send(ws, { type: "error", message: "Missing room id" });
        return;
      }

      // leave any previous room
      if (m.room) removeClientFromRoom(m.id, m.room);

      const r = ensureRoom(roomId);
      r.hostId = m.id;

      m.room = roomId;
      meta.set(ws, m);

      addClientToRoom(m.id, roomId, ws);

      send(ws, { type: "room_created", room: roomId });
      send(ws, {
        type: "room_joined",
        room: roomId,
        hostId: r.hostId,
        peers: Array.from(r.clients.keys()).filter((x) => x !== m.id)
      });
      return;
    }

    // Join room (listener)
    if (msg.type === "join_room") {
      const roomId = String(msg.room || "").trim();
      if (!roomId) {
        send(ws, { type: "error", message: "Missing room id" });
        return;
      }

      const r = getRoom(roomId);
      if (!r) {
        send(ws, { type: "error", message: "Room not found. Ask host to create it first." });
        return;
      }

      // leave any previous room
      if (m.room) removeClientFromRoom(m.id, m.room);

      m.room = roomId;
      meta.set(ws, m);

      addClientToRoom(m.id, roomId, ws);

      send(ws, {
        type: "room_joined",
        room: roomId,
        hostId: r.hostId,
        peers: Array.from(r.clients.keys()).filter((x) => x !== m.id)
      });
      return;
    }

    // Relay (signaling + sync)
    if (msg.type === "relay") {
      const roomId = String(msg.room || m.room || "").trim();
      const to = String(msg.to || "").trim();
      const payload = msg.payload || null;

      if (!roomId || !rooms.has(roomId)) {
        send(ws, { type: "error", message: "Invalid room for relay" });
        return;
      }
      if (!to) {
        send(ws, { type: "error", message: "Missing 'to' for relay" });
        return;
      }

      relay(roomId, m.id, to, payload);
      return;
    }

    // Unknown
    send(ws, { type: "error", message: `Unknown type: ${msg.type}` });
  });

  ws.on("close", () => {
    const m = meta.get(ws);
    if (!m) return;

    if (m.room && m.id) {
      removeClientFromRoom(m.id, m.room);
    }
  });
});

server.listen(PORT, () => {
  console.log(`AirParty signaling server running on :${PORT}`);
  console.log(`WebSocket endpoint: /ws`);
});
