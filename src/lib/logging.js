const { EmbedBuilder } = require("discord.js");
const { getGuildSettings } = require("./database");

async function sendLog(guild, payload) {
  const settings = getGuildSettings(guild.id);
  if (!settings.logChannelId) {
    return;
  }

  const channel =
    guild.channels.cache.get(settings.logChannelId) ||
    (await guild.channels.fetch(settings.logChannelId).catch(() => null));

  if (!channel || !channel.isTextBased()) {
    return;
  }

  await channel.send(payload).catch(() => null);
}

function buildLogEmbed({ title, description, color = 0x5865f2, fields = [] }) {
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(color)
    .setTimestamp();

  if (fields.length) {
    embed.addFields(fields);
  }

  return embed;
}

module.exports = {
  sendLog,
  buildLogEmbed,
};
