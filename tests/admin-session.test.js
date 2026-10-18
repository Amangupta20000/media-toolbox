import assert from "node:assert/strict";
import test from "node:test";
import handler from "../pages/api/admin/session.js";
import audioGrantHandler from "../pages/api/admin/audio-grant.js";

function request(method, headers = {}, body = undefined) {
  return { method, headers, body, socket: {} };
}

function invokeWith(handlerToCall, input) {
  const result = { statusCode: 200, headers: {}, body: null };
  const response = {
    status(code) { result.statusCode = code; return this; },
    setHeader(name, value) { result.headers[name.toLowerCase()] = value; return this; },
    json(value) { result.body = value; return this; },
  };
  handlerToCall(input, response);
  return result;
}

function invoke(input) {
  return invokeWith(handler, input);
}

test("web admin session accepts Aman without sending the password to the browser", () => {
  const login = invoke(request("POST", {}, { username: "Admin", password: "Aman" }));
  assert.equal(login.statusCode, 200);
  assert.deepEqual(login.body, { authenticated: true });
  assert.match(login.headers["set-cookie"], /HttpOnly/);
  assert.match(login.headers["set-cookie"], /SameSite=Strict/);

  const cookie = login.headers["set-cookie"].split(";", 1)[0];
  const session = invoke(request("GET", { cookie }));
  assert.equal(session.statusCode, 200);
  assert.deepEqual(session.body, { authenticated: true });
  assert.doesNotMatch(JSON.stringify(login.body), /Aman/);
});

test("web admin session rejects an incorrect password and clears on logout", () => {
  const invalid = invoke(request("POST", {}, { username: "Admin", password: "wrong" }));
  assert.equal(invalid.statusCode, 401);

  const logout = invoke(request("DELETE", {}));
  assert.equal(logout.statusCode, 200);
  assert.match(logout.headers["set-cookie"], /Max-Age=0/);
});

test("website Admin sessions can mint and verify short-lived audio URL grants", () => {
  const login = invoke(request("POST", { origin: "https://native-media-agent.vercel.app" }, { username: "Admin", password: "Aman" }));
  const cookie = login.headers["set-cookie"].split(";", 1)[0];
  const issued = invokeWith(audioGrantHandler, request("POST", { cookie, origin: "https://native-media-agent.vercel.app" }, { challenge: "audio-challenge-1", origin: "https://native-media-agent.vercel.app" }));
  assert.equal(issued.statusCode, 200);
  assert.ok(issued.body.grant);

  const verified = invokeWith(audioGrantHandler, request("POST", {}, { grant: issued.body.grant }));
  assert.deepEqual(verified.body, {
    authorized: true,
    challenge: "audio-challenge-1",
    origin: "https://native-media-agent.vercel.app",
    expiresAt: verified.body.expiresAt,
  });
});
