const mongoose = require('mongoose');

const claimSchema = new mongoose.Schema({
    wallet: {
        type: String,
        required: true,
        lowercase: true,
        trim: true,
        index: true,
        unique: true,
    },
    claimedAmount: {
        type: Number,
        required: true,
    },
    claimedAt: {
        type: Date,
        default: Date.now,
    },
    txSig: {
        type: String,
        required: true,
    },
});

const Claim = mongoose.model('Claim', claimSchema);

module.exports = Claim;