import dotenv from "dotenv";
dotenv.config();

import { Client, EmbedBuilder, WebhookClient } from "discord.js";

import TensorService, { TensorTransaction } from "./services/TensorService";
import { roundToDecimal, smartTruncate } from "./utils";

const LAMPORTS_PER_SOL = 1000000000;

function createDiscordSaleEmbed(transaction: TensorTransaction) {
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

  const embed = new EmbedBuilder()
    .setTitle(`${nftName}`)
    .setURL(`https://tensor.trade/item/${onchainId}`)
    .setThumbnail(imageUri)
    .addFields([
      {
        name: "Price",
        value: `${roundToDecimal(grossSaleAmount / LAMPORTS_PER_SOL, 2)} ◎`,
      },
      {
        name: "Wallets",
        value: buyerSellerMessage,
      },
    ])
    .setTimestamp();

  if (lastSale && lastSale.price) {
    embed.addFields([
      {
        name: "Last sale",
        value: `${roundToDecimal(
          lastSale.price / LAMPORTS_PER_SOL,
          2
        )} ◎ | Date ${new Date(lastSale.txAt).toISOString()}`,
      },
    ]);
  }

  return embed;
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
  const TENSOR_API_KEY = process.env.TENSOR_API_KEY;
  const TENSOR_WEBSOCKET_URL = "wss://api.tensor.so/graphql";
  const DISCORD_WEBHOOKS = process.env.DISCORD_WEBHOOKS;
  const SLUGS = process.env.SLUGS;

  if (!DISCORD_WEBHOOKS) {
    throw new Error("DISCORD_WEBHOOKS is not set");
  }

  if (!TENSOR_API_KEY) {
    throw new Error("TENSOR_API_KEY is not set");
  }

  if (!SLUGS) {
    throw new Error("SLUGS is not set");
  }

  const discordWebhooks = DISCORD_WEBHOOKS.split(",").map(
    (hookUrl) => new WebhookClient({ url: hookUrl })
  );

  const tensorService = new TensorService(TENSOR_WEBSOCKET_URL, TENSOR_API_KEY);

  await tensorService.connect();

  for (const slug of SLUGS.split(",")) {
    await tensorService.subscribeToSlug(slug);
  }

  tensorService.on("transaction", (transaction) => {
    const allowedTxTypes = ["SALE_BUY_NOW"];

    if (!allowedTxTypes.includes(transaction.tx.txType)) {
      return;
    }

    logSaleToConsole(transaction);

    const embed = createDiscordSaleEmbed(transaction);

    for (const webhook of discordWebhooks) {
      try {
        webhook.send({ embeds: [embed] });
      } catch (err) {
        console.error(err);
      }
    }
  });
}

main().catch(console.error);
