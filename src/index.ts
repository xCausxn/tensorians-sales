import dotenv from "dotenv";
dotenv.config();

import { EmbedBuilder, WebhookClient } from "discord.js";

import TensorService, { TensorTransaction } from "./services/TensorService";
import { nonEmptyStrValidator, roundToDecimal, smartTruncate } from "./utils";
import { cleanEnv, makeValidator, str } from "envalid";
import { TwitterApi } from "twitter-api-v2";
import { getSimplePrice } from "./lib/coingecko";
import { fileTypeFromBuffer } from "file-type";

const LAMPORTS_PER_SOL = 1000000000;

async function createDiscordSaleEmbed(transaction: TensorTransaction) {
  const nftName = transaction.mint.name;
  const onchainId = transaction.mint.onchainId;
  const imageUri = transaction.mint.imageUri;
  const lastSale = transaction.mint.lastSale;
  const buyerId = transaction.tx.buyerId;
  const sellerId = transaction.tx.sellerId;

  const grossSaleAmount = transaction.tx.grossAmount;

  const buyerMessage = buyerId
    ? `[${smartTruncate(
        buyerId
      )}](https://www.tensor.trade/portfolio?wallet=${buyerId})`
    : "Unknown";

  const sellerMessage = sellerId
    ? `[${smartTruncate(
        sellerId
      )}](https://www.tensor.trade/portfolio?wallet=${sellerId})`
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

  const embed = new EmbedBuilder()
    .setTitle(`${nftName}`)
    .setURL(`https://tensor.trade/item/${onchainId}`)
    .setThumbnail(imageUri)
    .addFields([
      {
        name: "Price",
        value: `${roundToDecimal(
          grossSaleAmount / LAMPORTS_PER_SOL,
          2
        )} ◎ (${formattedUsdPrice})`,
      },
      {
        name: "Wallets",
        value: buyerSellerMessage,
      },
    ])
    .setFooter({
      iconURL: "https://i.ibb.co/ZMRt7cp/tt.png",
      text: "Tensor Trade",
    })
    .setTimestamp();

  if (lastSale && lastSale.price) {
    embed.addFields([
      {
        name: "Last sale",
        value: `${roundToDecimal(lastSale.price / LAMPORTS_PER_SOL, 2)} ◎`,
      },
    ]);
  }

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
  transaction: TensorTransaction
) {
  const nftName = transaction.mint.name;
  const onchainId = transaction.mint.onchainId;
  const txId = transaction.tx.txId;
  const imageUri = transaction.mint.imageUri;
  const grossSaleAmount = transaction.tx.grossAmount;
  const rarityRankTT = transaction.mint.rarityRankTT;

  const conversions = await getSimplePrice("solana", "usd");
  const usdConversion = conversions["solana"].usd;

  const solanaPrice = roundToDecimal(grossSaleAmount / LAMPORTS_PER_SOL, 2);
  const usdPrice = solanaPrice * usdConversion;

  const formattedUsdPrice = usdPrice.toLocaleString("en-US", {
    currency: "USD",
    style: "currency",
  });

  const marketplaceUrl = `https://tensor.trade/item/${onchainId}`;

  const usdMessage = usdPrice != null ? `💵 ${formattedUsdPrice} USD\n` : "";
  const rankMessage =
    rarityRankTT != null ? `🏅 ${rarityRankTT} on Tensor\n` : "";

  const message = `😲 ${nftName} SOLD for ${solanaPrice} ◎\n${usdMessage}${rankMessage}\n→ ${marketplaceUrl}\n\n📝 https://xray.helius.xyz/tx/${txId}`;

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
  const TENSOR_WEBSOCKET_URL = "wss://api.tensor.so/graphql";

  const env = cleanEnv(process.env, {
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

  const tensorService = new TensorService(
    TENSOR_WEBSOCKET_URL,
    env.TENSOR_API_KEY
  );

  await tensorService.connect();

  for (const slug of env.SLUGS.split(",")) {
    await tensorService.subscribeToSlug(slug);
  }

  tensorService.on("transaction", async (transaction) => {
    const allowedTxTypes = ["SALE_BUY_NOW"];

    if (!allowedTxTypes.includes(transaction.tx.txType)) {
      return;
    }

    logSaleToConsole(transaction);

    const embed = await createDiscordSaleEmbed(transaction);

    for (const webhook of discordWebhooks) {
      try {
        webhook.send({ embeds: [embed] });
      } catch (err) {
        console.error(err);
      }
    }

    try {
      await sendTwitterSaleTweet(twitterClient, transaction);
    } catch (err) {
      console.error(err);
    }
  });
}

main().catch(console.error);
