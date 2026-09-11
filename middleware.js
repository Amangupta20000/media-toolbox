import { NextRequest, NextResponse } from "next/server";
import { authConfig } from "./lib/public-config.js";
import { createSessionToken, parseBasicAuth, verifySessionToken } from "./lib/auth-token.js";

const publicPaths = ["/api/health", "/favicon.ico"];

export async function middleware(request) {
  if (publicPaths.includes(request.nextUrl.pathname)) return NextResponse.next();
  const session = request.cookies.get("media_session")?.value;
  if (session && (await verifySessionToken(session, authConfig.username, authConfig.password, authConfig.authSecret))) return NextResponse.next();

  const basic = parseBasicAuth(request.headers.get("authorization"));
  if (basic?.username === authConfig.username && basic.password === authConfig.password) {
    const response = NextResponse.next();
    response.cookies.set("media_session", await createSessionToken(authConfig.username, authConfig.password, authConfig.authSecret), {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 60 * 12,
    });
    return response;
  }
  return new NextResponse("Authentication required", { status: 401, headers: { "WWW-Authenticate": 'Basic realm="Media Toolbox"' } });
}

export const config = { matcher: ["/((?!_next/static|_next/image|robots.txt).*)"] };
