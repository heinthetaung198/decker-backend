// index.js
const axios = require("axios");
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const csv = require("csv-parser");
require("dotenv").config();

const { Connection, PublicKey } = require("@solana/web3.js");

const app = express();
app.use(cors());
app.use(express.json());

const RPC_URL = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
const connection = new Connection(RPC_URL, "confirmed");

const MAX_LOOPS = 10;
const SOL_TO_USD = 100;

// ✅ Degen Mfers whitelist with token amounts
const degenMfersMap = new Map();
fs.createReadStream("degen_mfers.csv")
  .pipe(csv())
  .on("data", (row) => {
    const wallet = row.wallet.trim().toLowerCase();
    const amount = parseInt(row.amount, 10) || 0;
    degenMfersMap.set(wallet, amount);
  })
  .on("end", () => {
    console.log("✅ Degen Mfers whitelist loaded");
  });

// ✅ OG whitelist set
const ogWhitelist = new Set();
fs.createReadStream("og_whitelist.csv")
  .pipe(csv())
  .on("data", (row) => {
    ogWhitelist.add(row.wallet.trim().toLowerCase());
  })
  .on("end", () => {
    console.log("✅ OG whitelist loaded");
  });

// ✅ Decker Role Holder whitelist set
const deckerRoleHolders = new Set();
fs.createReadStream("decker_role_holder.csv")
  .pipe(csv())
  .on("data", (row) => {
    if (row.wallet) {
      deckerRoleHolders.add(row.wallet.trim().toLowerCase());
    }
  })
  .on("end", () => {
    console.log("✅ Decker Role Holder whitelist loaded");
  });

// Optional: catch unhandled promise rejection
process.on("unhandledRejection", (reason, promise) => {
  console.error("💥 Unhandled Rejection:", reason);
});

// Function to get transactions via Helius API (you can replace or extend with RPC calls if needed)
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;

// Helper: Fetch transactions via Helius (for now, keep using it, but you can adapt to RPC getSignaturesForAddress + getTransaction if you want full RPC)
async function fetchTransactions(wallet, before) {
  const url = `https://api.helius.xyz/v0/addresses/${wallet}/transactions?api-key=${HELIUS_API_KEY}&limit=100${before ? `&before=${before}` : ""}`;
  try {
    const resp = await axios.get(url, { timeout: 15000 });
    return resp.data;
  } catch (e) {
    console.error("❌ Error fetching transactions from Helius:", e.message);
    return [];
  }
}

// Eligibility check endpoint
app.get("/check-eligibility", async (req, res) => {
  const walletRaw = req.query.wallet;
  if (!walletRaw) return res.status(400).json({ error: "Missing wallet address" });

  const wallet = walletRaw.trim().toLowerCase();
  const walletForAPI = walletRaw.trim();

  try {
    let totalUSD = 0;
    let before = null;
    let loopCount = 0;

    // Loop to fetch max MAX_LOOPS pages of 100 tx each
    while (loopCount < MAX_LOOPS) {
      console.log(`\n📡 Fetching transactions (loop ${loopCount + 1}) for wallet: ${walletForAPI}`);
      const txs = await fetchTransactions(walletForAPI, before);

      if (!txs || txs.length === 0) {
        console.log("🔚 No more transactions found, stopping loop.");
        break;
      }

      console.log(`🔁 Got ${txs.length} transactions`);

      for (const tx of txs) {
        if (tx.nativeTransfers && tx.nativeTransfers.length > 0) {
          for (const transfer of tx.nativeTransfers) {
            if (
              transfer.toUserAccount?.toLowerCase() === wallet ||
              transfer.fromUserAccount?.toLowerCase() === wallet
            ) {
              const amountSOL = transfer.amount / 1_000_000_000;
              if (amountSOL > 0) {
                const usd = amountSOL * SOL_TO_USD;
                totalUSD += usd;
                console.log(`💸 +${amountSOL.toFixed(4)} SOL → $${usd.toFixed(2)}`);
              }
            }
          }
        }
      }

      before = txs[txs.length - 1].signature;
      loopCount++;
    }

    // Tier logic
    let tier = null;
    let reward = 0;

    if (totalUSD >= 3_000_000) {
      tier = 1;
      reward = 25000;
    } else if (totalUSD >= 500_000) {
      tier = 2;
      reward = 15000;
    } else if (totalUSD >= 250_000) {
      tier = 3;
      reward = 7000;
    } else if (totalUSD >= 30_000) {
      tier = 4;
      reward = 3000;
    } else if (totalUSD >= 1_000) {
      tier = 5;
      reward = 1500;
    }

    const isOG = ogWhitelist.has(wallet);
    const totalWithOG = isOG ? reward + 15000 : reward;

    const isDegenMfer = degenMfersMap.has(wallet);
    const degenBonus = isDegenMfer ? degenMfersMap.get(wallet) : 0;

    const isDeckerRoleHolder = deckerRoleHolders.has(wallet);

    let finalTotal = totalWithOG + degenBonus;
    if (isDeckerRoleHolder) {
      finalTotal += 15000;
    }

    console.log("\n📊 Total USD Volume:", totalUSD.toFixed(2));
    console.log("🏆 Tier:", tier, "Reward:", reward);
    console.log("🧙 OG Holder:", isOG);
    console.log("🚀 Degen Mfer:", isDegenMfer);
    console.log("🎖️ Decker Role Holder:", isDeckerRoleHolder);
    console.log("🎁 Final Total:", finalTotal);

    res.json({
      wallet,
      volumeUSD: totalUSD.toFixed(2),
      tier: tier || "None",
      reward,
      eligible: tier !== null,
      isOGHolder: isOG,
      totalWithOG,
      isDegenMfer,
      degenBonus,
      isDeckerRoleHolder,
      finalTotal,
    });
  } catch (err) {
    console.error("❌ Error checking eligibility:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// Jupiter Swap Build Endpoint
app.post("/api/swap/build", async (req, res) => {
  const { inputMint, outputMint, amount, slippage, userPublicKey } = req.body;

  if (!inputMint || !outputMint || !amount || !userPublicKey || !slippage) {
    return res.status(400).json({ error: "Missing required parameters" });
  }

  try {
    const response = await axios.post("https://quote-api.jup.ag/v6/swap", {
      inputMint,
      outputMint,
      amount,
      slippageBps: slippage * 100, // e.g. 1% = 100bps
      userPublicKey,
      wrapUnwrapSOL: true,
      feeBps: 50, // 0.5% fee
      feeAccount: process.env.FEE_ACCOUNT,
    });

    res.json(response.data);
  } catch (error) {
    console.error("🔴 Jupiter Swap API error:", error.message);
    if (error.response?.data) {
      console.error("Response:", error.response.data);
    }
    res.status(500).json({ error: "Swap build failed" });
  }
});

// Start server
app.listen(5000, () => {
  console.log("✅ Backend running on http://localhost:5000");
});
