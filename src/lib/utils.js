function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function parseWordList(rawValue) {
  if (!rawValue) {
    return [];
  }

  return [...new Set(
    rawValue
      .split(",")
      .map((word) => word.trim().toLowerCase())
      .filter(Boolean),
  )];
}

function truncate(text, maxLength = 300) {
  if (!text) {
    return "No content";
  }

  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength - 3)}...`;
}

function formatWelcomeMessage(template, member) {
  return template
    .replaceAll("{user}", `<@${member.id}>`)
    .replaceAll("{server}", member.guild.name)
    .replaceAll("{memberCount}", String(member.guild.memberCount));
}

module.exports = {
  clamp,
  parseWordList,
  truncate,
  formatWelcomeMessage,
};
