const mongoose = require('mongoose');

const referralSchema = new mongoose.Schema({
    referrerWallet: {
        type: String,
        required: true,
        lowercase: true,
        trim: true,
        index: true,
    },
    referredWallet: {
        type: String,
        required: true,
        lowercase: true,
        trim: true,
        index: true,
        unique: true,
    },
    status: {
        type: String,
        enum: ['pending', 'claimed'],
        default: 'pending',
    },
    bonusAmount: {
        type: Number,
        default: 300,
    },
    txSig: {
        type: String,
        default: null,
    },
    createdAt: {
        type: Date,
        default: Date.now,
    },
});

const Referral = mongoose.model('Referral', referralSchema);

module.exports = Referral;