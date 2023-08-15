import { randomUUID } from "crypto";
import { EventEmitter } from "events";
import WebSocket from "ws";

export interface TensorTransaction {
  tx: {
    source: string;
    txKey: string;
    txId: string;
    txType: string;
    grossAmount: number;
    grossAmountUnit: string;
    sellerId: string;
    buyerId: string;
    txAt: string;
    txMetadata: {
      auctionHouse: string;
      urlId: string;
      sellerRef: string;
      tokenAcc: string;
    };
    poolOnchainId: string;
  };
  mint: {
    onchainId: string;
    name: string;
    imageUri: string;
    metadataUri: string;
    metadataFetchedAt: string;
    sellRoyaltyFeeBPS: number;
    tokenStandard: string;
    tokenEdition: number;
    attributes: {
      trait_type: string;
      value: string;
    }[];
    lastSale: {
      price: number;
      priceUnit: string;
      txAt: string;
    };
    accState: string;
    rarityRankTT: number;
    rarityRankTTStat: number;
    rarityRankHR: number;
    rarityRankTeam: number;
    rarityRankStat: number;
    rarityRankTN: number;
  };
}

declare interface TensorService {
  on(
    event: "transaction",
    listener: (transaction: TensorTransaction, slug: string) => void
  ): this;
  on(
    event: string,
    listener: (transaction: TensorTransaction, slug: string) => void
  ): this;
  on(event: string, listener: Function): this;
  emit(event: any, transaction: TensorTransaction, slug: string): boolean;
}

class TensorService extends EventEmitter {
  private url: string;
  private ws: WebSocket | null;
  private apiKey: string;
  private is_connected: boolean;
  // store id of subscription to unsubscribe later
  private subscribedSlugs = new Map<string, string>();
  private timer: NodeJS.Timeout | null = null;

  // basic cache
  private cache = new Map<string, { expires: number; data: any }>();

  constructor(url: string, apiKey: string) {
    super();
    this.url = url;
    this.ws = null;
    this.is_connected = false;
    this.apiKey = apiKey;
  }

  public async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const wsUrl = this.url.replace(/^http/, "ws");
      this.ws = new WebSocket(wsUrl, ["graphql-transport-ws"], {
        followRedirects: true,
        headers: {
          "X-TENSOR-API-KEY": this.apiKey,
        },
      });

      this.ws.on("open", () => {
        this.is_connected = true;
        console.log("Connected to Tensor!");

        // send keepalive message every 30 seconds
        this.timer = setInterval(() => {
          this.ws?.send(JSON.stringify({ type: "ping" }));
        }, 30000);

        // send connection_init message
        this.send(
          JSON.stringify({
            type: "connection_init",
          })
        );

        this.ws?.on("message", (data) => {
          const json = JSON.parse(data.toString());
          if (json?.type === "pong") {
            return;
          }
          if (json?.type === "connection_ack") {
            resolve();
          }
          if (json?.payload?.data?.newTransactionTV2) {
            const transaction = json.payload.data
              .newTransactionTV2 as TensorTransaction;
            const id = json.id;

            // find slug by id which is value in map
            const slug = Array.from(this.subscribedSlugs.entries())
              .find(([key, value]) => value === id)
              ?.at(0);

            this.handleTransaction(transaction, slug);
          }
        });

        this.subscribedSlugs.forEach((id, slug) =>
          this.subscribeToSlug(slug, true)
        );
      });

      this.ws.on("close", (code: number, reason: string) => {
        this.is_connected = false;
        console.log("Disconnected from Tensor!", code, reason.toString());
        // Reconnect
        this.timer && clearInterval(this.timer);
        this.connect();
      });

      this.ws.on("error", (error) => {
        console.log("Error: ", error);
      });
    });
  }

  public send(data: string): void {
    if (this.is_connected) {
      this.ws?.send(data);
    } else {
      console.log("Not connected to Tensor!");
    }
  }

  public subscribeToSlug(slug: string, force = false): void {
    // if already subscribed, return
    if (this.subscribedSlugs.has(slug) && !force) {
      return;
    }

    const id = randomUUID();

    console.log(`Subscribing to slug ${slug} with id ${id}...`);

    const data = {
      id: id,
      type: "subscribe",
      payload: {
        variables: {
          slug: slug,
        },
        extensions: {},
        operationName: "NewTransaction",
        query: `subscription NewTransaction($slug: String!) {
          newTransactionTV2(slug: $slug) {
            ...ReducedLinkedTx
            __typename
          }
        }
        
        fragment ReducedLinkedTx on LinkedTransactionTV2 {
          tx {
            ...ReducedParsedTx
            __typename
          }
          mint {
            ...ReducedMint
            __typename
          }
          __typename
        }
        
        fragment ReducedParsedTx on ParsedTransaction {
          source
          txKey
          txId
          txType
          grossAmount
          grossAmountUnit
          sellerId
          buyerId
          txAt
          txMetadata {
            auctionHouse
            urlId
            sellerRef
            tokenAcc
            __typename
          }
          poolOnchainId
          __typename
        }
        
        fragment ReducedMint on TLinkedTxMintTV2 {
          onchainId
          name
          imageUri
          metadataUri
          metadataFetchedAt
          sellRoyaltyFeeBPS
          tokenStandard
          tokenEdition
          attributes
          lastSale {
            price
            priceUnit
            txAt
            __typename
          }
          accState
          ...MintRarityFields
          __typename
        }
        
        fragment MintRarityFields on TLinkedTxMintTV2 {
          rarityRankTT
          rarityRankTTStat
          rarityRankHR
          rarityRankTeam
          rarityRankStat
          rarityRankTN
          __typename
        }`,
      },
    };

    this.subscribedSlugs = this.subscribedSlugs.set(slug, id);
    this.send(JSON.stringify(data));
  }

  public async getCollectionStats(
    slug: string
  ): Promise<{
    buyNowPriceNetFees: number;
    numMints: number;
    [key: string]: any;
  }> {
    const cacheKey = `collectionStats:${slug}`;

    if (this.cache.has(cacheKey)) {
      const cache = this.cache.get(cacheKey);
      if (cache && cache.expires > Date.now()) {
        return cache.data;
      }
    }

    const payload = {
      operationName: "Instrument",
      variables: {
        slug: slug,
      },
      query: `query Instrument($slug: String!) {
        instrumentTV2(slug: $slug) {
          statsV2 {
            ...CollectionStatsV2
            __typename
          }
          __typename
        }
      }`,
    };

    const headers = {
      "X-TENSOR-API-KEY": this.apiKey,
    };

    const response = await fetch(this.url, {
      method: "POST",
      headers,
      body: JSON.stringify([payload]),
    });

    if (!response.ok) {
      throw new Error("Failed to fetch collection stats");
    }

    const json = await response.json();

    const stats = json[0].data.instrumentTV2.statsV2;

    this.cache.set(cacheKey, {
      expires: Date.now() + 5 * 60 * 1000,
      data: stats,
    });

    return stats;
  }

  private checkForListener(event: string): boolean {
    return this.listenerCount(event) > 0;
  }

  private handleTransaction(transaction: TensorTransaction, slug: string) {
    this.checkForListener("transaction") &&
      this.emit("transaction", transaction, slug);
    const source = transaction.tx.source;
    const txType = transaction.tx.txType;

    if (this.checkForListener(`${source}:${txType}`)) {
      this.emit(`${source}:${txType}`, transaction, slug);
    }

    if (this.checkForListener(`${source}:*`)) {
      this.emit(`${source}:*`, transaction, slug);
    }

    if (this.checkForListener(`*:${txType}`)) {
      this.emit(`*:${txType}`, transaction, slug);
    }

    if (this.checkForListener(`${txType}`)) {
      this.emit(`${txType}`, transaction, slug);
    }
  }
}

export default TensorService;
