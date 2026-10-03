import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { test } from "node:test";
import { acceptWebSocket, isWebSocketHandshake, offeredProtocols } from "../src/websocket.js";

test("a browser's WebSocket reads every frame length the server writes, and its close ends the socket", async () => {
  const sizes = [5, 300, 70_000];
  let ended;
  const server = createServer();
  server.on("upgrade", (req, socket) => {
    assert.ok(isWebSocketHandshake(req));
    assert.deepEqual(offeredProtocols(req), ["events", "bearer.abc"]);
    ended = new Promise((resolve) => socket.on("close", resolve));
    const channel = acceptWebSocket(req, socket, "events");
    for (const size of sizes) channel.send("x".repeat(size));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = /** @type {import("node:net").AddressInfo} */ (server.address());
    const socket = new WebSocket(`ws://127.0.0.1:${port}/`, ["events", "bearer.abc"]);
    const received = [];
    await new Promise((resolve) =>
      socket.addEventListener("message", (event) => {
        received.push(event.data.length);
        if (received.length === sizes.length) resolve(undefined);
      }),
    );
    assert.equal(socket.protocol, "events");
    assert.deepEqual(received, sizes, "7-bit, 16-bit and 64-bit payload lengths all arrive whole");
    const closed = new Promise((resolve) => socket.addEventListener("close", resolve));
    socket.close(1000);
    assert.equal(
      /** @type {CloseEvent} */ (await closed).code,
      1000,
      "the server answers the close",
    );
    await ended;
  } finally {
    server.close();
  }
});

test("only a version 13 upgrade with a well-formed key is a handshake", () => {
  const req = (headers) => ({ method: "GET", headers });
  const good = {
    upgrade: "websocket",
    "sec-websocket-version": "13",
    "sec-websocket-key": randomBytes(16).toString("base64"),
  };
  assert.ok(isWebSocketHandshake(req(good)));
  assert.ok(!isWebSocketHandshake(req({ ...good, "sec-websocket-version": "8" })));
  assert.ok(!isWebSocketHandshake(req({ ...good, "sec-websocket-key": "short" })));
  assert.ok(!isWebSocketHandshake(req({ ...good, upgrade: "h2c" })));
  assert.ok(!isWebSocketHandshake({ method: "POST", headers: good }));
});
