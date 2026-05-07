const { EmbedBuilder } = require("discord.js");
const config = require("../config");
const {
  addYouTubeSubscription,
  getAllYouTubeSubscriptions,
  listYouTubeSubscriptions,
  removeYouTubeSubscription,
  updateYouTubeSubscription,
} = require("./database");

const FEED_CANDIDATE_LIMIT = 5;
const YOUTUBE_CHANNEL_ID_PATTERN = /(?:youtube\.com\/channel\/)?(UC[\w-]{22})/i;

let pollTimer = null;
let pollInFlight = false;

function normalizeYouTubeChannelId(input) {
  const trimmed = input.trim();
  const match = trimmed.match(YOUTUBE_CHANNEL_ID_PATTERN);
  return match ? match[1] : null;
}

async function fetchChannelFeed(channelId) {
  const response = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`, {
    headers: {
      "User-Agent": "Mee6StyleBot/1.0",
    },
  });

  if (!response.ok) {
    throw new Error(`Feed request failed with ${response.status}`);
  }

  const xml = await response.text();
  const videoIds = [...xml.matchAll(/<yt:videoId>([^<]+)<\/yt:videoId>/g)].map((match) => match[1]);
  const channelNameMatch = xml.match(/<author>\s*<name>([^<]+)<\/name>/);

  return {
    channelName: channelNameMatch ? channelNameMatch[1] : null,
    videoIds: videoIds.slice(0, FEED_CANDIDATE_LIMIT),
  };
}

async function fetchVideoDetails(videoIds) {
  if (!config.youtubeApiKey || !videoIds.length) {
    return new Map();
  }

  const params = new URLSearchParams({
    part: "snippet,liveStreamingDetails",
    id: videoIds.join(","),
    key: config.youtubeApiKey,
  });

  const response = await fetch(`https://www.googleapis.com/youtube/v3/videos?${params.toString()}`);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`YouTube API request failed with ${response.status}: ${body}`);
  }

  const payload = await response.json();
  return new Map((payload.items || []).map((item) => [item.id, item]));
}

function isVideoLive(video) {
  const snippet = video?.snippet || {};
  const liveStreamingDetails = video?.liveStreamingDetails || {};

  return (
    snippet.liveBroadcastContent === "live" ||
    (Boolean(liveStreamingDetails.actualStartTime) && !liveStreamingDetails.actualEndTime)
  );
}

function buildLiveEmbed(video, youtubeChannelId) {
  const snippet = video.snippet || {};
  const thumbnails = snippet.thumbnails || {};
  const image =
    thumbnails.maxres?.url ||
    thumbnails.standard?.url ||
    thumbnails.high?.url ||
    thumbnails.medium?.url ||
    thumbnails.default?.url ||
    null;
  const liveUrl = `https://www.youtube.com/watch?v=${video.id}`;

  const embed = new EmbedBuilder()
    .setColor(0xff0000)
    .setTitle(snippet.title || "YouTube Live")
    .setURL(liveUrl)
    .setDescription(`${snippet.channelTitle || youtubeChannelId} is live now on YouTube.`)
    .addFields({ name: "Watch", value: liveUrl })
    .setTimestamp();

  if (image) {
    embed.setImage(image);
  }

  return embed;
}

async function announceLiveVideo(client, subscription, video) {
  const guild = client.guilds.cache.get(subscription.guild_id) || await client.guilds.fetch(subscription.guild_id).catch(() => null);
  if (!guild) {
    return;
  }

  const channel =
    guild.channels.cache.get(subscription.discord_channel_id) ||
    (await guild.channels.fetch(subscription.discord_channel_id).catch(() => null));

  if (!channel || !channel.isTextBased()) {
    return;
  }

  const mention = subscription.mention_role_id ? `<@&${subscription.mention_role_id}> ` : "";
  await channel.send({
    content: `${mention}${video.snippet?.channelTitle || "A YouTube channel"} just went live.`,
    embeds: [buildLiveEmbed(video, subscription.youtube_channel_id)],
  });

  updateYouTubeSubscription(subscription.id, {
    youtube_channel_name: video.snippet?.channelTitle || subscription.youtube_channel_name,
    last_live_video_id: video.id,
  });
}

async function runYouTubePoll(client) {
  if (!config.youtubeApiKey || pollInFlight) {
    return;
  }

  pollInFlight = true;

  try {
    const subscriptions = getAllYouTubeSubscriptions();
    if (!subscriptions.length) {
      return;
    }

    const feedResults = await Promise.all(
      subscriptions.map(async (subscription) => {
        try {
          const feed = await fetchChannelFeed(subscription.youtube_channel_id);
          return { subscription, feed };
        } catch (error) {
          console.error(`YouTube feed polling failed for ${subscription.youtube_channel_id}`, error);
          return null;
        }
      }),
    );

    const validResults = feedResults.filter(Boolean);
    const candidateVideoIds = [...new Set(
      validResults.flatMap((entry) => entry.feed.videoIds),
    )];

    if (!candidateVideoIds.length) {
      return;
    }

    const batches = [];
    for (let index = 0; index < candidateVideoIds.length; index += 50) {
      batches.push(candidateVideoIds.slice(index, index + 50));
    }

    const videoMap = new Map();
    for (const batch of batches) {
      const details = await fetchVideoDetails(batch);
      for (const [videoId, video] of details.entries()) {
        videoMap.set(videoId, video);
      }
    }

    for (const { subscription, feed } of validResults) {
      if (!subscription.youtube_channel_name && feed.channelName) {
        updateYouTubeSubscription(subscription.id, { youtube_channel_name: feed.channelName });
      }

      const liveVideo = feed.videoIds
        .map((videoId) => videoMap.get(videoId))
        .find((video) => isVideoLive(video));

      if (!liveVideo) {
        continue;
      }

      if (subscription.last_live_video_id === liveVideo.id) {
        continue;
      }

      await announceLiveVideo(client, subscription, liveVideo);
    }
  } catch (error) {
    console.error("YouTube live polling failed", error);
  } finally {
    pollInFlight = false;
  }
}

function startYouTubeMonitor(client) {
  if (!config.youtubeApiKey) {
    console.log("YouTube live alerts are disabled because YOUTUBE_API_KEY is missing.");
    return;
  }

  if (pollTimer) {
    clearInterval(pollTimer);
  }

  const intervalMs = Math.max(config.youtubePollMinutes, 1) * 60 * 1000;
  void runYouTubePoll(client);
  pollTimer = setInterval(() => {
    void runYouTubePoll(client);
  }, intervalMs);

  console.log(`YouTube live monitor started. Polling every ${config.youtubePollMinutes} minute(s).`);
}

module.exports = {
  normalizeYouTubeChannelId,
  listYouTubeSubscriptions,
  addYouTubeSubscription,
  removeYouTubeSubscription,
  startYouTubeMonitor,
};
