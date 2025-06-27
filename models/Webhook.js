// models/Webhook.js
const mongoose = require('mongoose');

const WebhookSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    pipelineId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Pipeline'
    },
    url: {
        type: String,
        required: true
    },
    events: {
        type: [String],
        enum: ['push', 'merge_request', 'pipeline'],
        required: true
    },
    active: {
        type: Boolean,
        default: true
    },
    lastTriggered: {
        type: Date
    },
    secret: {
        type: String
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
});

module.exports = mongoose.model('Webhook', WebhookSchema);