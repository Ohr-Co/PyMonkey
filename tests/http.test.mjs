import { after, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { fromBase64, httpFetch, toBase64 } from "../extension/lib/http.js";

// A real server on this machine: httpFetch is tried with Node's own `fetch`,
// which behaves like the browser's for everything tested here.
const server = http
  .createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      if (req.url === "/slow") return; // never answers
      if (req.url === "/missing") {
        res.writeHead(404, "Not Found", { "Content-Type": "text/plain" });
        return res.end("nothing here");
      }
      if (req.url === "/bytes") {
        res.writeHead(200, { "Content-Type": "application/octet-stream" });
        return res.end(Buffer.from(ALL_BYTES));
      }
      if (req.url === "/moved") {
        res.writeHead(302, { Location: "/echo" });
        return res.end();
      }
      // Everything else: report the request as JSON.
      res.writeHead(200, { "Content-Type": "application/json", "X-Test": "yes" });
      res.end(
        JSON.stringify({
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: toBase64(new Uint8Array(Buffer.concat(chunks))),
        }),
      );
    });
  })
  .listen(0);
const base = `http://localhost:${server.address().port}`;
after(() => server.closeAllConnections() ?? server.close());

const ALL_BYTES = Uint8Array.from({ length: 256 }, (_, i) => i);
const text = (base64) => new TextDecoder().decode(fromBase64(base64));
const request = (overrides) => ({ url: `${base}/echo`, method: "GET", headers: {}, body: null, timeout: 5, cookies: false, ...overrides });

test("base64 round trip, including a body too long for one String.fromCharCode call", () => {
  assert.deepEqual(fromBase64(toBase64(ALL_BYTES)), ALL_BYTES);
  assert.equal(toBase64(new TextEncoder().encode("hello")), "aGVsbG8=");
  const big = new Uint8Array(1_000_000).map((_, i) => i % 251);
  assert.deepEqual(fromBase64(toBase64(big)), big);
  assert.equal(toBase64(new Uint8Array(0)), "");
});

test("a GET returns status, headers and body", async () => {
  const reply = await httpFetch(request({ headers: { "X-Asked": "1" } }));
  assert.equal(reply.ok, true);
  const { url, status, reason, headers, body } = reply.value;
  assert.deepEqual([url, status, reason], [`${base}/echo`, 200, "OK"]);
  assert.ok(headers.some(([name, value]) => name === "x-test" && value === "yes"));
  const seen = JSON.parse(text(body));
  assert.deepEqual([seen.method, seen.url, seen.headers["x-asked"], seen.body], ["GET", "/echo", "1", ""]);
});

test("a POST sends its body and headers", async () => {
  const reply = await httpFetch(
    request({ method: "POST", headers: { "Content-Type": "application/json" }, body: toBase64(new TextEncoder().encode('{"a": "é"}')) }),
  );
  const seen = JSON.parse(text(reply.value.body));
  assert.deepEqual([seen.method, seen.headers["content-type"], text(seen.body)], ["POST", "application/json", '{"a": "é"}']);
});

test("binary bodies survive in both directions", async () => {
  const down = await httpFetch(request({ url: `${base}/bytes` }));
  assert.deepEqual(fromBase64(down.value.body), ALL_BYTES);
  const up = await httpFetch(request({ method: "PUT", body: toBase64(ALL_BYTES) }));
  assert.deepEqual(fromBase64(JSON.parse(text(up.value.body)).body), ALL_BYTES);
});

test("an error status is an answer, not a failure", async () => {
  const reply = await httpFetch(request({ url: `${base}/missing` }));
  assert.equal(reply.ok, true);
  assert.deepEqual([reply.value.status, reply.value.reason, text(reply.value.body)], [404, "Not Found", "nothing here"]);
});

test("redirects are followed and the final address is reported", async () => {
  const reply = await httpFetch(request({ url: `${base}/moved` }));
  assert.deepEqual([reply.value.status, reply.value.url], [200, `${base}/echo`]);
});

test("a server that does not answer in time is a timeout", async () => {
  const started = Date.now();
  const reply = await httpFetch(request({ url: `${base}/slow`, timeout: 0.2 }));
  assert.deepEqual(reply, { ok: false, timeout: true, error: "no answer within 0.2 seconds" });
  assert.ok(Date.now() - started < 2_000);
});

test("a server that cannot be reached is a failure, not an exception", async () => {
  // Port 1 on this machine: nothing listens there.
  const reply = await httpFetch(request({ url: "http://127.0.0.1:1/" }));
  assert.equal(reply.ok, false);
  assert.equal(reply.timeout, false);
  assert.equal(typeof reply.error, "string");
});

test("the browser's vague failure message is explained, a specific one is kept", async () => {
  const failing = (message) => () => Promise.reject(new TypeError(message));
  let reply = await httpFetch(request(), failing("Failed to fetch"));
  assert.match(reply.error, /server cannot be reached/);
  assert.match(reply.error, /or PyMonkey has not been allowed on that site$/); // the one cause the user can do something about
  reply = await httpFetch(request(), failing("Invalid name"));
  assert.equal(reply.error, "Invalid name");
});

test("cookies are sent only when asked for, and timeout 0 means no time limit", async () => {
  const options = [];
  const fake = (_url, init) => (options.push(init), Promise.resolve(new Response("ok")));
  await httpFetch(request({ cookies: true, timeout: 0 }), fake);
  await httpFetch(request({ cookies: false, timeout: 3 }), fake);
  assert.deepEqual(options.map((o) => o.credentials), ["include", "omit"]);
  assert.equal(options[0].signal, undefined);
  assert.ok(options[1].signal instanceof AbortSignal);
  assert.equal(options[0].body, undefined);
});
