// models/TxCache.js
const mongoose = require("mongoose");

const txCacheSchema = new mongoose.Schema({
  wallet: { type: String, required: true, unique: true },
  transactions: { type: Array, default: [] },
  updatedAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model("TxCache", txCacheSchema);
