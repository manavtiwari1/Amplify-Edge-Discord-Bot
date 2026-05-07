const path = require("node:path");

require("dotenv").config();

const youtubePollMinutes = Number(process.env.YOUTUBE_POLL_MINUTES || 5);

module.exports = {
  token: process.env.DISCORD_BOT_TOKEN,
  clientId: process.env.DISCORD_CLIENT_ID,
  devGuildId: process.env.DISCORD_DEV_GUILD_ID || null,
  youtubeApiKey: process.env.YOUTUBE_API_KEY || null,
  youtubePollMinutes: Number.isFinite(youtubePollMinutes) && youtubePollMinutes > 0 ? youtubePollMinutes : 5,
  defaultPrefix: process.env.DEFAULT_PREFIX || "!",
  defaultWelcomeMessage:
    process.env.DEFAULT_WELCOME_MESSAGE || "Welcome to **{server}**, {user}!",
  databasePath: path.join(process.cwd(), "data", "bot.sqlite"),
};
