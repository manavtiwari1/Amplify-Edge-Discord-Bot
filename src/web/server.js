const crypto = require("node:crypto");
const path = require("node:path");
const express = require("express");
const session = require("express-session");
const {
  ChannelType,
  PermissionFlagsBits,
} = require("discord.js");
const config = require("../config");
const {
  addWarning,
  getGuildLevelMemberCount,
  getGuildSettings,
  getRecentWarnings,
  updateGuildSettings,
} = require("../lib/database");
const { buildLogEmbed, sendLog } = require("../lib/logging");
const { clamp, parseWordList } = require("../lib/utils");
const {
  addYouTubeSubscription,
  listYouTubeSubscriptions,
  normalizeYouTubeChannelId,
  removeYouTubeSubscription,
} = require("../lib/youtube");

const DISCORD_API_BASE = "https://discord.com/api/v10";

function buildDiscordAvatarUrl(user) {
  if (!user.avatar) {
    return `https://cdn.discordapp.com/embed/avatars/${Number(user.id) % 5}.png`;
  }

  return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128`;
}

function buildGuildIconUrl(guild) {
  if (!guild.icon) {
    return null;
  }

  return `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png?size=256`;
}

function hasPermission(permissions, flag) {
  try {
    return (BigInt(permissions) & BigInt(flag)) === BigInt(flag);
  } catch {
    return false;
  }
}

function hasGuildAccess(permissions, flag) {
  return (
    hasPermission(permissions, flag) ||
    hasPermission(permissions, PermissionFlagsBits.Administrator)
  );
}

function setFlash(req, type, text) {
  req.session.flash = { type, text };
}

function readFlash(req) {
  const flash = req.session.flash || null;
  delete req.session.flash;
  return flash;
}

async function exchangeCodeForToken(code) {
  const response = await fetch(`${DISCORD_API_BASE}/oauth2/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: "authorization_code",
      code,
      redirect_uri: `${config.dashboardBaseUrl}/auth/callback`,
    }),
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error_description || payload.error || "OAuth token exchange failed");
  }

  return payload;
}

async function refreshAccessToken(refreshToken) {
  const response = await fetch(`${DISCORD_API_BASE}/oauth2/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error_description || payload.error || "OAuth token refresh failed");
  }

  return payload;
}

async function fetchDiscordResource(pathname, accessToken) {
  const response = await fetch(`${DISCORD_API_BASE}${pathname}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.message || "Discord API request failed");
  }

  return payload;
}

async function ensureAuthenticatedSession(req) {
  const tokens = req.session.tokens;
  if (!tokens?.accessToken || !tokens?.refreshToken || !tokens?.expiresAt) {
    return null;
  }

  if (Date.now() < tokens.expiresAt - 60_000) {
    return tokens.accessToken;
  }

  const refreshed = await refreshAccessToken(tokens.refreshToken);
  req.session.tokens = {
    accessToken: refreshed.access_token,
    refreshToken: refreshed.refresh_token,
    expiresAt: Date.now() + (refreshed.expires_in * 1000),
  };

  return req.session.tokens.accessToken;
}

async function getCurrentUser(req) {
  const accessToken = await ensureAuthenticatedSession(req);
  if (!accessToken) {
    return null;
  }

  if (req.session.user) {
    return req.session.user;
  }

  const user = await fetchDiscordResource("/users/@me", accessToken);
  req.session.user = user;
  return user;
}

async function getUserGuilds(req) {
  const accessToken = await ensureAuthenticatedSession(req);
  if (!accessToken) {
    return [];
  }

  return fetchDiscordResource("/users/@me/guilds", accessToken);
}

function buildOAuthUrl(state) {
  const params = new URLSearchParams({
    client_id: config.clientId,
    response_type: "code",
    redirect_uri: `${config.dashboardBaseUrl}/auth/callback`,
    scope: "identify guilds",
    state,
    prompt: "consent",
  });

  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

async function resolveDashboardGuilds(req, client) {
  const guilds = await getUserGuilds(req);

  return guilds
    .filter((guild) => hasGuildAccess(guild.permissions, PermissionFlagsBits.ManageGuild))
    .filter((guild) => client.guilds.cache.has(guild.id))
    .map((guild) => ({
      id: guild.id,
      name: guild.name,
      iconUrl: buildGuildIconUrl(guild),
      permissions: guild.permissions,
      botPresent: true,
    }));
}

async function requireDashboardGuild(req, res, client) {
  const guildId = req.params.guildId;
  const userGuilds = await getUserGuilds(req);
  const userGuild = userGuilds.find((guild) => guild.id === guildId);

  if (!userGuild || !hasGuildAccess(userGuild.permissions, PermissionFlagsBits.ManageGuild)) {
    res.status(403).render("home", {
      pageTitle: "Access Denied",
      hero: {
        eyebrow: "Dashboard Access",
        title: "You do not have access to this server.",
        copy: "Make sure you manage the server in Discord and that the bot has already joined it.",
      },
      currentUser: req.session.user || null,
      flash: res.locals.flash,
      oauthReady: Boolean(config.clientSecret),
      botReady: client.isReady(),
      stats: {
        guildCount: client.guilds.cache.size,
        memberCount: client.guilds.cache.reduce((total, guild) => total + guild.memberCount, 0),
      },
    });
    return null;
  }

  const guild =
    client.guilds.cache.get(guildId) ||
    (await client.guilds.fetch(guildId).catch(() => null));

  if (!guild) {
    res.status(404).render("home", {
      pageTitle: "Bot Missing",
      hero: {
        eyebrow: "Dashboard Access",
        title: "The bot is not in that server yet.",
        copy: "Invite the bot to the server first, then come back to the dashboard.",
      },
      currentUser: req.session.user || null,
      flash: res.locals.flash,
      oauthReady: Boolean(config.clientSecret),
      botReady: client.isReady(),
      stats: {
        guildCount: client.guilds.cache.size,
        memberCount: client.guilds.cache.reduce((total, currentGuild) => total + currentGuild.memberCount, 0),
      },
    });
    return null;
  }

  return { guild, userGuild };
}

async function buildGuildDashboardData(guild) {
  await guild.channels.fetch().catch(() => null);
  await guild.roles.fetch().catch(() => null);

  const settings = getGuildSettings(guild.id);
  const textChannels = guild.channels.cache
    .filter(
      (channel) =>
        channel &&
        (channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildAnnouncement),
    )
    .sort((left, right) => left.rawPosition - right.rawPosition)
    .map((channel) => ({
      id: channel.id,
      name: channel.name,
    }));

  const manageableRoles = guild.roles.cache
    .filter((role) => role.id !== guild.id && role.editable && !role.managed)
    .sort((left, right) => right.position - left.position)
    .map((role) => ({
      id: role.id,
      name: role.name,
      color: role.hexColor === "#000000" ? "#ffffff" : role.hexColor,
    }));

  return {
    settings,
    recentWarnings: getRecentWarnings(guild.id, 15),
    subscriptions: listYouTubeSubscriptions(guild.id),
    textChannels,
    manageableRoles,
    stats: {
      members: guild.memberCount,
      channels: guild.channels.cache.size,
      roles: guild.roles.cache.size,
      levelingProfiles: getGuildLevelMemberCount(guild.id),
    },
  };
}

function buildDashboardLocals(client, user = null) {
  return {
    oauthReady: Boolean(config.clientSecret),
    currentUser: user,
    botReady: client.isReady(),
    stats: {
      guildCount: client.guilds.cache.size,
      memberCount: client.guilds.cache.reduce((total, guild) => total + guild.memberCount, 0),
    },
  };
}

function startDashboardServer(client) {
  const app = express();

  app.set("view engine", "ejs");
  app.set("views", path.join(process.cwd(), "views"));

  app.use(express.urlencoded({ extended: true }));
  app.use("/assets", express.static(path.join(process.cwd(), "public")));
  app.use(
    session({
      secret: config.sessionSecret,
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        sameSite: "lax",
        secure: config.dashboardBaseUrl.startsWith("https://"),
        maxAge: 7 * 24 * 60 * 60 * 1000,
      },
    }),
  );

  app.use(async (req, res, next) => {
    res.locals.flash = readFlash(req);
    res.locals.currentYear = new Date().getFullYear();

    try {
      const currentUser = await getCurrentUser(req);
      if (currentUser) {
        res.locals.currentUser = {
          ...currentUser,
          avatarUrl: buildDiscordAvatarUrl(currentUser),
        };
      } else {
        res.locals.currentUser = null;
      }
    } catch (error) {
      console.error("Dashboard auth session error", error);
      req.session.destroy(() => {});
      res.locals.currentUser = null;
    }

    next();
  });

  app.get("/healthz", (req, res) => {
    res.json({
      ok: true,
      dashboard: true,
      botReady: client.isReady(),
      guildCount: client.guilds.cache.size,
    });
  });

  app.get("/", (req, res) => {
    res.render("home", {
      pageTitle: "Amplify Edge Dashboard",
      hero: {
        eyebrow: "Community Control Center",
        title: "Run your Discord server from a clean Mee6-style dashboard.",
        copy:
          "Moderation, welcome setup, automod, YouTube alerts, leveling, and role actions all live in one place.",
      },
      ...buildDashboardLocals(client, res.locals.currentUser),
    });
  });

  app.get("/auth/login", (req, res) => {
    if (!config.clientSecret) {
      setFlash(req, "error", "Add DISCORD_CLIENT_SECRET before using the dashboard login.");
      res.redirect("/");
      return;
    }

    const state = crypto.randomBytes(24).toString("hex");
    req.session.oauthState = state;
    res.redirect(buildOAuthUrl(state));
  });

  app.get("/auth/callback", async (req, res) => {
    if (!req.query.code || req.query.state !== req.session.oauthState) {
      setFlash(req, "error", "Discord login could not be verified. Please try again.");
      res.redirect("/");
      return;
    }

    try {
      const tokenPayload = await exchangeCodeForToken(req.query.code);
      req.session.tokens = {
        accessToken: tokenPayload.access_token,
        refreshToken: tokenPayload.refresh_token,
        expiresAt: Date.now() + (tokenPayload.expires_in * 1000),
      };
      req.session.user = await fetchDiscordResource("/users/@me", tokenPayload.access_token);
      delete req.session.oauthState;
      setFlash(req, "success", "Discord account connected.");
      res.redirect("/dashboard");
    } catch (error) {
      console.error("Discord OAuth callback failed", error);
      setFlash(req, "error", "Discord login failed. Check your redirect URL and client secret.");
      res.redirect("/");
    }
  });

  app.get("/logout", (req, res) => {
    req.session.destroy(() => {
      res.redirect("/");
    });
  });

  app.get("/dashboard", async (req, res) => {
    if (!res.locals.currentUser) {
      setFlash(req, "error", "Please sign in with Discord first.");
      res.redirect("/");
      return;
    }

    try {
      const guilds = await resolveDashboardGuilds(req, client);
      res.render("guilds", {
        pageTitle: "Your Servers",
        guilds,
      });
    } catch (error) {
      console.error("Failed to load dashboard guilds", error);
      setFlash(req, "error", "Could not load your Discord servers right now.");
      res.redirect("/");
    }
  });

  app.get("/dashboard/:guildId", async (req, res) => {
    if (!res.locals.currentUser) {
      setFlash(req, "error", "Please sign in with Discord first.");
      res.redirect("/");
      return;
    }

    try {
      const context = await requireDashboardGuild(req, res, client);
      if (!context) {
        return;
      }

      const dashboardData = await buildGuildDashboardData(context.guild);
      res.render("guild-dashboard", {
        pageTitle: `${context.guild.name} Dashboard`,
        guild: {
          id: context.guild.id,
          name: context.guild.name,
          iconUrl: context.guild.iconURL({ size: 256 }),
        },
        permissions: context.userGuild.permissions,
        ...dashboardData,
      });
    } catch (error) {
      console.error("Failed to load guild dashboard", error);
      setFlash(req, "error", "Could not load that server dashboard.");
      res.redirect("/dashboard");
    }
  });

  app.post("/dashboard/:guildId/settings", async (req, res) => {
    if (!res.locals.currentUser) {
      setFlash(req, "error", "Please sign in with Discord first.");
      res.redirect("/");
      return;
    }

    const context = await requireDashboardGuild(req, res, client);
    if (!context) {
      return;
    }

    try {
      updateGuildSettings(context.guild.id, {
        prefix: req.body.prefix?.trim() || "!",
        log_channel_id: req.body.logChannelId || null,
        welcome_channel_id: req.body.welcomeChannelId || null,
        welcome_message: req.body.welcomeMessage?.trim() || config.defaultWelcomeMessage,
        automod_enabled: req.body.automodEnabled ? 1 : 0,
        invite_filter: req.body.inviteFilter ? 1 : 0,
        caps_threshold: clamp(Number(req.body.capsThreshold || 75), 50, 100),
        spam_window_seconds: clamp(Number(req.body.spamWindowSeconds || 8), 3, 30),
        spam_message_limit: clamp(Number(req.body.spamMessageLimit || 6), 3, 15),
        leveling_enabled: req.body.levelingEnabled ? 1 : 0,
        bad_words: parseWordList(req.body.badWords || ""),
      });

      setFlash(req, "success", "Server configuration updated.");
    } catch (error) {
      console.error("Failed to update guild settings", error);
      setFlash(req, "error", "Server configuration update failed.");
    }

    res.redirect(`/dashboard/${context.guild.id}`);
  });

  app.post("/dashboard/:guildId/moderation", async (req, res) => {
    if (!res.locals.currentUser) {
      setFlash(req, "error", "Please sign in with Discord first.");
      res.redirect("/");
      return;
    }

    const context = await requireDashboardGuild(req, res, client);
    if (!context) {
      return;
    }

    const action = req.body.action;
    const userId = req.body.userId?.trim();
    const reason = req.body.reason?.trim() || "No reason provided";
    const minutes = clamp(Number(req.body.minutes || 10), 1, 40320);

    if (!userId) {
      setFlash(req, "error", "User ID is required for moderation actions.");
      res.redirect(`/dashboard/${context.guild.id}`);
      return;
    }

    try {
      if (action === "warn") {
        if (!hasGuildAccess(context.userGuild.permissions, PermissionFlagsBits.ModerateMembers)) {
          throw new Error("You need Moderate Members permission for warnings.");
        }

        addWarning({
          guildId: context.guild.id,
          userId,
          moderatorId: res.locals.currentUser.id,
          reason,
        });
        await sendLog(context.guild, {
          embeds: [
            buildLogEmbed({
              title: "Dashboard Warning",
              description: `A warning was added by ${res.locals.currentUser.username}.`,
              color: 0xed4245,
              fields: [
                { name: "User ID", value: userId, inline: true },
                { name: "Reason", value: reason },
              ],
            }),
          ],
        });
        setFlash(req, "success", `Warning saved for user ${userId}.`);
        res.redirect(`/dashboard/${context.guild.id}`);
        return;
      }

      const member = await context.guild.members.fetch(userId);

      if (action === "timeout") {
        if (!hasGuildAccess(context.userGuild.permissions, PermissionFlagsBits.ModerateMembers)) {
          throw new Error("You need Moderate Members permission to timeout users.");
        }

        await member.timeout(minutes * 60 * 1000, reason);
        setFlash(req, "success", `Timed out ${member.user.tag} for ${minutes} minute(s).`);
      } else if (action === "untimeout") {
        if (!hasGuildAccess(context.userGuild.permissions, PermissionFlagsBits.ModerateMembers)) {
          throw new Error("You need Moderate Members permission to remove timeouts.");
        }

        await member.timeout(null, reason);
        setFlash(req, "success", `Removed timeout from ${member.user.tag}.`);
      } else if (action === "kick") {
        if (!hasGuildAccess(context.userGuild.permissions, PermissionFlagsBits.KickMembers)) {
          throw new Error("You need Kick Members permission to kick users.");
        }

        await member.kick(reason);
        setFlash(req, "success", `Kicked ${member.user.tag}.`);
      } else if (action === "ban") {
        if (!hasGuildAccess(context.userGuild.permissions, PermissionFlagsBits.BanMembers)) {
          throw new Error("You need Ban Members permission to ban users.");
        }

        await context.guild.members.ban(userId, { reason });
        setFlash(req, "success", `Banned user ${userId}.`);
      } else {
        throw new Error("Unknown moderation action.");
      }
    } catch (error) {
      console.error("Dashboard moderation action failed", error);
      setFlash(req, "error", error.message || "Moderation action failed.");
    }

    res.redirect(`/dashboard/${context.guild.id}`);
  });

  app.post("/dashboard/:guildId/roles", async (req, res) => {
    if (!res.locals.currentUser) {
      setFlash(req, "error", "Please sign in with Discord first.");
      res.redirect("/");
      return;
    }

    const context = await requireDashboardGuild(req, res, client);
    if (!context) {
      return;
    }

    if (!hasGuildAccess(context.userGuild.permissions, PermissionFlagsBits.ManageRoles)) {
      setFlash(req, "error", "You need Manage Roles permission to change member roles.");
      res.redirect(`/dashboard/${context.guild.id}`);
      return;
    }

    try {
      const userId = req.body.userId?.trim();
      const roleId = req.body.roleId;
      const mode = req.body.mode;

      if (!userId || !roleId) {
        throw new Error("User ID and role are required.");
      }

      const member = await context.guild.members.fetch(userId);
      const role = context.guild.roles.cache.get(roleId);

      if (!role || !role.editable) {
        throw new Error("That role cannot be managed by the bot.");
      }

      if (mode === "add") {
        await member.roles.add(role);
        setFlash(req, "success", `Gave ${role.name} to ${member.user.tag}.`);
      } else if (mode === "remove") {
        await member.roles.remove(role);
        setFlash(req, "success", `Removed ${role.name} from ${member.user.tag}.`);
      } else {
        throw new Error("Unknown role action.");
      }
    } catch (error) {
      console.error("Dashboard role action failed", error);
      setFlash(req, "error", error.message || "Role action failed.");
    }

    res.redirect(`/dashboard/${context.guild.id}`);
  });

  app.post("/dashboard/:guildId/youtube/add", async (req, res) => {
    if (!res.locals.currentUser) {
      setFlash(req, "error", "Please sign in with Discord first.");
      res.redirect("/");
      return;
    }

    const context = await requireDashboardGuild(req, res, client);
    if (!context) {
      return;
    }

    try {
      if (!config.youtubeApiKey) {
        throw new Error("Add YOUTUBE_API_KEY to enable YouTube live alerts.");
      }

      const youtubeChannelId = normalizeYouTubeChannelId(req.body.youtubeChannel || "");
      if (!youtubeChannelId) {
        throw new Error("Use a YouTube channel ID like UC... or a /channel/ URL.");
      }

      addYouTubeSubscription({
        guildId: context.guild.id,
        youtubeChannelId,
        discordChannelId: req.body.discordChannelId,
        mentionRoleId: req.body.mentionRoleId || null,
      });

      setFlash(req, "success", `YouTube alerts added for ${youtubeChannelId}.`);
    } catch (error) {
      console.error("Dashboard YouTube subscription add failed", error);
      setFlash(req, "error", error.message || "Could not save YouTube alert.");
    }

    res.redirect(`/dashboard/${context.guild.id}`);
  });

  app.post("/dashboard/:guildId/youtube/remove", async (req, res) => {
    if (!res.locals.currentUser) {
      setFlash(req, "error", "Please sign in with Discord first.");
      res.redirect("/");
      return;
    }

    const context = await requireDashboardGuild(req, res, client);
    if (!context) {
      return;
    }

    const removed = removeYouTubeSubscription({
      guildId: context.guild.id,
      youtubeChannelId: req.body.youtubeChannelId,
      discordChannelId: req.body.discordChannelId,
    });

    setFlash(
      req,
      removed ? "success" : "error",
      removed ? "YouTube live alert removed." : "That YouTube subscription was not found.",
    );
    res.redirect(`/dashboard/${context.guild.id}`);
  });

  const server = app.listen(config.port, config.host, () => {
    console.log(`Dashboard listening on ${config.host}:${config.port} as ${config.dashboardBaseUrl}`);
  });

  return server;
}

module.exports = {
  startDashboardServer,
};
