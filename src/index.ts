import express from "express";
import { Client } from 'pg';
import dotenv from 'dotenv';
import { ethers } from 'ethers';
import { Web3 } from 'web3';
import { Network, Alchemy } from "alchemy-sdk";
import Decimal from 'decimal.js';
import './logger';
import {
  addAlchemyContextToRequest,
  validateAlchemySignature,
  getPairTokenSymbols,
  getCurrentTimeISOString,
  fillUSDAmounts,
  Token,
  PairToken,
  getEthereumTokenUSD,
} from "./webhooksUtil";
import { connect } from "http2";
import { clear } from "console";

dotenv.config();

const alchemy_keys = process.env.ALCHEMY_API_KEY?.split(',');

const client = new Client({
  host: process.env.DB_host,
  database: process.env.DB_database,
  user: process.env.DB_user,
  password: process.env.DB_password,
  port: parseInt(process.env.DB_port ?? '5000'),
  ssl: {
    rejectUnauthorized: false, // Bypass certificate validation
  },
});

client.connect((err) => {
  if (err) {
    console.error('Connection error', err.stack);
  } else {
    console.log('Connected to the database');
  }
});


var settings = {
  apiKey: alchemy_keys[0],
  network: Network.ETH_MAINNET,
};

var alchemy = new Alchemy(settings);
var web3 = new Web3(`https://eth-mainnet.alchemyapi.io/v2/${alchemy_keys[0]}`);

async function switchAlchemyAPI() {
  const hours = (new Date()).getHours();
  if (settings.apiKey == alchemy_keys[parseInt(hours / (24 / alchemy_keys.length))]) {
    return false;
  }
  console.log(`Switching Alcehmy API Key to ${alchemy_keys[parseInt(hours / (24 / alchemy_keys.length))]} from ${settings.apiKey}!`);
  settings.apiKey = alchemy_keys[parseInt(hours / (24 / alchemy_keys.length))];
  alchemy = new Alchemy(settings);
  web3 = new Web3(`https://eth-mainnet.alchemyapi.io/v2/${alchemy_keys[parseInt(hours / (24 / alchemy_keys.length))]}`);
  return true;
}

const main = async () => {
  const app = express();

  //await switchAlchemyAPI();

  const port = process.env.PORT;
  const host = process.env.HOST;
  const signingKey = process.env.WEBHOOK_SIGNING_KEY;

  // Middleware needed to validate the alchemy signature
  app.use(
    express.json({
      limit: '100mb',
      verify: addAlchemyContextToRequest,
    })
  );
  app.use(validateAlchemySignature(signingKey));

  const UNISWAP_V3_SWAP_EVENT = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';
  const UNISWAP_V2_SWAP_EVENT = '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822';

  var logs: {}[] = [];
  var pairTokens = new Map<string, PairToken>();
  var tokens = new Map<string, Token>();

  let timer: NodeJS.Timeout | null = null;
  let timer_ws: NodeJS.Timeout | null = null;
  var PARSING: Boolean = false;
  var ARRIVING: Boolean = false;
  var block_timestamp: string;
  var ETH_LATEST_PRICE: Decimal;
  var lastBlockNumberWithETH: number = 0;

  async function parseSwapEvents() {
    const switched = await switchAlchemyAPI();
    if (switched) {
      await connectWebsocket();
    }
    if (logs.length == 0) return;
    PARSING = true;
    ARRIVING = false;
    const currentBlockNumber = logs[0].blockNumber;
    var _logs = logs.filter(log => log.blockNumber == currentBlockNumber);
    logs = logs.filter(log => log.blockNumber != currentBlockNumber);
    var start_time: Date = new Date();
    console.log(`started parsing block:${currentBlockNumber} at: ` + getCurrentTimeISOString());

    // Fetch ETH price
    if (currentBlockNumber - lastBlockNumberWithETH >= 1) {
      const eth_current_price = await getEthereumTokenUSD('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2');
      if (!eth_current_price.isZero()) {
        ETH_LATEST_PRICE = eth_current_price;
        lastBlockNumberWithETH = currentBlockNumber;
      }
    }
    console.log(`Current ETH Price ${ETH_LATEST_PRICE}`);
    if (ETH_LATEST_PRICE == undefined) {
      console.log(`Skipping block ${currentBlockNumber} due to undefined ETH price`);
      PARSING = false;
      return;
    }
    console.log(`fetched ETH USD of block ${currentBlockNumber} at: ` + getCurrentTimeISOString());
    // Example: Extract token swap details

    var currentTransactionhash: string = '';
    var currentFromAddress: string = '';

    for (var i = 0; i < _logs.length; ++i) {
      var amount0, amount1;
      if (_logs[i].topics[0] == UNISWAP_V3_SWAP_EVENT) {
        const iface = new ethers.Interface([
          'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)'
        ]);

        const parsedLog = iface.parseLog(_logs[i]);
        amount0 = parsedLog?.args.amount0;
        amount1 = parsedLog?.args.amount1;
      } else if (_logs[i].topics[0] == UNISWAP_V2_SWAP_EVENT) {
        const iface = new ethers.Interface([
          'event Swap(address indexed sender, uint amount0In, uint amount1In, uint amount0Out, uint amount1Out, address indexed to)'
        ]);

        const parsedLog = iface.parseLog(_logs[i]);
        const amount0In = parsedLog?.args.amount0In;
        const amount0Out = parsedLog?.args.amount0Out;
        const amount1In = parsedLog?.args.amount1In;
        const amount1Out = parsedLog?.args.amount1Out;
        if (amount0In == 0 || amount1Out == 0) {
          amount0 = -amount0Out;
          amount1 = amount1In;
        } else {
          amount0 = amount0In;
          amount1 = amount1Out;
        }
      }

      var pairToken: PairToken = {}
      if (pairTokens.has(_logs[i].address)) {
        pairToken = pairTokens.get(_logs[i].address);
      } else {
        const symbols = await getPairTokenSymbols(web3, _logs[i].address);
        // const response = await alchemy.core.getTokenMetadata(_logs[i].address);
        // pairToken.pool_version = response.name;
        if (symbols == null) continue;
        if (tokens.has(symbols.token0)) {
          var token = tokens.get(symbols.token0);
          pairToken.token0 = token;
        } else {
          var response;
          try {
            response = await alchemy.core.getTokenMetadata(symbols.token0);
          } catch {
            try {
              response = await alchemy.core.getTokenMetadata(symbols.token0);
            } catch (e) {
              console.error(e);
            }
          }
          var token: Token = {
            id: symbols?.token0,
            symbol: response?.symbol,
            decimal: response?.decimals,
          }
          pairToken.token0 = token;
          tokens.set(symbols.token0, token);
        }
        if (tokens.has(symbols.token1)) {
          var token = tokens.get(symbols.token1);
          pairToken.token1 = token;
        } else {
          var response;
          try {
            response = await alchemy.core.getTokenMetadata(symbols.token1);
          } catch {
            try {
              response = await alchemy.core.getTokenMetadata(symbols.token1);
            } catch (e) {
              console.error(e);
            }
          }
          var token: Token = {
            id: symbols?.token1,
            symbol: response?.symbol,
            decimal: response?.decimals,
          }
          pairToken.token1 = token;
          tokens.set(symbols.token1, token);
        }
        pairTokens.set(_logs[i].address, pairToken);
      }
      var amount0Decimal = new Decimal(ethers.formatUnits(amount0, pairToken?.token0?.decimal));
      var amount1Decimal = new Decimal(ethers.formatUnits(amount1, pairToken?.token1?.decimal));
      if (amount0Decimal.isPositive()) {
        _logs[i].token0 = {
          id: pairToken?.token0?.id,
          symbol: pairToken?.token0?.symbol,
          amount: amount0Decimal,
        };
        _logs[i].token1 = {
          id: pairToken?.token1?.id,
          symbol: pairToken?.token1?.symbol,
          amount: amount1Decimal.abs(),
        };
      } else {
        _logs[i].token0 = {
          id: pairToken?.token1?.id,
          symbol: pairToken?.token1?.symbol,
          amount: amount1Decimal,
        };
        _logs[i].token1 = {
          id: pairToken?.token0?.id,
          symbol: pairToken?.token0?.symbol,
          amount: amount0Decimal.abs(),
        }
      }
      if (_logs[i].transactionHash != currentTransactionhash) {
        currentTransactionhash = _logs[i].transactionHash;
        const transaction = await web3.eth.getTransaction(currentTransactionhash);
        currentFromAddress = transaction?.from;
      }
      _logs[i].fromAddress = currentFromAddress;
    }
    console.log(`started calculating USD of block ${currentBlockNumber} at: ` + getCurrentTimeISOString());
    await fillUSDAmounts(_logs, ETH_LATEST_PRICE, client);
    console.log(`ended parsing block ${currentBlockNumber} at: ` + getCurrentTimeISOString());
    console.log(`finished block ${currentBlockNumber} in ${(((new Date()).getTime() - start_time.getTime()) / 1000.0)} seconds`);
    PARSING = false;
  }

  var filter = {
    addresses: [

    ],
    topics: [
      [UNISWAP_V3_SWAP_EVENT, UNISWAP_V2_SWAP_EVENT]
    ]
  }

  async function connectWebsocket() {
    console.log("connecting websocket");
    alchemy.ws.removeAllListeners();
    if (timer_ws) {
      clearTimeout(timer_ws);
    }
    timer_ws = setTimeout(connectWebsocket, 15 * 1000);
    alchemy.ws.on(filter, async (log) => {
      if (!ARRIVING) {
        ARRIVING = true;
        console.log("================");
        block_timestamp = getCurrentTimeISOString();
        console.log(`arrived block:${log.blockNumber} at: ` + block_timestamp);
        console.log(`Alchemy API Key: ${alchemy.config.apiKey}`);
      }
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(parseSwapEvents, 300);
      logs.push(log);
      if (timer_ws) {
        clearTimeout(timer_ws);
      }
      timer_ws = setTimeout(connectWebsocket, 15 * 1000);
    }) 
  }

  await connectWebsocket();
  // Listen to Alchemy Notify webhook events
  app.listen(port, host, () => {
    console.log(`Example Alchemy Notify app listening at ${host}:${port}`);
  });
}

main();