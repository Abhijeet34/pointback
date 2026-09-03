import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";
import {
  HttpError,
  assertBearer,
  assertHost,
  assertOrigin,
  readJsonBody,
} from "../src/http-guard.js";

const req = (headers) => ({ headers });

test("host must name this loopback server", () => {
  assertHost(req({ host: "127.0.0.1:4000" }), 4000);
  assertHost(req({ host: "LOCALHOST:4000" }), 4000);
  assertHost(req({ host: "[::1]:4000" }), 4000);
  for (const host of [
    "evil.com",
    "127.0.0.1:4001",
    "127.0.0.1",
    undefined,
    "127.0.0.1.evil.com:4000",
  ]) {
    assert.throws(
      () => assertHost(req({ host }), 4000),
      (e) => e.status === 403,
      String(host),
    );
  }
});

test("origin, when present, must be this server; a header-less local request passes", () => {
  assertOrigin(req({}), 4000);
  assertOrigin(req({ origin: "http://127.0.0.1:4000" }), 4000);
  for (const origin of [
    "null",
    "http://evil.com",
    "http://127.0.0.1:4001",
    "https://127.0.0.1:4000",
  ]) {
    assert.throws(
      () => assertOrigin(req({ origin }), 4000),
      (e) => e.status === 403,
      origin,
    );
  }
});

test("bearer must match the server token exactly", () => {
  assertBearer(req({ authorization: "Bearer abc" }), "abc");
  for (const authorization of [undefined, "Bearer ab", "Bearer abcd", "Basic abc", "abc"]) {
    assert.throws(
      () => assertBearer(req({ authorization }), "abc"),
      (e) => e.status === 401,
    );
  }
});

const body = (text) => Object.assign(Readable.from([Buffer.from(text)]), { headers: {} });

test("bodies parse as objects and refuse anything else", async () => {
  assert.deepEqual(await readJsonBody(body('{"a":1}')), { a: 1 });
  assert.deepEqual(await readJsonBody(body("")), {});
  for (const text of ["[]", "null", "1", "{bad"]) {
    await assert.rejects(
      readJsonBody(body(text)),
      (e) => e instanceof HttpError && e.status === 400,
      text,
    );
  }
});

test("a body over the cap is refused before it is buffered", async () => {
  const big = Object.assign(Readable.from([Buffer.alloc(600), Buffer.alloc(600)]), { headers: {} });
  await assert.rejects(readJsonBody(big, 1000), (e) => e.status === 413);
  assert.equal(big.isPaused(), true);
});
