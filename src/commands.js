const {
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} = require("discord.js");
const {
  addWarning,
  getGuildSettings,
  getLeaderboard,
  getRank,
  getWarnings,
  updateGuildSettings,
} = require("./lib/database");
const { getProgress } = require("./lib/leveling");
const { buildLogEmbed, sendLog } = require("./lib/logging");
const { clamp, parseWordList } = require("./lib/utils");
const config = require("./config");
const {
  addYouTubeSubscription,
  listYouTubeSubscriptions,
  normalizeYouTubeChannelId,
  removeYouTubeSubscription,
} = require("./lib/youtube");

function createInfoEmbed(title, description) {
  return new EmbedBuilder().setColor(0x5865f2).setTitle(title).setDescription(description);
}

const commands = [
  {
    data: new SlashCommandBuilder()
      .setName("ping")
      .setDescription("Check if the bot is alive.")
      .setDMPermission(false),
    async execute(interaction) {
      await interaction.reply({
        content: `Pong. API latency is ${interaction.client.ws.ping}ms.`,
        flags: MessageFlags.Ephemeral,
      });
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName("help")
      .setDescription("Show the main bot features.")
      .setDMPermission(false),
    async execute(interaction) {
      const embed = createInfoEmbed(
        "Community Bot Help",
        [
          "`/config` manages logs, welcome settings, automod, and leveling.",
          "`/warn`, `/kick`, `/ban`, `/timeout`, `/clear` cover moderation.",
          "`/rank` and `/leaderboard` power the leveling system.",
          "`/serverinfo` gives a quick overview of the server.",
        ].join("\n"),
      );

      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName("serverinfo")
      .setDescription("Get an overview of the current server.")
      .setDMPermission(false),
    async execute(interaction) {
      const { guild } = interaction;
      const embed = new EmbedBuilder()
        .setColor(0x57f287)
        .setTitle(`${guild.name} Overview`)
        .addFields(
          { name: "Members", value: String(guild.memberCount), inline: true },
          { name: "Channels", value: String(guild.channels.cache.size), inline: true },
          { name: "Roles", value: String(guild.roles.cache.size), inline: true },
          { name: "Created", value: `<t:${Math.floor(guild.createdTimestamp / 1000)}:F>` },
        )
        .setTimestamp();

      const iconUrl = guild.iconURL();
      if (iconUrl) {
        embed.setThumbnail(iconUrl);
      }

      await interaction.reply({ embeds: [embed] });
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName("rank")
      .setDescription("Check your current XP rank.")
      .addUserOption((option) =>
        option.setName("user").setDescription("User to inspect").setRequired(false),
      )
      .setDMPermission(false),
    async execute(interaction) {
      const targetUser = interaction.options.getUser("user") || interaction.user;
      const rank = getRank(interaction.guild.id, targetUser.id);
      const progress = getProgress(rank);

      const embed = new EmbedBuilder()
        .setColor(0xfee75c)
        .setTitle(`${targetUser.username}'s Rank`)
        .addFields(
          { name: "Level", value: String(rank.level), inline: true },
          { name: "Total XP", value: String(rank.xp), inline: true },
          {
            name: "Progress",
            value: `${progress.progressXp}/${progress.requiredXp} XP`,
            inline: true,
          },
        );

      await interaction.reply({ embeds: [embed] });
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName("leaderboard")
      .setDescription("Show the top 10 users by XP.")
      .setDMPermission(false),
    async execute(interaction) {
      const topUsers = getLeaderboard(interaction.guild.id, 10);
      const lines = await Promise.all(
        topUsers.map(async (entry, index) => {
          const user = await interaction.client.users.fetch(entry.user_id).catch(() => null);
          const label = user ? user.username : `Unknown User (${entry.user_id})`;
          return `**${index + 1}.** ${label} - Level ${entry.level} (${entry.xp} XP)`;
        }),
      );

      const embed = createInfoEmbed(
        `${interaction.guild.name} Leaderboard`,
        lines.length ? lines.join("\n") : "Nobody has earned XP yet.",
      );

      await interaction.reply({ embeds: [embed] });
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName("warn")
      .setDescription("Warn a member and save the warning.")
      .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
      .addUserOption((option) =>
        option.setName("user").setDescription("Member to warn").setRequired(true),
      )
      .addStringOption((option) =>
        option.setName("reason").setDescription("Warning reason").setRequired(true),
      )
      .setDMPermission(false),
    async execute(interaction) {
      const targetUser = interaction.options.getUser("user", true);
      const reason = interaction.options.getString("reason", true);

      addWarning({
        guildId: interaction.guild.id,
        userId: targetUser.id,
        moderatorId: interaction.user.id,
        reason,
      });

      await interaction.reply(`Saved a warning for ${targetUser}.`);

      await sendLog(
        interaction.guild,
        {
          embeds: [
            buildLogEmbed({
              title: "Member Warned",
              description: `${targetUser} was warned by ${interaction.user}.`,
              color: 0xed4245,
              fields: [{ name: "Reason", value: reason }],
            }),
          ],
        },
      );
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName("warnings")
      .setDescription("View a member's warning history.")
      .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
      .addUserOption((option) =>
        option.setName("user").setDescription("Member to inspect").setRequired(true),
      )
      .setDMPermission(false),
    async execute(interaction) {
      const targetUser = interaction.options.getUser("user", true);
      const warnings = getWarnings(interaction.guild.id, targetUser.id);
      const description = warnings.length
        ? warnings
            .slice(0, 10)
            .map(
              (warning) =>
                `**#${warning.id}** <t:${Math.floor(new Date(warning.created_at).getTime() / 1000)}:R> - ${warning.reason}`,
            )
            .join("\n")
        : "No warnings on record.";

      const embed = createInfoEmbed(`${targetUser.username}'s Warnings`, description);
      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName("clear")
      .setDescription("Bulk delete recent messages from the current channel.")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
      .addIntegerOption((option) =>
        option
          .setName("amount")
          .setDescription("How many messages to remove (1-100)")
          .setMinValue(1)
          .setMaxValue(100)
          .setRequired(true),
      )
      .setDMPermission(false),
    async execute(interaction) {
      const amount = interaction.options.getInteger("amount", true);
      const deleted = await interaction.channel.bulkDelete(amount, true);

      await interaction.reply({
        content: `Deleted ${deleted.size} messages.`,
        flags: MessageFlags.Ephemeral,
      });
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName("kick")
      .setDescription("Kick a member from the server.")
      .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers)
      .addUserOption((option) =>
        option.setName("user").setDescription("Member to kick").setRequired(true),
      )
      .addStringOption((option) =>
        option.setName("reason").setDescription("Kick reason").setRequired(false),
      )
      .setDMPermission(false),
    async execute(interaction) {
      const member = interaction.options.getMember("user");
      const reason = interaction.options.getString("reason") || "No reason provided";

      if (!member || !member.kickable) {
        await interaction.reply({
          content: "I can't kick that member. Check role hierarchy and permissions.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await member.kick(reason);
      await interaction.reply(`Kicked ${member.user.tag}.`);

      await sendLog(interaction.guild, {
        embeds: [
          buildLogEmbed({
            title: "Member Kicked",
            description: `${member.user} was kicked by ${interaction.user}.`,
            color: 0xed4245,
            fields: [{ name: "Reason", value: reason }],
          }),
        ],
      });
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName("ban")
      .setDescription("Ban a user from the server.")
      .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
      .addUserOption((option) =>
        option.setName("user").setDescription("User to ban").setRequired(true),
      )
      .addStringOption((option) =>
        option.setName("reason").setDescription("Ban reason").setRequired(false),
      )
      .setDMPermission(false),
    async execute(interaction) {
      const targetUser = interaction.options.getUser("user", true);
      const reason = interaction.options.getString("reason") || "No reason provided";

      await interaction.guild.members.ban(targetUser.id, { reason });
      await interaction.reply(`Banned ${targetUser.tag}.`);

      await sendLog(interaction.guild, {
        embeds: [
          buildLogEmbed({
            title: "Member Banned",
            description: `${targetUser} was banned by ${interaction.user}.`,
            color: 0xed4245,
            fields: [{ name: "Reason", value: reason }],
          }),
        ],
      });
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName("youtube")
      .setDescription("Configure YouTube live notifications.")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addSubcommand((subcommand) =>
        subcommand
          .setName("add")
          .setDescription("Subscribe to a YouTube channel's live alerts.")
          .addStringOption((option) =>
            option
              .setName("channel")
              .setDescription("YouTube channel ID or /channel/ URL")
              .setRequired(true),
          )
          .addChannelOption((option) =>
            option
              .setName("discord-channel")
              .setDescription("Discord channel for live alerts")
              .setRequired(true),
          )
          .addRoleOption((option) =>
            option
              .setName("mention-role")
              .setDescription("Optional role to mention when going live")
              .setRequired(false),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("remove")
          .setDescription("Remove a YouTube live alert subscription.")
          .addStringOption((option) =>
            option
              .setName("channel")
              .setDescription("YouTube channel ID or /channel/ URL")
              .setRequired(true),
          )
          .addChannelOption((option) =>
            option
              .setName("discord-channel")
              .setDescription("Discord channel used for alerts")
              .setRequired(true),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand.setName("list").setDescription("List YouTube live alert subscriptions."),
      )
      .setDMPermission(false),
    async execute(interaction) {
      if (!config.youtubeApiKey) {
        await interaction.reply({
          content: "YouTube alerts are not configured yet. Add `YOUTUBE_API_KEY` to the bot's `.env` file first.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const subcommand = interaction.options.getSubcommand();

      if (subcommand === "list") {
        const subscriptions = listYouTubeSubscriptions(interaction.guild.id);
        const description = subscriptions.length
          ? subscriptions
              .map((subscription, index) => {
                const label = subscription.youtube_channel_name || subscription.youtube_channel_id;
                const mentionRole = subscription.mention_role_id ? ` <@&${subscription.mention_role_id}>` : "";
                return `**${index + 1}.** ${label} -> <#${subscription.discord_channel_id}>${mentionRole}`;
              })
              .join("\n")
          : "No YouTube live alert subscriptions yet.";

        await interaction.reply({
          embeds: [createInfoEmbed("YouTube Live Alerts", description)],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const rawChannel = interaction.options.getString("channel", true);
      const youtubeChannelId = normalizeYouTubeChannelId(rawChannel);
      if (!youtubeChannelId) {
        await interaction.reply({
          content: "Please provide a YouTube channel ID like `UC...` or a `/channel/UC...` URL.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const discordChannel = interaction.options.getChannel("discord-channel", true);

      if (subcommand === "add") {
        const mentionRole = interaction.options.getRole("mention-role");
        addYouTubeSubscription({
          guildId: interaction.guild.id,
          youtubeChannelId,
          discordChannelId: discordChannel.id,
          mentionRoleId: mentionRole?.id || null,
        });

        await interaction.reply({
          content: `YouTube live alerts enabled for \`${youtubeChannelId}\` in ${discordChannel}.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const removed = removeYouTubeSubscription({
        guildId: interaction.guild.id,
        youtubeChannelId,
        discordChannelId: discordChannel.id,
      });

      await interaction.reply({
        content: removed
          ? `Removed YouTube live alerts for \`${youtubeChannelId}\` from ${discordChannel}.`
          : "No matching YouTube live alert subscription was found.",
        flags: MessageFlags.Ephemeral,
      });
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName("role")
      .setDescription("Add or remove a role from a member.")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
      .addSubcommand((subcommand) =>
        subcommand
          .setName("add")
          .setDescription("Give a role to a member.")
          .addUserOption((option) =>
            option.setName("user").setDescription("Member to update").setRequired(true),
          )
          .addRoleOption((option) =>
            option.setName("role").setDescription("Role to give").setRequired(true),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("remove")
          .setDescription("Remove a role from a member.")
          .addUserOption((option) =>
            option.setName("user").setDescription("Member to update").setRequired(true),
          )
          .addRoleOption((option) =>
            option.setName("role").setDescription("Role to remove").setRequired(true),
          ),
      )
      .setDMPermission(false),
    async execute(interaction) {
      const subcommand = interaction.options.getSubcommand();
      const member = interaction.options.getMember("user");
      const role = interaction.options.getRole("role", true);

      if (!member) {
        await interaction.reply({
          content: "I couldn't find that member in this server.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (!role.editable) {
        await interaction.reply({
          content: "I can't manage that role. Move my role above it and make sure I have Manage Roles.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (subcommand === "add") {
        if (member.roles.cache.has(role.id)) {
          await interaction.reply({
            content: `${member.user.tag} already has the ${role} role.`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        await member.roles.add(role);
        await interaction.reply(`Gave ${role} to ${member.user.tag}.`);

        await sendLog(interaction.guild, {
          embeds: [
            buildLogEmbed({
              title: "Role Added",
              description: `${interaction.user} gave ${role} to ${member.user}.`,
              color: 0x57f287,
            }),
          ],
        });
        return;
      }

      if (!member.roles.cache.has(role.id)) {
        await interaction.reply({
          content: `${member.user.tag} does not have the ${role} role.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await member.roles.remove(role);
      await interaction.reply(`Removed ${role} from ${member.user.tag}.`);

      await sendLog(interaction.guild, {
        embeds: [
          buildLogEmbed({
            title: "Role Removed",
            description: `${interaction.user} removed ${role} from ${member.user}.`,
            color: 0xfaa61a,
          }),
        ],
      });
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName("mute")
      .setDescription("Mute a member for a set number of minutes.")
      .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
      .addUserOption((option) =>
        option.setName("user").setDescription("Member to mute").setRequired(true),
      )
      .addIntegerOption((option) =>
        option
          .setName("minutes")
          .setDescription("Mute duration in minutes")
          .setMinValue(1)
          .setMaxValue(40320)
          .setRequired(true),
      )
      .addStringOption((option) =>
        option.setName("reason").setDescription("Mute reason").setRequired(false),
      )
      .setDMPermission(false),
    async execute(interaction) {
      const member = interaction.options.getMember("user");
      const minutes = interaction.options.getInteger("minutes", true);
      const reason = interaction.options.getString("reason") || "No reason provided";

      if (!member || !member.moderatable) {
        await interaction.reply({
          content: "I can't mute that member. Check role hierarchy and permissions.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await member.timeout(minutes * 60 * 1000, reason);
      await interaction.reply(`Muted ${member.user.tag} for ${minutes} minute(s).`);

      await sendLog(interaction.guild, {
        embeds: [
          buildLogEmbed({
            title: "Member Muted",
            description: `${member.user} was muted by ${interaction.user}.`,
            color: 0xed4245,
            fields: [
              { name: "Duration", value: `${minutes} minute(s)`, inline: true },
              { name: "Reason", value: reason },
            ],
          }),
        ],
      });
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName("timeout")
      .setDescription("Temporarily timeout a member.")
      .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
      .addUserOption((option) =>
        option.setName("user").setDescription("Member to timeout").setRequired(true),
      )
      .addIntegerOption((option) =>
        option
          .setName("minutes")
          .setDescription("Timeout duration in minutes")
          .setMinValue(1)
          .setMaxValue(40320)
          .setRequired(true),
      )
      .addStringOption((option) =>
        option.setName("reason").setDescription("Timeout reason").setRequired(false),
      )
      .setDMPermission(false),
    async execute(interaction) {
      const member = interaction.options.getMember("user");
      const minutes = interaction.options.getInteger("minutes", true);
      const reason = interaction.options.getString("reason") || "No reason provided";

      if (!member || !member.moderatable) {
        await interaction.reply({
          content: "I can't timeout that member. Check role hierarchy and permissions.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await member.timeout(minutes * 60 * 1000, reason);
      await interaction.reply(`Timed out ${member.user.tag} for ${minutes} minute(s).`);
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName("untimeout")
      .setDescription("Remove a timeout from a member.")
      .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
      .addUserOption((option) =>
        option.setName("user").setDescription("Member to untimeout").setRequired(true),
      )
      .addStringOption((option) =>
        option.setName("reason").setDescription("Reason").setRequired(false),
      )
      .setDMPermission(false),
    async execute(interaction) {
      const member = interaction.options.getMember("user");
      const reason = interaction.options.getString("reason") || "Timeout removed";

      if (!member || !member.moderatable) {
        await interaction.reply({
          content: "I can't modify that member's timeout. Check role hierarchy and permissions.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await member.timeout(null, reason);
      await interaction.reply(`Removed timeout from ${member.user.tag}.`);
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName("config")
      .setDescription("Configure the bot for this server.")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addSubcommand((subcommand) =>
        subcommand.setName("view").setDescription("Show the current configuration."),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("logs")
          .setDescription("Set the moderation log channel.")
          .addChannelOption((option) =>
            option.setName("channel").setDescription("Channel for logs").setRequired(true),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("welcome")
          .setDescription("Set the welcome channel.")
          .addChannelOption((option) =>
            option.setName("channel").setDescription("Channel for welcomes").setRequired(true),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("welcome-message")
          .setDescription("Update the welcome message.")
          .addStringOption((option) =>
            option
              .setName("message")
              .setDescription("Use {user}, {server}, and {memberCount}")
              .setRequired(true),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("automod")
          .setDescription("Update automod settings.")
          .addBooleanOption((option) =>
            option.setName("enabled").setDescription("Master automod switch").setRequired(true),
          )
          .addBooleanOption((option) =>
            option
              .setName("invite-filter")
              .setDescription("Block Discord invite links")
              .setRequired(false),
          )
          .addIntegerOption((option) =>
            option
              .setName("caps-threshold")
              .setDescription("Delete messages above this uppercase ratio")
              .setMinValue(50)
              .setMaxValue(100)
              .setRequired(false),
          )
          .addIntegerOption((option) =>
            option
              .setName("spam-window")
              .setDescription("Spam detection window in seconds")
              .setMinValue(3)
              .setMaxValue(30)
              .setRequired(false),
          )
          .addIntegerOption((option) =>
            option
              .setName("spam-limit")
              .setDescription("Messages allowed inside the spam window")
              .setMinValue(3)
              .setMaxValue(15)
              .setRequired(false),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("leveling")
          .setDescription("Enable or disable leveling.")
          .addBooleanOption((option) =>
            option.setName("enabled").setDescription("Leveling status").setRequired(true),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("badwords-add")
          .setDescription("Add blocked words separated by commas.")
          .addStringOption((option) =>
            option.setName("words").setDescription("Comma-separated word list").setRequired(true),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("badwords-remove")
          .setDescription("Remove blocked words separated by commas.")
          .addStringOption((option) =>
            option.setName("words").setDescription("Comma-separated word list").setRequired(true),
          ),
      )
      .setDMPermission(false),
    async execute(interaction) {
      const subcommand = interaction.options.getSubcommand();
      const guildId = interaction.guild.id;

      if (subcommand === "view") {
        const settings = getGuildSettings(guildId);
        const embed = new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle("Current Bot Configuration")
          .addFields(
            {
              name: "Log Channel",
              value: settings.logChannelId ? `<#${settings.logChannelId}>` : "Not set",
              inline: true,
            },
            {
              name: "Welcome Channel",
              value: settings.welcomeChannelId ? `<#${settings.welcomeChannelId}>` : "Not set",
              inline: true,
            },
            {
              name: "Leveling",
              value: settings.levelingEnabled ? "Enabled" : "Disabled",
              inline: true,
            },
            {
              name: "AutoMod",
              value: settings.automodEnabled ? "Enabled" : "Disabled",
              inline: true,
            },
            {
              name: "Invite Filter",
              value: settings.inviteFilter ? "Enabled" : "Disabled",
              inline: true,
            },
            {
              name: "Spam Policy",
              value: `${settings.spamMessageLimit} messages / ${settings.spamWindowSeconds}s`,
              inline: true,
            },
            {
              name: "Caps Threshold",
              value: `${settings.capsThreshold}%`,
              inline: true,
            },
            {
              name: "Blocked Words",
              value: settings.badWords.length ? settings.badWords.join(", ") : "None",
            },
            {
              name: "Welcome Message",
              value: settings.welcomeMessage,
            },
          );

        await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
        return;
      }

      if (subcommand === "logs") {
        const channel = interaction.options.getChannel("channel", true);
        updateGuildSettings(guildId, { log_channel_id: channel.id });
        await interaction.reply({
          content: `Log channel set to ${channel}.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (subcommand === "welcome") {
        const channel = interaction.options.getChannel("channel", true);
        updateGuildSettings(guildId, { welcome_channel_id: channel.id });
        await interaction.reply({
          content: `Welcome channel set to ${channel}.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (subcommand === "welcome-message") {
        const message = interaction.options.getString("message", true);
        updateGuildSettings(guildId, { welcome_message: message });
        await interaction.reply({
          content: "Welcome message updated.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (subcommand === "automod") {
        const settings = getGuildSettings(guildId);
        const enabled = interaction.options.getBoolean("enabled", true);
        const inviteFilter = interaction.options.getBoolean("invite-filter");
        const capsThreshold = interaction.options.getInteger("caps-threshold");
        const spamWindow = interaction.options.getInteger("spam-window");
        const spamLimit = interaction.options.getInteger("spam-limit");

        updateGuildSettings(guildId, {
          automod_enabled: enabled ? 1 : 0,
          invite_filter: inviteFilter === null ? Number(settings.inviteFilter) : Number(inviteFilter),
          caps_threshold:
            capsThreshold === null ? settings.capsThreshold : clamp(capsThreshold, 50, 100),
          spam_window_seconds:
            spamWindow === null ? settings.spamWindowSeconds : clamp(spamWindow, 3, 30),
          spam_message_limit:
            spamLimit === null ? settings.spamMessageLimit : clamp(spamLimit, 3, 15),
        });

        await interaction.reply({
          content: "AutoMod settings updated.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (subcommand === "leveling") {
        const enabled = interaction.options.getBoolean("enabled", true);
        updateGuildSettings(guildId, { leveling_enabled: enabled ? 1 : 0 });
        await interaction.reply({
          content: `Leveling ${enabled ? "enabled" : "disabled"}.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (subcommand === "badwords-add") {
        const settings = getGuildSettings(guildId);
        const words = parseWordList(interaction.options.getString("words", true));
        const mergedWords = [...new Set([...settings.badWords, ...words])];
        updateGuildSettings(guildId, { bad_words: mergedWords });
        await interaction.reply({
          content: `Added ${words.length} blocked word(s).`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (subcommand === "badwords-remove") {
        const settings = getGuildSettings(guildId);
        const words = parseWordList(interaction.options.getString("words", true));
        const nextWords = settings.badWords.filter((word) => !words.includes(word));
        updateGuildSettings(guildId, { bad_words: nextWords });
        await interaction.reply({
          content: `Removed ${words.length} blocked word(s).`,
          flags: MessageFlags.Ephemeral,
        });
      }
    },
  },
];

const commandMap = new Map(commands.map((command) => [command.data.name, command]));

async function handleInteraction(interaction) {
  if (!interaction.isChatInputCommand()) {
    return;
  }

  const command = commandMap.get(interaction.commandName);
  if (!command) {
    return;
  }

  try {
    await command.execute(interaction);
  } catch (error) {
    console.error(`Command failed: ${interaction.commandName}`, error);
    const replyPayload = {
      content: "That command ran into an error. Check the bot logs for details.",
      flags: MessageFlags.Ephemeral,
    };

    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(replyPayload).catch(() => null);
      return;
    }

    await interaction.reply(replyPayload).catch(() => null);
  }
}

module.exports = {
  commands,
  handleInteraction,
};
