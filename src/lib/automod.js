const { truncate } = require("./utils");

const spamTracker = new Map();

function getSpamBucket(message) {
  const key = `${message.guild.id}:${message.author.id}`;
  if (!spamTracker.has(key)) {
    spamTracker.set(key, []);
  }

  return spamTracker.get(key);
}

async function deleteAndNotify(message, reason) {
  await message.delete().catch(() => null);
  const notice = await message.channel
    .send(`AutoMod removed a message from ${message.author} for ${reason}.`)
    .catch(() => null);

  if (notice) {
    setTimeout(() => {
      notice.delete().catch(() => null);
    }, 5000);
  }
}

async function runAutoMod(message, settings) {
  if (!settings.automodEnabled || !message.inGuild() || message.author.bot) {
    return null;
  }

  const content = message.content.trim();
  if (!content) {
    return null;
  }

  if (
    settings.inviteFilter &&
    /(discord\.gg\/|discord\.com\/invite\/|discordapp\.com\/invite\/)/i.test(content)
  ) {
    await deleteAndNotify(message, "posting invite links");
    return {
      action: "deleted",
      reason: "Invite link blocked",
      excerpt: truncate(content),
    };
  }

  const lowerContent = content.toLowerCase();
  const matchedBadWord = settings.badWords.find((word) => lowerContent.includes(word));
  if (matchedBadWord) {
    await deleteAndNotify(message, `using a blocked word (${matchedBadWord})`);
    return {
      action: "deleted",
      reason: `Blocked word: ${matchedBadWord}`,
      excerpt: truncate(content),
    };
  }

  const letters = content.match(/[a-z]/gi) || [];
  const uppercaseLetters = content.match(/[A-Z]/g) || [];
  if (letters.length >= 12) {
    const uppercaseRatio = (uppercaseLetters.length / letters.length) * 100;
    if (uppercaseRatio >= settings.capsThreshold) {
      await deleteAndNotify(message, "excessive capital letters");
      return {
        action: "deleted",
        reason: `Caps ratio ${uppercaseRatio.toFixed(0)}%`,
        excerpt: truncate(content),
      };
    }
  }

  const now = Date.now();
  const bucket = getSpamBucket(message);
  const threshold = now - (settings.spamWindowSeconds * 1000);
  const recentEntries = bucket.filter((timestamp) => timestamp >= threshold);
  recentEntries.push(now);
  spamTracker.set(`${message.guild.id}:${message.author.id}`, recentEntries);

  if (recentEntries.length >= settings.spamMessageLimit) {
    await deleteAndNotify(message, "spam");
    return {
      action: "deleted",
      reason: `Spam detected (${recentEntries.length} messages in ${settings.spamWindowSeconds}s)`,
      excerpt: truncate(content),
    };
  }

  return null;
}

module.exports = {
  runAutoMod,
};
