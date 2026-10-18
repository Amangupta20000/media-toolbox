import assert from "node:assert/strict";
import test from "node:test";
import handler from "../pages/api/admin/session.js";

function request(method, headers = {}, body = undefined) {
  return { method, headers, body, socket: {} };
}

function invoke(input) {
  const result = { statusCode: 200, headers: {}, body: null };
  const response = {
    status(code) { result.statusCode = code; return this; },
    setHeader(name, value) { result.headers[name.toLowerCase()] = value; return this; },
    json(value) { result.body = value; return this; },
  };
  handler(input, response);
  return result;
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
