const path = require("node:path");

require("dotenv").config();

const youtubePollMinutes = Number(process.env.YOUTUBE_POLL_MINUTES || 5);

module.exports = {
  host: process.env.HOST || "0.0.0.0",
  port: Number(process.env.PORT || 3000),
  token: process.env.DISCORD_BOT_TOKEN,
  clientId: process.env.DISCORD_CLIENT_ID,
  clientSecret: process.env.DISCORD_CLIENT_SECRET || null,
  devGuildId: process.env.DISCORD_DEV_GUILD_ID || null,
  dashboardBaseUrl: process.env.DASHBOARD_BASE_URL || "http://localhost:3000",
  sessionSecret: process.env.SESSION_SECRET || "dashboard-dev-secret-change-me",
  youtubeApiKey: process.env.YOUTUBE_API_KEY || null,
  youtubePollMinutes: Number.isFinite(youtubePollMinutes) && youtubePollMinutes > 0 ? youtubePollMinutes : 5,
  defaultPrefix: process.env.DEFAULT_PREFIX || "!",
  defaultWelcomeMessage:
    process.env.DEFAULT_WELCOME_MESSAGE || "Welcome to **{server}**, {user}!",
  databasePath: path.join(process.cwd(), "data", "bot.sqlite"),
};
