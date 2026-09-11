export const authConfig = {
  username: process.env.APP_USERNAME || "admin",
  password: process.env.APP_PASSWORD || "12345",
  authSecret: process.env.AUTH_SECRET || "local-development-secret",
};
