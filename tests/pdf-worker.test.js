import assert from "node:assert/strict";
import test from "node:test";
import handler from "../pages/api/pdf/worker.js";

function mockResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    send(payload) { this.body = payload; return this; },
    setHeader(name, value) { this.headers[name.toLowerCase()] = String(value); },
  };
}

test("PDF.js worker is served from the same-origin API endpoint", async () => {
  const response = mockResponse();
  await handler({ method: "GET" }, response);

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["content-type"], "text/javascript; charset=utf-8");
  assert.match(response.headers["cache-control"], /immutable/);
  assert.ok(Buffer.isBuffer(response.body));
  assert.match(response.body.toString("utf8", 0, 160), /@licstart|pdfjs/i);
});

test("PDF.js worker endpoint rejects non-GET requests", async () => {
  const response = mockResponse();
  await handler({ method: "POST" }, response);

  assert.equal(response.statusCode, 405);
  assert.deepEqual(response.body, { error: "Method not allowed" });
  assert.equal(response.headers.allow, "GET");
});
