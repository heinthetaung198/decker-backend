// index.js (Backend)
const axios = require("axios");
const express = require("express");
const cors = require("cors");
const https = require("https");
const csv = require("csv-parser");
const mongoose = require("mongoose");
const TxCache = require("./models/TxCache");
const Claim = require("./models/Claim");
const Referral = require("./models/Referral");
require("dotenv").config();

const { Connection, PublicKey } = require("@solana/web3.js");

const app = express();
app.use(cors());
app.use(express.json());

const RPC_URL = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
const connection = new Connection(RPC_URL, "confirmed");

const MAX_LOOPS = 10;
const SOL_TO_USD = 100;

// === MongoDB setup ===
mongoose.connect(process.env.MONGO_URI, { dbName: "wallet_cache" });

// === CSV loader from GitHub ===
function loadCSVFromGitHub(url, type = "map", valueField = "amount") {
  return new Promise((resolve, reject) => {
    const result = type === "map" ? new Map() : new Set();
    https.get(url, (res) => {
      res.pipe(csv())
        .on("data", (row) => {
          if (row.wallet) {
            const wallet = row.wallet.trim().toLowerCase();
            if (type === "map") {
              result.set(wallet, parseInt(row[valueField], 10) || 0);
            } else {
              result.add(wallet);
            }
          }
        })
        .on("end", () => resolve(result))
        .on("error", reject);
    }).on("error", reject);
  });
}

// === GitHub CSV URLs ===
const DEGEN_CSV = "https://raw.githubusercontent.com/heinthetaung198/decker-backend/main/degen_mfers.csv";
const OG_CSV = "https://raw.githubusercontent.com/heinthetaung198/decker-backend/main/og_whitelist.csv";
const DECKER_CSV = "https://raw.githubusercontent.com/heinthetaung198/decker-backend/main/decker_role_holder.csv";

let degenMfersMap = new Map();
let ogWhitelist = new Set();
let deckerRoleHolders = new Set();

async function loadAllWhitelists() {
  console.log("📡 Loading whitelists from GitHub...");
  
  degenMfersMap = await loadCSVFromGitHub(DEGEN_CSV, "map", "amount");
  console.log("✅ Degen Mfers whitelist loaded");

  ogWhitelist = await loadCSVFromGitHub(OG_CSV, "set");
  console.log("✅ OG whitelist loaded");

  deckerRoleHolders = await loadCSVFromGitHub(DECKER_CSV, "set");
  console.log("✅ Decker Role Holder whitelist loaded");
}

// Optional: catch unhandled promise rejection
process.on("unhandledRejection", (reason) => console.error("💥 Unhandled Rejection:", reason));

const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
if (!HELIUS_API_KEY) {
  console.error("❌ Missing Helius API Key! Set HELIUS_API_KEY in .env");
  process.exit(1);
}

// === Helius fetch with retry and caching ===
async function fetchTransactions(wallet) {
  const walletLower = wallet.toLowerCase();

  const cached = await TxCache.findOne({ wallet: walletLower });
  if (cached) {
    console.log(`⚡ Using cached transactions for ${walletLower}`);
    console.log(`   📦 Cached tx count: ${cached.transactions.length}`);
    return cached.transactions;
  }

  let allTxs = [];
  let before = null;

  for (let loop = 0; loop < MAX_LOOPS; loop++) {
    console.log(`📡 Fetching transactions (loop ${loop+1}) for wallet: ${wallet}`);

    const url = `https://api.helius.xyz/v0/addresses/${wallet}/transactions?api-key=${HELIUS_API_KEY}&limit=100${before ? `&before=${before}` : ""}`;
    let success = false;

    for (let attempt = 1; attempt <= 5; attempt++) {
      console.log(`   ⏳ Attempt ${attempt}...`);
      try {
        const resp = await axios.get(url, { timeout: 15000 });
        if (Array.isArray(resp.data)) {
          const txs = resp.data;
          allTxs = allTxs.concat(txs);

          console.log(`   ✅ Received ${txs.length} transactions`);

          if (txs.length === 0) {
            console.log("🔚 No more transactions, stopping loop");
            success = true;
            break;
          }

          before = txs[txs.length - 1].signature;
          success = true;
          break;
        }
      } catch (err) {
        console.log(`   ⚠️ Error attempt ${attempt}: ${err.message}`);
        await new Promise((r) => setTimeout(r, 500 * attempt));
      }
    }

    if (!success) {
      console.log("❌ Failed to fetch transactions in this loop, breaking...");
      break;
    }
  }

  console.log(`✅ Fetched transactions for ${walletLower}, total count: ${allTxs.length}`);

  try {
    await TxCache.findOneAndUpdate(
      { wallet: walletLower },
      { wallet: walletLower, transactions: allTxs, updatedAt: new Date() },
      { upsert: true }
    );
  } catch (err) {
    console.log("⚠️ Failed to update cache:", err.message);
  }

  return allTxs;
}

// === Eligibility endpoint ===
app.get("/check-eligibility", async (req, res) => {
  const { wallet: walletRaw, ref: referrerWalletRaw } = req.query;
  
  // New: Check and log raw query parameters
  console.log(`🔍 Received eligibility check request.`);
  console.log(`   - Raw wallet: ${walletRaw}`);
  console.log(`   - Raw referrer: ${referrerWalletRaw}`);
  
  if (!walletRaw) return res.status(400).json({ error: "Missing wallet address" });

  const wallet = walletRaw.trim().toLowerCase();
  const referrerWallet = referrerWalletRaw ? referrerWalletRaw.trim().toLowerCase() : null;
  
  console.log(`   - Normalized wallet: ${wallet}`);
  console.log(`   - Normalized referrer: ${referrerWallet}`);

  let eligible = false;
  let totalAfterClaim = 0;

  try {
    if (referrerWallet && wallet !== referrerWallet) {
        console.log(`➡️ Attempting to create referral for: ${wallet} referred by ${referrerWallet}`);
        
        try {
            const existingReferral = await Referral.findOne({ referredWallet: wallet });
            if (!existingReferral) {
                const newReferral = new Referral({
                    referrerWallet: referrerWallet,
                    referredWallet: wallet,
                    bonusAmount: 300 // 300 $DECKER
                });
                await newReferral.save();
                console.log(`🎁 New referral recorded: ${wallet} referred by ${referrerWallet}`);
            } else {
                console.log(`🚫 Referral for ${wallet} already exists. Skipping.`);
            }
        } catch (dbError) {
            console.error("❌ Database error while saving referral:", dbError);
        }
    }
    
    const txs = await fetchTransactions(walletRaw.trim());
    console.log(`📦 Found ${txs?.length || 0} transactions for wallet ${wallet}`);

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
            const usdValue = solAmount * SOL_TO_USD;
            totalUSD += usdValue;
            relevantTxCount++;
            console.log(
              `   ➕ Tx matched: ${solAmount} SOL (~$${usdValue.toFixed(2)})`
            );
          }
        }
      }
    }

    let tier = null;
    let reward = 0;
    if (totalUSD >= 3_000_000) { tier = 1; reward = 25000; }
    else if (totalUSD >= 500_000) { tier = 2; reward = 15000; }
    else if (totalUSD >= 250_000) { tier = 3; reward = 7000; }
    else if (totalUSD >= 30_000) { tier = 4; reward = 3000; }
    else if (totalUSD >= 1_000) { tier = 5; reward = 1500; }

    console.log(`🏆 Tier assigned: ${tier}, Base reward: ${reward}`);

    const isOG = ogWhitelist.has(wallet);
    const isDegen = degenMfersMap.has(wallet);
    const isDecker = deckerRoleHolders.has(wallet);
    const degenBonus = isDegen ? degenMfersMap.get(wallet) : 0;
    const totalWithOG = isOG ? reward + 15000 : reward;

    let finalTotal = totalWithOG + degenBonus;
    if (isDecker) finalTotal += 15000;

    console.log(
      `👥 Flags → OG: ${isOG}, Degen: ${isDegen} (+${degenBonus}), Decker: ${isDecker}`
    );
    console.log(`💰 Final before claim: ${finalTotal}`);

    const claimRecord = await Claim.findOne({ wallet });
    let alreadyClaimed = 0;

    if (claimRecord) {
      console.log("📄 Claim record found:", claimRecord);
      
      if (claimRecord.humanAmount) {
        alreadyClaimed = parseFloat(claimRecord.humanAmount);
      } else if (claimRecord.claimedAmount) {
        alreadyClaimed = parseFloat(claimRecord.claimedAmount);
      } else if (claimRecord.amount && claimRecord.decimals) {
        alreadyClaimed = Number(claimRecord.amount) / Math.pow(10, claimRecord.decimals);
      }
    } else {
      console.log("ℹ️ No claim record found for this wallet yet.");
    }

    totalAfterClaim = Math.max(finalTotal - alreadyClaimed, 0);

    eligible = tier !== null;
    if (!eligible && (isOG || isDegen || isDecker)) {
      eligible = true;
      tier = null;
      console.log("⚠️ Eligible due to OG/Degen/Decker role despite no tier");
    }

    let referralBonus = 0;
    const pendingReferrals = await Referral.find({
      referrerWallet: wallet,
      status: "pending"
    });

    if (pendingReferrals.length > 0) {
      for (const referral of pendingReferrals) {
        referralBonus += referral.bonusAmount;
      }
      console.log(`🎁 Found ${pendingReferrals.length} pending referral bonuses, total: ${referralBonus}`);
    } else {
      console.log(`🎁 No pending referral bonuses found for this wallet.`);
    }

    console.log(
      `📊 Summary → USD Vol: ${totalUSD.toFixed(2)}, Tier: ${tier}, Eligible: ${eligible}, Already claimed: ${alreadyClaimed}, Final after claim: ${totalAfterClaim}, Referral Bonus: ${referralBonus}`
    );

    res.json({
      wallet,
      volumeUSD: totalUSD.toFixed(2),
      tier,
      reward,
      eligible,
      relevantTxCount,
      isOGHolder: isOG,
      totalWithOG,
      isDegenMfer: isDegen,
      degenBonus,
      isDeckerRoleHolder: isDecker,
      finalTotal: totalAfterClaim,
      alreadyClaimed,
      txCount: txs.length,
      referralBonus
    });
  } catch (err) {
    console.error("❌ Error checking eligibility:", err);
    res.status(500).json({ error: "Server error" });
  }
});

async function verifyTransaction(txSig) {
    try {
        console.log(`🔄 Verifying transaction signature: ${txSig}`);
        const status = await connection.getSignatureStatus(txSig, { searchTransactionHistory: true });
        console.log(`✅ Signature status:`, status.value);
        if (status.value && status.value.confirmationStatus === "finalized") {
            return true;
        }
        return false;
    } catch (err) {
        console.error("❌ Failed to verify transaction signature:", err);
        return false;
    }
}

// === Claim Referral Bonus Endpoint ===
app.post("/claim-referral", async (req, res) => {
  const { referrerWallet, txSig } = req.body;

  console.log(`Received claim referral request for wallet: ${referrerWallet} with txSig: ${txSig}`);

  if (!referrerWallet || !txSig) {
    console.log("Validation failed: Missing referrerWallet or txSig");
    return res.status(400).json({ error: "Missing required parameters: referrerWallet or txSig." });
  }

  try {
    const isTxValid = await verifyTransaction(txSig);
    if (!isTxValid) {
        console.log(`❌ Invalid or unconfirmed txSig provided: ${txSig}`);
        return res.status(400).json({ error: "Invalid or unconfirmed transaction signature provided." });
    }
    
    const pendingReferrals = await Referral.find({
      referrerWallet: referrerWallet.toLowerCase(),
      status: "pending",
    });

    if (pendingReferrals.length === 0) {
      console.log(`No pending referral bonuses found for ${referrerWallet}`);
      return res.status(404).json({ message: "No pending referral bonuses to claim." });
    }

    let totalBonus = 0;
    const referralIds = pendingReferrals.map(ref => ref._id);
    console.log(`Found ${pendingReferrals.length} pending referrals to claim.`);

    for (const referral of pendingReferrals) {
      totalBonus += referral.bonusAmount;
    }

    const updateResult = await Referral.updateMany(
      { _id: { $in: referralIds } },
      { $set: { status: "claimed", txSig: txSig } }
    );

    console.log(`✅ Successfully updated ${updateResult.modifiedCount} referrals for ${referrerWallet}`);
    
    res.status(200).json({
      message: "Referral bonus claimed successfully.",
      claimedAmount: totalBonus
    });

  } catch (err) {
    console.error("❌ Error claiming referral bonus:", err);
    res.status(500).json({ error: "Server error." });
  }
});

// === Load whitelists & start server ===
loadAllWhitelists().then(() => {
  console.log("📡 All whitelists loaded, starting server...");
  app.listen(5000, () => console.log("✅ Backend running on http://localhost:5000"));
}).catch(err => {
  console.error("❌ Failed to load whitelists:", err);
});
