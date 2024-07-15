import { NextFunction } from "express";
import { Request, Response } from "express-serve-static-core";
import axios from 'axios';
import * as crypto from "crypto";
import { IncomingMessage, ServerResponse } from "http";
import { Web3 } from 'web3'
import Decimal from 'decimal.js'
import { Client } from 'pg';
import * as fs from 'fs';
import { ReadableStreamDefaultController } from "stream/web";

export interface AlchemyRequest extends Request {
  alchemy: {
    rawBody: string;
    signature: string;
  };
}

export function isValidSignatureForAlchemyRequest(
  request: AlchemyRequest,
  signingKey: string
): boolean {
  return isValidSignatureForStringBody(
    request.alchemy.rawBody,
    request.alchemy.signature,
    signingKey
  );
}

export function isValidSignatureForStringBody(
  body: string,
  signature: string,
  signingKey: string
): boolean {
  const hmac = crypto.createHmac("sha256", signingKey); // Create a HMAC SHA256 hash using the signing key
  hmac.update(body, "utf8"); // Update the token hash with the request body using utf8
  const digest = hmac.digest("hex");
  return signature === digest;
}

export function addAlchemyContextToRequest(
  req: IncomingMessage,
  _res: ServerResponse,
  buf: Buffer,
  encoding: BufferEncoding
): void {
  const signature = req.headers["x-alchemy-signature"];
  // Signature must be validated against the raw string
  var body = buf.toString(encoding || "utf8");
  (req as AlchemyRequest).alchemy = {
    rawBody: body,
    signature: signature as string,
  };
}

export function validateAlchemySignature(signingKey: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!isValidSignatureForAlchemyRequest(req as AlchemyRequest, signingKey)) {
      const errMessage = "Signature validation failed, unauthorized!";
      res.status(403).send(errMessage);
      throw new Error(errMessage);
    } else {
      next();
    }
  };
}

export const getEthereumTokenUSD = async (token_address: string) => {
  try {
    const response = await axios.get(`https://api.coingecko.com/api/v3/coins/ethereum/contract/${token_address}`);

    return new Decimal(response.data.market_data.current_price.usd);
  } catch (e) {
    console.error(e);
    return new Decimal(0);
  }
}

function addEdge(graph: Map<string, { id: string, ratio: Decimal }[]>, A: string, B: string, ratio: Decimal) {
  if (graph.has(A)) {
    graph.get(A)!.push({ id: B, ratio: ratio });
  } else {
    graph.set(A, [{ id: B, ratio: ratio }]);
  }
}

const safeNumber = (value: Decimal) => {
  if (value.isNaN() || !value.isFinite()) {
    return new Decimal(0); // or new Decimal(null), depending on your database schema
  }
  const maxPrecision = 50;
  const maxScale = 18;
  const maxValue = new Decimal('9.999999999999999999999999999999999999999999999999E+31'); // Adjust based on precision and scale
  const minValue = maxValue.negated();

  if (value.greaterThan(maxValue)) {
    return maxValue;
  }
  if (value.lessThan(minValue)) {
    return minValue;
  }
  return value;
};

async function db_save_batch(events: any[], client: Client, block_creation_time: string, ETH2USD: Decimal, prod_client: Client) {
  const BATCH_SIZE = 100;

  const batches = [];
  for (let i = 0; i < events.length; i += BATCH_SIZE) {
    const batch = events.slice(i, i + BATCH_SIZE);
    batches.push(batch);
  }

  for (const batch of batches) {
    const values = [];
    const placeholders = batch.map((_, i) => {
      const offset = i * 16;
      return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}, $${offset + 10}, $${offset + 11}, $${offset + 12}, $${offset + 13}, $${offset + 14}, $${offset + 15}, $${offset + 16})`;
    }).join(',');
    // console.log("placeholders",placeholders)
    // console.log("block_creation_time",block_creation_time)
    batch.forEach(event => {
      const {
        blockNumber,
        blockHash,
        transactionHash,
        fromAddress,
        token0: { id: token0_id, symbol: token0_symbol, amount: token0_amount, value_in_usd: token0_value_in_usd, total_exchanged_usd: token0_total_exchanged_usd },
        token1: { id: token1_id, symbol: token1_symbol, amount: token1_amount, value_in_usd: token1_value_in_usd, total_exchanged_usd: token1_total_exchanged_usd },
      } = event;

      values.push(
        blockNumber,
        blockHash,
        transactionHash,
        fromAddress,
        token0_id.toLowerCase(),
        token0_symbol,
        safeNumber(token0_amount ?? new Decimal(0)).toString(),
        safeNumber(token0_value_in_usd ?? new Decimal(0)).toString(),
        safeNumber(token0_total_exchanged_usd ?? new Decimal(0)).toString(),
        token1_id.toLowerCase(),
        token1_symbol,
        safeNumber(token1_amount ?? new Decimal(0)).toString(),
        safeNumber(token1_value_in_usd ?? new Decimal(0)).toString(),
        safeNumber(token1_total_exchanged_usd ?? new Decimal(0)).toString(),
        safeNumber(ETH2USD ?? new Decimal(0)).toString(),
        block_creation_time
      );
    });
    // console.log("values",values)
    const query = `
        INSERT INTO swap_events (
          block_number,
          block_hash,
          transaction_hash,
          wallet_address,
          token0_id,
          token0_symbol,
          token0_amount,
          token0_value_in_usd,
          token0_total_exchanged_usd,
          token1_id,
          token1_symbol,
          token1_amount,
          token1_value_in_usd,
          token1_total_exchanged_usd,
          eth_price_usd,
          created_at
        ) VALUES ${placeholders}
      `;
    // console.log("query",query)
    // console.log("values",values)
    try {
      await client.query(query, values);
    } catch (err) {
      console.error('Error saving batch of events', err);
      fs.appendFile("./logs/error.txt", err + '\n', (err) => {
        if (err) {
          console.error('Error writing file', err);
        } else {
          console.log('File has been written successfully');
        }
      })
    }
    continue;

    try {
      await prod_client.query(query, values);
    } catch (err) {
      console.error('Error saving batch of events', err);
      fs.appendFile("./logs/prod_error.txt", err + '\n', (err) => {
        if (err) {
          console.error('Error writing file', err);
        } else {
          console.log('File has been written successfully');
        }
      })
    }
  }
}

export async function fillUSDAmounts(swapEvents: {}[], ETH2USD: Decimal, client: Client, web3: Web3, prod_client: Client) {
  if (swapEvents.length == 0) return;
  var graph = new Map<string, { id: string, ratio: Decimal }[]>()

  for (var se of swapEvents) {
    if (se.token0.id && se.token1.id && se.token0.amount && se.token1.amount && !se.token0.amount.isNaN() && !se.token1.amount.isNaN() && !se.token0.amount.isZero() && !se.token1.amount.isZero()) {
      addEdge(graph, se.token0.id.toLowerCase(), se.token1.id.toLowerCase(), se.token0.amount.dividedBy(se.token1.amount));
      addEdge(graph, se.token1.id.toLowerCase(), se.token0.id.toLowerCase(), se.token1.amount.dividedBy(se.token0.amount));
    }
  }

  //const stack: string[] = ["GHO", "GRAI", "SEUR", "aUSDC", "BUSD", "GUSD", "CRVUSD", "EUSD", "aUSDT", "USDP", "TUSD", "MIM", "EURA", "TAI", "XAI", "USDD", "BOB", "PUSd", "EUSD", "DAI", "VEUR", "DOLA", "FRAX", "anyCRU", "anyETH", "MXNt", "LUSD", "SUSD", "USDC", "USDT", "WETH"];

  const stack: string[] = ["0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48".toLowerCase(), "0xdac17f958d2ee523a2206206994597c13d831ec7".toLowerCase(), "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2".toLowerCase()];

  var id2USD = new Map<string, Decimal>();

  id2USD.set("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2".toLowerCase(), ETH2USD);
  for (var i = 0; i < stack.length - 1; ++i) {
    id2USD.set(stack[i], new Decimal(1.0));
  }

  while (stack.length > 0) {
    const id = stack.pop();

    if (!graph.has(id)) continue;
    for (var right of graph.get(id)) {
      if (!id2USD.has(right.id)) {
        id2USD.set(right.id, id2USD.get(id).times(right.ratio));
        stack.push(right.id);
      }
    }
  }
  for (var i = 0; i < swapEvents.length; ++i) {
    if (id2USD.has(swapEvents[i].token0.id.toLowerCase())) {
      swapEvents[i].token0.value_in_usd = id2USD.get(swapEvents[i].token0.id.toLowerCase());
      swapEvents[i].token0.total_exchanged_usd = swapEvents[i].token0.value_in_usd.times(swapEvents[i].token0.amount);
      if (id2USD.has(swapEvents[i].token1.id.toLowerCase())) {
        swapEvents[i].token1.value_in_usd = id2USD.get(swapEvents[i].token1.id.toLowerCase());
        swapEvents[i].token1.total_exchanged_usd = swapEvents[i].token1.value_in_usd.times(swapEvents[i].token1.amount);
      }
    } else {
      stack.push(swapEvents[i].token0.id.toLowerCase());
      const usdPrice = await getEthereumTokenUSD(swapEvents[i].token0.id);
      if (usdPrice == new Decimal(0)) {
        stack.pop();
        continue;
      }
      id2USD.set(swapEvents[i].token0.id.toLowerCase(), usdPrice);
      while (stack.length > 0) {
        const id = stack.pop();

        if (!graph.has(id)) continue;
        for (var right of graph.get(id)) {
          if (!id2USD.has(right.id)) {
            id2USD.set(right.id, id2USD.get(id).times(right.ratio));
            stack.push(right.id);
          }
        }
      }
    }
    if (id2USD.has(swapEvents[i].token0.id.toLowerCase())) {
      swapEvents[i].token0.value_in_usd = id2USD.get(swapEvents[i].token0.id.toLowerCase());
      swapEvents[i].token0.total_exchanged_usd = swapEvents[i].token0.value_in_usd.times(swapEvents[i].token0.amount);
      if (id2USD.has(swapEvents[i].token1.id.toLowerCase())) {
        swapEvents[i].token1.value_in_usd = id2USD.get(swapEvents[i].token1.id.toLowerCase());
        swapEvents[i].token1.total_exchanged_usd = swapEvents[i].token1.value_in_usd.times(swapEvents[i].token1.amount);
      }
    }
  }


  const block_timestamp = (new Date(parseInt((await web3.eth.getBlock(swapEvents[0].blockNumber)).timestamp) * 1000)).toISOString();

  await db_save_batch(swapEvents, client, block_timestamp, ETH2USD, prod_client);


}

// Function to get the token addresses
export async function getPairTokenSymbols(web3: Web3, pairAddress: string) {
  const pairABI = [
    {
      "constant": true,
      "inputs": [],
      "name": "token0",
      "outputs": [
        {
          "internalType": "address",
          "name": "",
          "type": "address"
        }
      ],
      "payable": false,
      "stateMutability": "view",
      "type": "function"
    },
    {
      "constant": true,
      "inputs": [],
      "name": "token1",
      "outputs": [
        {
          "internalType": "address",
          "name": "",
          "type": "address"
        }
      ],
      "payable": false,
      "stateMutability": "view",
      "type": "function"
    }
  ];
  // Create a new contract instance with the pair address and ABI
  try {
    const pairContract = new web3.eth.Contract(pairABI, pairAddress);
    const token0 = await pairContract.methods.token0().call();
    const token1 = await pairContract.methods.token1().call();
    return { token0, token1 };
  } catch (error) {
    console.error("Error fetching pair tokens:", error);
    return null;
  }
}

export interface AlchemyWebhookEvent {
  webhookId: string;
  id: string;
  createdAt: Date;
  type: AlchemyWebhookType;
  event: Record<any, any>;
}

export function getCurrentTimeISOString(): string {
  const now = new Date();
  return now.toISOString();
}

export interface Token {
  id: string;
  symbol: string;
  decimal: number;
}

export interface PairToken {
  //pool_version: string;
  token0: Token;
  token1: Token;
}

export type AlchemyWebhookType =
  | "MINED_TRANSACTION"
  | "DROPPED_TRANSACTION"
  | "ADDRESS_ACTIVITY";

