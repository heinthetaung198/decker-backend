// index.js
const axios = require("axios");
const express = require("express");
const cors = require("cors");
const csv = require("csv-parser");
const mongoose = require("mongoose");
const { Readable } = require("stream");
require("dotenv").config();

const { Connection } = require("@solana/web3.js");

const app = express();
app.use(cors());
app.use(express.json());

const RPC_URL = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
const connection = new Connection(RPC_URL, "confirmed");

const MAX_LOOPS = 10;
const SOL_TO_USD = 100;

// === MongoDB setup ===
if (!process.env.MONGO_URI) {
  console.error("❌ Missing MONGO_URI in environment variables!");
  process.exit(1);
}
mongoose.connect(process.env.MONGO_URI, { dbName: "wallet_cache" });
const txCacheSchema = new mongoose.Schema({
  wallet: { type: String, required: true, unique: true },
  transactions: { type: Array, default: [] },
  updatedAt: { type: Date, default: Date.now },
});
const TxCache = mongoose.model("TxCache", txCacheSchema);

// === CSV whitelists from GitHub ===
const degenMfersMap = new Map();
const ogWhitelist = new Set();
const deckerRoleHolders = new Set();

async function loadCsvFromGitHub(url, mapOrSet, isMap = false) {
  try {
    const resp = await axios.get(url);
    Readable.from(resp.data)
      .pipe(csv())
      .on("data", row => {
        if (row.wallet) {
          if (isMap) mapOrSet.set(row.wallet.trim().toLowerCase(), parseInt(row.amount, 10) || 0);
          else mapOrSet.add(row.wallet.trim().toLowerCase());
        }
      })
      .on("end", () => console.log(`✅ CSV loaded from ${url}`));
  } catch (err) {
    console.error(`❌ Failed to load CSV from ${url}:`, err.message);
  }
}

// Replace with your actual GitHub raw URLs
loadCsvFromGitHub("https://raw.githubusercontent.com/username/repo/main/degen_mfers.csv", degenMfersMap, true);
loadCsvFromGitHub("https://raw.githubusercontent.com/username/repo/main/og_whitelist.csv", ogWhitelist);
loadCsvFromGitHub("https://github.com/heinthetaung198/decker-backend/blob/main/decker_role_holder.csv", deckerRoleHolders);

// Optional: catch unhandled promise rejection
process.on("unhandledRejection", (reason) => console.error("💥 Unhandled Rejection:", reason));

const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
if (!HELIUS_API_KEY) {
  console.error("❌ Missing Helius API Key! Set HELIUS_API_KEY in environment variables");
  process.exit(1);
}

// === Helius fetch with retry and caching ===
async function fetchTransactions(wallet) {
  const walletLower = wallet.toLowerCase();
  const cached = await TxCache.findOne({ wallet: walletLower });
  if (cached && cached.transactions?.length > 0) {
    console.log(`⚡ Using cached transactions for ${walletLower}`);
    return cached.transactions;
  }

  let allTxs = [];
  let before = null;

  for (let loop = 0; loop < MAX_LOOPS; loop++) {
    const url = `https://api.helius.xyz/v0/addresses/${wallet}/transactions?api-key=${HELIUS_API_KEY}&limit=100${before ? `&before=${before}` : ""}`;
    let success = false;
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        console.log(`📡 Fetching transactions (loop ${loop + 1}, attempt ${attempt}) for wallet: ${wallet}`);
        const resp = await axios.get(url, { timeout: 15000 });
        if (Array.isArray(resp.data)) {
          const txs = resp.data;
          allTxs = allTxs.concat(txs);
          if (txs.length === 0) {
            success = true;
            break;
          }
          before = txs[txs.length - 1].signature;
          success = true;
          break;
        }
      } catch (err) {
        console.warn(`⚠️ Helius fetch failed (attempt ${attempt}):`, err.message);
        await new Promise(r => setTimeout(r, 500 * attempt));
      }
    }
    if (!success) {
      console.warn("❌ Failed to fetch transactions after retries, using what we have");
      break;
    }
  }

  // Save to cache
  try {
    await TxCache.findOneAndUpdate(
      { wallet: walletLower },
      { wallet: walletLower, transactions: allTxs, updatedAt: new Date() },
      { upsert: true }
    );
  } catch (err) {
    console.warn("⚠️ Failed to save to cache:", err.message);
  }

  console.log(`✅ Fetched transactions for ${walletLower}, count: ${allTxs.length}`);
  return allTxs;
}

// === Eligibility endpoint ===
app.get("/check-eligibility", async (req, res) => {
  const walletRaw = req.query.wallet;
  if (!walletRaw) return res.status(400).json({ error: "Missing wallet address" });

  const wallet = walletRaw.trim().toLowerCase();

  try {
    const txs = await fetchTransactions(wallet);

    let totalUSD = 0;
    let relevantTxCount = 0;

    for (const tx of txs || []) {
      if (tx.nativeTransfers) {
        for (const transfer of tx.nativeTransfers) {
          if (
            transfer.toUserAccount?.toLowerCase() === wallet ||
            transfer.fromUserAccount?.toLowerCase() === wallet
          ) {
            const solAmount = transfer.amount / 1_000_000_000;
            totalUSD += solAmount * SOL_TO_USD;
            relevantTxCount++;
          }
        }
      }
    }

    // Tier logic
    let tier = null;
    let reward = 0;
    if (totalUSD >= 3_000_000) { tier = 1; reward = 25000; }
    else if (totalUSD >= 500_000) { tier = 2; reward = 15000; }
    else if (totalUSD >= 250_000) { tier = 3; reward = 7000; }
    else if (totalUSD >= 30_000) { tier = 4; reward = 3000; }
    else if (totalUSD >= 1_000) { tier = 5; reward = 1500; }

    const isOG = ogWhitelist.has(wallet);
    const totalWithOG = isOG ? reward + 15000 : reward;
    const isDegen = degenMfersMap.has(wallet);
    const degenBonus = isDegen ? degenMfersMap.get(wallet) : 0;
    const isDecker = deckerRoleHolders.has(wallet);

    let finalTotal = totalWithOG + degenBonus;
    if (isDecker) finalTotal += 15000;

    res.json({
      wallet,
      volumeUSD: totalUSD.toFixed(2),
      tier: tier || "None",
      reward,
      eligible: tier !== null,
      relevantTxCount,
      isOGHolder: isOG,
      totalWithOG,
      isDegenMfer: isDegen,
      degenBonus,
      isDeckerRoleHolder: isDecker,
      finalTotal,
    });
  } catch (err) {
    console.error("❌ Error checking eligibility:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// === Start server ===
app.listen(5000, () => console.log("✅ Backend running on http://localhost:5000"));

