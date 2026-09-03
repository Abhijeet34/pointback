// Preloaded into every process of the slice: records each outbound connection and DNS
// lookup so a test can assert nothing ever left the loopback interface.
import { appendFileSync } from "node:fs";
import net from "node:net";
import dns from "node:dns";

const log = process.env.POINTBACK_EGRESS_LOG;
const record = (kind, target) => appendFileSync(log, `${process.pid} ${kind} ${target}\n`);

const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  // net.connect hands the socket its already-normalised [options, callback] pair.
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const options =
    typeof first === "object" && first !== null ? first : { port: args[0], host: args[1] };
  record("connect", options.path ?? `${options.host ?? "localhost"}:${options.port}`);
  return originalConnect.apply(this, args);
};

const originalLookup = dns.lookup;
dns.lookup = /** @type {typeof dns.lookup} */ (
  function (hostname, ...rest) {
    record("lookup", hostname);
    return originalLookup.call(this, hostname, ...rest);
  }
);
const originalPromiseLookup = dns.promises.lookup;
dns.promises.lookup = function (hostname, ...rest) {
  record("lookup", hostname);
  return originalPromiseLookup.call(this, hostname, ...rest);
};
