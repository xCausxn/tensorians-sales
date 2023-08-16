import dotenv from "dotenv";
dotenv.config();

import { EmbedBuilder, WebhookClient } from "discord.js";

import TensorService, { TensorTransaction } from "./services/TensorService";
import { nonEmptyStrValidator, roundToDecimal, smartTruncate } from "./utils";
import { cleanEnv, str } from "envalid";
import { TwitterApi } from "twitter-api-v2";
import { getSimplePrice } from "./lib/coingecko";
import { fileTypeFromBuffer } from "file-type";

const LAMPORTS_PER_SOL = 1_000_000_000;

const enum RarityTier {
  Mythic = "Mythic",
  Legendary = "Legendary",
  Epic = "Epic",
  Rare = "Rare",
  Uncommon = "Uncommon",
  Common = "Common",
}

const RarityTierPercentages = {
  [RarityTier.Mythic]: 0.01,
  [RarityTier.Legendary]: 0.05,
  [RarityTier.Epic]: 0.15,
  [RarityTier.Rare]: 0.35,
  [RarityTier.Uncommon]: 0.6,
  [RarityTier.Common]: 1,
};

function getRarityTier(rarityRank: number, maxSupply: number): RarityTier {
  const rarityPercentage = rarityRank / maxSupply;

  for (const [rarityTier, rarityPercentageThreshold] of Object.entries(RarityTierPercentages)) {
    if (rarityPercentage <= rarityPercentageThreshold) {
      return rarityTier as RarityTier;
    }
  }

  return RarityTier.Common;
}

function getRarityColorOrb(rarityTier: RarityTier): string {
  switch (rarityTier) {
    case RarityTier.Mythic:
      return "🔴";
    case RarityTier.Legendary:
      return "🟠";
    case RarityTier.Epic:
      return "🟣";
    case RarityTier.Rare:
      return "🔵";
    case RarityTier.Uncommon:
      return "🟢";
    default:
      return "⚪️";
  }
}

async function createDiscordSaleEmbed(
  transaction: TensorTransaction,
  extra: { stats: { buyNowPriceNetFees: string; numMints: number } }
) {
  const nftName = transaction.mint.name;
  const onchainId = transaction.mint.onchainId;
  const imageUri = transaction.mint.imageUri;
  const buyerId = transaction.tx.buyerId;
  const sellerId = transaction.tx.sellerId;
  const rank = transaction.mint.rarityRankTT;

  const grossSaleAmount = parseInt(transaction.tx.grossAmount, 10);

  const buyerMessage = buyerId
    ? `[${buyerId.slice(0, 4)}](https://www.tensor.trade/portfolio?wallet=${buyerId})`
    : "Unknown";

  const sellerMessage = sellerId
    ? `[${sellerId.slice(0, 4)}](https://www.tensor.trade/portfolio?wallet=${sellerId})`
    : "n/a";

  const buyerSellerMessage = `${sellerMessage} → ${buyerMessage}`;

  const conversions = await getSimplePrice("solana", "usd");
  const usdConversion = conversions["solana"].usd;

  const solanaPrice = roundToDecimal(grossSaleAmount / LAMPORTS_PER_SOL, 2);
  const usdPrice = solanaPrice * usdConversion;

  const formattedUsdPrice = usdPrice.toLocaleString("en-US", {
    currency: "USD",
    style: "currency",
  });

  const rarityClass = getRarityTier(rank, extra.stats.numMints || 10_000);
  const rarityOrb = getRarityColorOrb(rarityClass);

  const rarityMessage = `${rarityOrb} ${rarityClass} (${rank})`;

  const faction =
    transaction.mint.attributes.find((attr) => attr.trait_type === "Faction")?.value || "";

  const transactionLinks = [
    `[Tensor](https://www.tensor.trade/item/${onchainId})`,
    `[XRAY](https://xray.helius.xyz/tx/${transaction.tx.txId})`,
  ];

  const embed = new EmbedBuilder()
    .setTitle(`${nftName}`)
    .setDescription(rarityMessage)
    .setURL(`https://www.tensor.trade/item/${onchainId}`)
    .setThumbnail(imageUri)
    .addFields([
      {
        name: "Faction",
        value: faction,
      },
      {
        name: "Price",
        value: `◎${roundToDecimal(grossSaleAmount / LAMPORTS_PER_SOL, 2)} (${formattedUsdPrice})`,
      },
      {
        name: "Floor",
        value: `◎${roundToDecimal(
          parseInt(extra.stats.buyNowPriceNetFees, 10) / LAMPORTS_PER_SOL,
          2
        )}`,
      },
      {
        name: "Wallets",
        value: buyerSellerMessage,
      },
      {
        name: "Links",
        value: transactionLinks.join(" | "),
      },
    ])
    .setFooter({
      iconURL: "https://i.ibb.co/ZMRt7cp/tt.png",
      text: "Tensor Trade",
    })
    .setTimestamp();

  return embed;
}

async function getImageBuffer(imageUri: string): Promise<Buffer | null> {
  try {
    const response = await fetch(imageUri);

    if (!response.ok) {
      return null;
    }

    const buffer = await response.arrayBuffer();

    return Buffer.from(buffer);
  } catch (err) {
    return null;
  }
}

async function sendTwitterSaleTweet(
  twitterClient: TwitterApi,
  transaction: TensorTransaction,
  extra: { stats: { buyNowPriceNetFees: string; numMints: number } }
) {
  const nftName = transaction.mint.name;
  const onchainId = transaction.mint.onchainId;
  const txId = transaction.tx.txId;
  const imageUri = transaction.mint.imageUri;
  const grossSaleAmount = parseInt(transaction.tx.grossAmount, 10);
  const rank = transaction.mint.rarityRankTT;

  const conversions = await getSimplePrice("solana", "usd");
  const usdConversion = conversions["solana"].usd;

  const solanaPrice = roundToDecimal(grossSaleAmount / LAMPORTS_PER_SOL, 2);
  const usdPrice = solanaPrice * usdConversion;

  const formattedUsdPrice = usdPrice.toLocaleString("en-US", {
    currency: "USD",
    style: "currency",
  });

  const marketplaceUrl = `https://www.tensor.trade/item/${onchainId}`;

  const usdMessage = usdPrice != null ? `💵 ${formattedUsdPrice} USD\n` : "";

  const rarityClass = getRarityTier(rank, extra.stats.numMints || 10_000);
  const rarityOrb = getRarityColorOrb(rarityClass);

  const rarityMessage = `${rarityOrb} ${rarityClass} (${rank})\n`;
  const floorMessage = `📈 ◎${roundToDecimal(
    parseInt(extra.stats.buyNowPriceNetFees, 10) / LAMPORTS_PER_SOL,
    2
  )} floor\n`;

  const faction =
    transaction.mint.attributes.find((attr) => attr.trait_type === "Faction")?.value || "";

  const factionMessage = faction ? `👥 ${faction}\n` : "";

  const message = `😲 ${nftName} SOLD for ◎${solanaPrice}\n${usdMessage}${floorMessage}${rarityMessage}${factionMessage}\n→ ${marketplaceUrl}\n\n📝 https://xray.helius.xyz/tx/${txId}`;

  const imageBuffer = await getImageBuffer(imageUri);
  let mediaIds: string[] = [];

  try {
    if (imageBuffer) {
      const fileType = await fileTypeFromBuffer(imageBuffer);
      const mediaId = await twitterClient.v1.uploadMedia(imageBuffer, {
        mimeType: fileType?.mime,
      });
      mediaIds = [mediaId];
    }
  } catch (err) {
    console.error(err);
  }

  return twitterClient.v2.tweet(message, {
    media: {
      media_ids: mediaIds,
    },
  });
}

function logSaleToConsole(transaction: TensorTransaction) {
  const nftName = transaction.mint.name;
  const onchainId = transaction.mint.onchainId;
  const imageUri = transaction.mint.imageUri;
  const buyerId = transaction.tx.buyerId;
  const sellerId = transaction.tx.sellerId;

  const grossSaleAmount = transaction.tx.grossAmount;

  console.log(`New sale for ${nftName} (${onchainId})
        Image: ${imageUri}
        Buyer: ${buyerId}
        Seller: ${sellerId}
        Gross sale amount: ${grossSaleAmount}
        `);
}

async function main() {
  const env = cleanEnv(process.env, {
    TENSOR_API_URL: str({
      default: "https://api.tensor.so/graphql",
    }),
    TENSOR_API_KEY: nonEmptyStrValidator(),
    DISCORD_WEBHOOKS: nonEmptyStrValidator(),
    SLUGS: nonEmptyStrValidator(),
    TWITTER_API_KEY: nonEmptyStrValidator(),
    TWITTER_API_SECRET: nonEmptyStrValidator(),
    TWITTER_ACCESS_TOKEN: nonEmptyStrValidator(),
    TWITTER_ACCESS_TOKEN_SECRET: nonEmptyStrValidator(),
  });

  const discordWebhooks = env.DISCORD_WEBHOOKS.split(",").map(
    (hookUrl) => new WebhookClient({ url: hookUrl })
  );

  const twitterClient = new TwitterApi({
    appKey: env.TWITTER_API_KEY,
    appSecret: env.TWITTER_API_SECRET,
    accessToken: env.TWITTER_ACCESS_TOKEN,
    accessSecret: env.TWITTER_ACCESS_TOKEN_SECRET,
  });

  const tensorService = new TensorService(env.TENSOR_API_URL, env.TENSOR_API_KEY);

  await tensorService.connect();

  for (const slug of env.SLUGS.split(",")) {
    await tensorService.subscribeToSlug(slug);
  }

  tensorService.on("transaction", async (transaction, slug) => {
    const allowedTxTypes = ["SALE_BUY_NOW", "SALE_ACCEPT_BID"];

    if (!allowedTxTypes.includes(transaction.tx.txType)) {
      return;
    }

    const stats = await tensorService.getCollectionStats(slug);

    logSaleToConsole(transaction);

    const embed = await createDiscordSaleEmbed(transaction, { stats });

    for (const webhook of discordWebhooks) {
      try {
        webhook.send({ embeds: [embed] });
      } catch (err) {
        console.error(err);
      }
    }

    try {
      await sendTwitterSaleTweet(twitterClient, transaction, { stats });
    } catch (err) {
      console.error(err);
    }
  });
}

main().catch(console.error);
