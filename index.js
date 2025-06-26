const axios = require("axios");
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const csv = require("csv-parser");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const MAX_LOOPS = 10;
const SOL_TO_USD = 100;

// ✅ OG whitelist set
const ogWhitelist = new Set();
fs.createReadStream("og_whitelist.csv")
  .pipe(csv())
  .on("data", (row) => {
    ogWhitelist.add(row.wallet.trim());
  })
  .on("end", () => {
    console.log("✅ OG whitelist loaded");
  });

// ✅ Optional: catch unhandled promise rejection
process.on("unhandledRejection", (reason, promise) => {
  console.error("💥 Unhandled Rejection:", reason);
});

app.get("/check-eligibility", async (req, res) => {
  const wallet = req.query.wallet;
  if (!wallet) return res.status(400).json({ error: "Missing wallet address" });

  try {
    let totalUSD = 0;
    let before = null;
    let loopCount = 0;

    while (loopCount < MAX_LOOPS) {
      const url = `https://api.helius.xyz/v0/addresses/${wallet}/transactions?api-key=${HELIUS_API_KEY}&limit=100${before ? `&before=${before}` : ""}`;
      console.log(`\n📡 Fetching transactions (loop ${loopCount + 1}): ${url}`);

      let txResponse;
      try {
        txResponse = await axios.get(url, { timeout: 10000 }); // 10s timeout
      } catch (fetchErr) {
        console.error("❌ Error fetching transactions:", fetchErr.message);
        if (fetchErr.response?.data) {
          console.error("Response data:", fetchErr.response.data);
        }
        break;
      }

      const txs = txResponse.data;
      console.log(`🔁 Got ${txs.length} transactions`);
      if (!txs || txs.length === 0) break;

      for (const tx of txs) {
        console.log(`📄 Processing tx: ${tx.signature}`);

        if (tx.nativeTransfers && tx.nativeTransfers.length > 0) {
          for (const transfer of tx.nativeTransfers) {
            console.log("🔍 Native Transfer:", transfer);
            if (
              transfer.toUserAccount === wallet ||
              transfer.fromUserAccount === wallet
            ) {
              const amountSOL = transfer.amount / 1_000_000_000;
              if (amountSOL > 0) {
                const usd = amountSOL * SOL_TO_USD;
                totalUSD += usd;
                console.log(`💸 +${amountSOL.toFixed(4)} SOL → $${usd.toFixed(2)}`);
              }
            }
          }
        } else {
          console.log("❌ No native transfers in this transaction");
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

    console.log("\n📊 Total USD Volume:", totalUSD.toFixed(2));
    console.log("🏆 Tier:", tier, "Reward:", reward);
    console.log("🧙 OG Holder:", isOG);
    console.log("🎁 Total with OG:", totalWithOG);

    res.json({
      wallet,
      volumeUSD: totalUSD.toFixed(2),
      tier: tier || "None",
      reward,
      eligible: tier !== null,
      isOGHolder: isOG,
      totalWithOG,
    });
  } catch (err) {
    console.error("❌ Error checking eligibility:", err.message);
    if (err.response) {
      console.error("Response data:", err.response.data);
    } else {
      console.error(err.stack);
    }
    res.status(500).json({ error: "Server error" });
  }
});

app.listen(5000, () => {
  console.log("✅ Backend running on http://localhost:5000");
});
