import { createHash } from "node:crypto";

const ACCEPT_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const KEY_PATTERN = /^[A-Za-z0-9+/]{22}==$/;
// A browser's stream only ever closes; anything larger than a control frame may carry is not a
// client of this server's.
const MAX_CLIENT_PAYLOAD = 125;

/** Whether an upgrade request is a well-formed WebSocket opening handshake. */
export function isWebSocketHandshake(req) {
  return (
    req.method === "GET" &&
    req.headers.upgrade?.toLowerCase() === "websocket" &&
    req.headers["sec-websocket-version"] === "13" &&
    KEY_PATTERN.test(req.headers["sec-websocket-key"] ?? "")
  );
}

/** The subprotocols the client offered, in its order. */
export function offeredProtocols(req) {
  return (req.headers["sec-websocket-protocol"] ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
}

/**
 * Completes the handshake on an upgraded socket and returns a text channel to the client: the
 * smallest server side of RFC 6455 this daemon needs, since it only ever sends. The client's own
 * frames are read for its close alone.
 */
export function acceptWebSocket(req, socket, protocol) {
  const accept = createHash("sha1")
    .update(req.headers["sec-websocket-key"] + ACCEPT_GUID)
    .digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: ${protocol}\r\n\r\n`,
  );
  socket.setNoDelay(true);
  let received = Buffer.alloc(0);
  let closing = false;
  const write = (opcode, payload) => {
    if (socket.destroyed || socket.writableEnded) return;
    const length = payload.length;
    const head =
      length < 126
        ? Buffer.from([0x80 | opcode, length])
        : length < 65536
          ? Buffer.from([0x80 | opcode, 126, length >> 8, length & 0xff])
          : Buffer.concat([Buffer.from([0x80 | opcode, 127]), u64(length)]);
    socket.write(Buffer.concat([head, payload]));
  };
  const close = (code = 1000, reason = "") => {
    if (closing) return;
    closing = true;
    const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
    payload.writeUInt16BE(code);
    payload.write(reason, 2);
    write(0x8, payload);
    socket.end();
  };
  socket.on("data", (chunk) => {
    received = Buffer.concat([received, chunk]);
    while (received.length >= 2) {
      const opcode = received[0] & 0x0f;
      const masked = (received[1] & 0x80) !== 0;
      const length = received[1] & 0x7f;
      // Every client frame is masked; an unmasked or oversized one is a protocol error.
      if (!masked || length > MAX_CLIENT_PAYLOAD) return socket.destroy();
      if (received.length < 6 + length) return;
      const mask = received.subarray(2, 6);
      const payload = Buffer.from(received.subarray(6, 6 + length));
      for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
      received = received.subarray(6 + length);
      if (opcode === 0x8) return close(payload.length >= 2 ? payload.readUInt16BE(0) : 1000);
    }
  });
  return {
    send: (text) => write(0x1, Buffer.from(text)),
    close,
  };
}

function u64(n) {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(BigInt(n));
  return bytes;
}
