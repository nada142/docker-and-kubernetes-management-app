const mongoose = require('mongoose');

const swarmSessionSchema = new mongoose.Schema({
      userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        
    active: {
        type: Boolean,
        default: false
    },
    nodes: [{
        id: String,
        hostname: String,
        role: String,
        ip: String,
        joinToken: String
    }],
    stacks: [{
        name: String,
        yamlContent: String
    }],
    services: [{
        id: String,
        name: String,
        image: String,
        replicas: Number
    }],
    createdAt: {
        type: Date,
        default: Date.now
    },
    lastActive: {
        type: Date,
        default: Date.now
    }
});

module.exports = mongoose.model('SwarmSession', swarmSessionSchema);