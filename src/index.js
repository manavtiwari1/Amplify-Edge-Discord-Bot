const { REST, Routes } = require("discord.js");
const {
  Client,
  Events,
  GatewayIntentBits,
} = require("discord.js");
const config = require("./config");
const { commands, handleInteraction } = require("./commands");
const { runAutoMod } = require("./lib/automod");
const {
  getGuildSettings,
  getLeaderboard,
  getRank,
  initDatabase,
} = require("./lib/database");
const { awardMessageXp, getProgress } = require("./lib/leveling");
const { buildLogEmbed, sendLog } = require("./lib/logging");
const { formatWelcomeMessage, truncate } = require("./lib/utils");
const { startYouTubeMonitor } = require("./lib/youtube");

function validateEnvironment() {
  const missing = [];

  if (!config.token) {
    missing.push("DISCORD_BOT_TOKEN");
  }

  if (!config.clientId) {
    missing.push("DISCORD_CLIENT_ID");
  }

  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }
}

async function registerSlashCommands() {
  const rest = new REST({ version: "10" }).setToken(config.token);
  const body = commands.map((command) => command.data.toJSON());

  if (config.devGuildId) {
    await rest.put(
      Routes.applicationGuildCommands(config.clientId, config.devGuildId),
      { body },
    );
    return `guild ${config.devGuildId}`;
  }

  await rest.put(Routes.applicationCommands(config.clientId), { body });
  return "globally";
}

async function main() {
  validateEnvironment();
  initDatabase();

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildModeration,
      GatewayIntentBits.MessageContent,
    ],
  });

  client.once(Events.ClientReady, async (readyClient) => {
    const scope = await registerSlashCommands();
    console.log(`Logged in as ${readyClient.user.tag}`);
    console.log(`Registered slash commands for ${scope}`);
    startYouTubeMonitor(readyClient);
  });

  client.on(Events.InteractionCreate, handleInteraction);

  client.on(Events.MessageCreate, async (message) => {
    if (!message.inGuild() || message.author.bot) {
      return;
    }

    const settings = getGuildSettings(message.guild.id);
    const automodResult = await runAutoMod(message, settings);

    if (automodResult) {
      await sendLog(message.guild, {
        embeds: [
          buildLogEmbed({
            title: "AutoMod Triggered",
            description: `${message.author} had a message removed.`,
            color: 0xed4245,
            fields: [
              { name: "Reason", value: automodResult.reason },
              { name: "Excerpt", value: automodResult.excerpt || "No excerpt" },
            ],
          }),
        ],
      });
      return;
    }

    if (message.content.startsWith(settings.prefix)) {
      const [rawCommand] = message.content.slice(settings.prefix.length).trim().split(/\s+/);
      const commandName = (rawCommand || "").toLowerCase();

      if (commandName === "help") {
        await message.channel.send(
          [
            `Use \`${settings.prefix}rank\` to check your XP rank.`,
            `Use \`${settings.prefix}leaderboard\` to see top members.`,
            "Use slash commands like `/config`, `/warn`, and `/timeout` for admin features.",
          ].join("\n"),
        ).catch(() => null);
        return;
      }

      if (commandName === "rank") {
        const targetUser = message.mentions.users.first() || message.author;
        const rank = getRank(message.guild.id, targetUser.id);
        const progress = getProgress(rank);

        await message.channel.send(
          `${targetUser} is Level ${rank.level} with ${rank.xp} XP (${progress.progressXp}/${progress.requiredXp} toward next level).`,
        ).catch(() => null);
        return;
      }

      if (commandName === "leaderboard") {
        const topUsers = getLeaderboard(message.guild.id, 10);
        const lines = await Promise.all(
          topUsers.map(async (entry, index) => {
            const user = await client.users.fetch(entry.user_id).catch(() => null);
            const label = user ? user.username : `Unknown User (${entry.user_id})`;
            return `${index + 1}. ${label} - Level ${entry.level} (${entry.xp} XP)`;
          }),
        );

        await message.channel.send(
          lines.length ? lines.join("\n") : "Nobody has earned XP yet.",
        ).catch(() => null);
        return;
      }
    }

    if (!settings.levelingEnabled) {
      return;
    }

    const result = awardMessageXp(message.guild.id, message.author.id);
    if (!result || !result.leveledUp) {
      return;
    }

    await message.channel.send(
      `${message.author}, you leveled up to **Level ${result.level}**.`,
    ).catch(() => null);
  });

  client.on(Events.GuildMemberAdd, async (member) => {
    const settings = getGuildSettings(member.guild.id);
    if (settings.welcomeChannelId) {
      const channel =
        member.guild.channels.cache.get(settings.welcomeChannelId) ||
        (await member.guild.channels.fetch(settings.welcomeChannelId).catch(() => null));

      if (channel && channel.isTextBased()) {
        const message = formatWelcomeMessage(settings.welcomeMessage, member);
        await channel.send(message).catch(() => null);
      }
    }

    await sendLog(member.guild, {
      embeds: [
        buildLogEmbed({
          title: "Member Joined",
          description: `${member.user} joined the server.`,
          color: 0x57f287,
        }),
      ],
    });
  });

  client.on(Events.GuildMemberRemove, async (member) => {
    await sendLog(member.guild, {
      embeds: [
        buildLogEmbed({
          title: "Member Left",
          description: `${member.user.tag} left or was removed.`,
          color: 0xfaa61a,
        }),
      ],
    });
  });

  client.on(Events.MessageDelete, async (message) => {
    if (!message.inGuild() || !message.author || message.author.bot) {
      return;
    }

    await sendLog(message.guild, {
      embeds: [
        buildLogEmbed({
          title: "Message Deleted",
          description: `${message.author} had a message deleted in ${message.channel}.`,
          color: 0xfaa61a,
          fields: [{ name: "Content", value: truncate(message.content || "No cached content") }],
        }),
      ],
    });
  });

  client.on(Events.MessageUpdate, async (oldMessage, newMessage) => {
    if (!newMessage.inGuild() || !newMessage.author || newMessage.author.bot) {
      return;
    }

    if (oldMessage.content === newMessage.content) {
      return;
    }

    await sendLog(newMessage.guild, {
      embeds: [
        buildLogEmbed({
          title: "Message Edited",
          description: `${newMessage.author} edited a message in ${newMessage.channel}.`,
          color: 0x5865f2,
          fields: [
            { name: "Before", value: truncate(oldMessage.content || "No cached content") },
            { name: "After", value: truncate(newMessage.content || "No content") },
          ],
        }),
      ],
    });
  });

  client.on(Events.GuildBanAdd, async (ban) => {
    await sendLog(ban.guild, {
      embeds: [
        buildLogEmbed({
          title: "User Banned",
          description: `${ban.user.tag} was banned.`,
          color: 0xed4245,
        }),
      ],
    });
  });

  await client.login(config.token);
}

main().catch((error) => {
  console.error("Fatal startup error:", error);
  process.exit(1);
});
