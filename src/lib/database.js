const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");
const config = require("../config");

let db;

const DEFAULT_SETTINGS = {
  prefix: config.defaultPrefix,
  log_channel_id: null,
  welcome_channel_id: null,
  welcome_message: config.defaultWelcomeMessage,
  automod_enabled: 1,
  invite_filter: 1,
  caps_threshold: 75,
  spam_window_seconds: 8,
  spam_message_limit: 6,
  leveling_enabled: 1,
  bad_words: "[]",
};

const UPDATABLE_COLUMNS = new Set([
  "prefix",
  "log_channel_id",
  "welcome_channel_id",
  "welcome_message",
  "automod_enabled",
  "invite_filter",
  "caps_threshold",
  "spam_window_seconds",
  "spam_message_limit",
  "leveling_enabled",
  "bad_words",
]);

function normalizeSettings(row) {
  return {
    guildId: row.guild_id,
    prefix: row.prefix,
    logChannelId: row.log_channel_id,
    welcomeChannelId: row.welcome_channel_id,
    welcomeMessage: row.welcome_message,
    automodEnabled: Boolean(row.automod_enabled),
    inviteFilter: Boolean(row.invite_filter),
    capsThreshold: row.caps_threshold,
    spamWindowSeconds: row.spam_window_seconds,
    spamMessageLimit: row.spam_message_limit,
    levelingEnabled: Boolean(row.leveling_enabled),
    badWords: JSON.parse(row.bad_words || "[]"),
  };
}

function initDatabase() {
  if (db) {
    return db;
  }

  fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });
  db = new Database(config.databasePath);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS guild_settings (
      guild_id TEXT PRIMARY KEY,
      prefix TEXT NOT NULL DEFAULT '!',
      log_channel_id TEXT,
      welcome_channel_id TEXT,
      welcome_message TEXT NOT NULL DEFAULT 'Welcome to **{server}**, {user}!',
      automod_enabled INTEGER NOT NULL DEFAULT 1,
      invite_filter INTEGER NOT NULL DEFAULT 1,
      caps_threshold INTEGER NOT NULL DEFAULT 75,
      spam_window_seconds INTEGER NOT NULL DEFAULT 8,
      spam_message_limit INTEGER NOT NULL DEFAULT 6,
      leveling_enabled INTEGER NOT NULL DEFAULT 1,
      bad_words TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS levels (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      xp INTEGER NOT NULL DEFAULT 0,
      level INTEGER NOT NULL DEFAULT 0,
      last_message_at TEXT,
      PRIMARY KEY (guild_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS warnings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      moderator_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS youtube_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      youtube_channel_id TEXT NOT NULL,
      discord_channel_id TEXT NOT NULL,
      mention_role_id TEXT,
      youtube_channel_name TEXT,
      last_live_video_id TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(guild_id, youtube_channel_id, discord_channel_id)
    );
  `);

  return db;
}

function ensureGuildSettings(guildId) {
  initDatabase();

  db.prepare(`
    INSERT INTO guild_settings (
      guild_id,
      prefix,
      log_channel_id,
      welcome_channel_id,
      welcome_message,
      automod_enabled,
      invite_filter,
      caps_threshold,
      spam_window_seconds,
      spam_message_limit,
      leveling_enabled,
      bad_words
    )
    VALUES (
      @guild_id,
      @prefix,
      @log_channel_id,
      @welcome_channel_id,
      @welcome_message,
      @automod_enabled,
      @invite_filter,
      @caps_threshold,
      @spam_window_seconds,
      @spam_message_limit,
      @leveling_enabled,
      @bad_words
    )
    ON CONFLICT(guild_id) DO NOTHING
  `).run({
    guild_id: guildId,
    ...DEFAULT_SETTINGS,
  });
}

function getGuildSettings(guildId) {
  ensureGuildSettings(guildId);
  const row = db
    .prepare("SELECT * FROM guild_settings WHERE guild_id = ?")
    .get(guildId);

  return normalizeSettings(row);
}

function updateGuildSettings(guildId, changes) {
  ensureGuildSettings(guildId);

  const entries = Object.entries(changes).filter(([key]) => UPDATABLE_COLUMNS.has(key));
  if (!entries.length) {
    return getGuildSettings(guildId);
  }

  const preparedChanges = Object.fromEntries(
    entries.map(([key, value]) => [key, key === "bad_words" ? JSON.stringify(value) : value]),
  );

  const assignments = Object.keys(preparedChanges).map((key) => `${key} = @${key}`);
  assignments.push("updated_at = CURRENT_TIMESTAMP");

  db.prepare(`
    UPDATE guild_settings
    SET ${assignments.join(", ")}
    WHERE guild_id = @guild_id
  `).run({
    guild_id: guildId,
    ...preparedChanges,
  });

  return getGuildSettings(guildId);
}

function addWarning({ guildId, userId, moderatorId, reason }) {
  initDatabase();
  db.prepare(`
    INSERT INTO warnings (guild_id, user_id, moderator_id, reason)
    VALUES (?, ?, ?, ?)
  `).run(guildId, userId, moderatorId, reason);
}

function getWarnings(guildId, userId) {
  initDatabase();
  return db
    .prepare(`
      SELECT id, moderator_id, reason, created_at
      FROM warnings
      WHERE guild_id = ? AND user_id = ?
      ORDER BY created_at DESC
    `)
    .all(guildId, userId);
}

function getRecentWarnings(guildId, limit = 20) {
  initDatabase();
  return db
    .prepare(`
      SELECT id, user_id, moderator_id, reason, created_at
      FROM warnings
      WHERE guild_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `)
    .all(guildId, limit);
}

function getRank(guildId, userId) {
  initDatabase();
  return (
    db
      .prepare(`
        SELECT guild_id, user_id, xp, level, last_message_at
        FROM levels
        WHERE guild_id = ? AND user_id = ?
      `)
      .get(guildId, userId) || {
      guild_id: guildId,
      user_id: userId,
      xp: 0,
      level: 0,
      last_message_at: null,
    }
  );
}

function saveRank({ guildId, userId, xp, level, lastMessageAt }) {
  initDatabase();
  db.prepare(`
    INSERT INTO levels (guild_id, user_id, xp, level, last_message_at)
    VALUES (@guild_id, @user_id, @xp, @level, @last_message_at)
    ON CONFLICT(guild_id, user_id)
    DO UPDATE SET
      xp = excluded.xp,
      level = excluded.level,
      last_message_at = excluded.last_message_at
  `).run({
    guild_id: guildId,
    user_id: userId,
    xp,
    level,
    last_message_at: lastMessageAt,
  });
}

function getLeaderboard(guildId, limit = 10) {
  initDatabase();
  return db
    .prepare(`
      SELECT user_id, xp, level
      FROM levels
      WHERE guild_id = ?
      ORDER BY xp DESC, level DESC
      LIMIT ?
    `)
    .all(guildId, limit);
}

function getGuildLevelMemberCount(guildId) {
  initDatabase();
  const row = db
    .prepare(`
      SELECT COUNT(*) AS count
      FROM levels
      WHERE guild_id = ?
    `)
    .get(guildId);

  return row?.count || 0;
}

function listYouTubeSubscriptions(guildId) {
  initDatabase();
  return db
    .prepare(`
      SELECT id, guild_id, youtube_channel_id, youtube_channel_name, discord_channel_id, mention_role_id, last_live_video_id
      FROM youtube_subscriptions
      WHERE guild_id = ?
      ORDER BY created_at ASC
    `)
    .all(guildId);
}

function getAllYouTubeSubscriptions() {
  initDatabase();
  return db
    .prepare(`
      SELECT id, guild_id, youtube_channel_id, youtube_channel_name, discord_channel_id, mention_role_id, last_live_video_id
      FROM youtube_subscriptions
      ORDER BY created_at ASC
    `)
    .all();
}

function addYouTubeSubscription({
  guildId,
  youtubeChannelId,
  discordChannelId,
  mentionRoleId = null,
  youtubeChannelName = null,
}) {
  initDatabase();

  db.prepare(`
    INSERT INTO youtube_subscriptions (
      guild_id,
      youtube_channel_id,
      discord_channel_id,
      mention_role_id,
      youtube_channel_name
    )
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(guild_id, youtube_channel_id, discord_channel_id)
    DO UPDATE SET
      mention_role_id = excluded.mention_role_id,
      youtube_channel_name = COALESCE(excluded.youtube_channel_name, youtube_subscriptions.youtube_channel_name)
  `).run(guildId, youtubeChannelId, discordChannelId, mentionRoleId, youtubeChannelName);
}

function removeYouTubeSubscription({ guildId, youtubeChannelId, discordChannelId }) {
  initDatabase();
  const result = db.prepare(`
    DELETE FROM youtube_subscriptions
    WHERE guild_id = ? AND youtube_channel_id = ? AND discord_channel_id = ?
  `).run(guildId, youtubeChannelId, discordChannelId);

  return result.changes;
}

function updateYouTubeSubscription(id, changes) {
  initDatabase();
  const allowedColumns = ["mention_role_id", "youtube_channel_name", "last_live_video_id"];
  const entries = Object.entries(changes).filter(([key]) => allowedColumns.includes(key));

  if (!entries.length) {
    return;
  }

  const assignments = entries.map(([key]) => `${key} = @${key}`);
  db.prepare(`
    UPDATE youtube_subscriptions
    SET ${assignments.join(", ")}
    WHERE id = @id
  `).run({
    id,
    ...Object.fromEntries(entries),
  });
}

module.exports = {
  initDatabase,
  getGuildSettings,
  updateGuildSettings,
  addWarning,
  getWarnings,
  getRecentWarnings,
  getRank,
  saveRank,
  getLeaderboard,
  getGuildLevelMemberCount,
  listYouTubeSubscriptions,
  getAllYouTubeSubscriptions,
  addYouTubeSubscription,
  removeYouTubeSubscription,
  updateYouTubeSubscription,
};
