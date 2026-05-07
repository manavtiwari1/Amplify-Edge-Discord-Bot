const { getRank, saveRank } = require("./database");

function getXpForLevel(level) {
  return (level * level * 75) + (level * 25);
}

function getProgress(rank) {
  const currentLevelXp = getXpForLevel(rank.level);
  const nextLevelXp = getXpForLevel(rank.level + 1);

  return {
    currentLevelXp,
    nextLevelXp,
    progressXp: rank.xp - currentLevelXp,
    requiredXp: nextLevelXp - currentLevelXp,
  };
}

function awardMessageXp(guildId, userId) {
  const rank = getRank(guildId, userId);
  const now = Date.now();
  const lastMessageAt = rank.last_message_at ? new Date(rank.last_message_at).getTime() : 0;
  const cooldownMs = 45 * 1000;

  if (now - lastMessageAt < cooldownMs) {
    return null;
  }

  const gainedXp = 15 + Math.floor(Math.random() * 11);
  const nextRank = {
    xp: rank.xp + gainedXp,
    level: rank.level,
  };

  let leveledUp = false;
  while (nextRank.xp >= getXpForLevel(nextRank.level + 1)) {
    nextRank.level += 1;
    leveledUp = true;
  }

  saveRank({
    guildId,
    userId,
    xp: nextRank.xp,
    level: nextRank.level,
    lastMessageAt: new Date(now).toISOString(),
  });

  return {
    ...nextRank,
    gainedXp,
    leveledUp,
    progress: getProgress(nextRank),
  };
}

module.exports = {
  awardMessageXp,
  getProgress,
  getXpForLevel,
};
