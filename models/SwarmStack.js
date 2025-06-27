const mongoose = require('mongoose');

const swarmStackSchema = new mongoose.Schema({
    name: { type: String, required: true, unique: true }, 
    yamlContent: { type: String, required: true }, 
    createdAt: { type: Date, default: Date.now },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
    
});

module.exports = mongoose.model('SwarmStack', swarmStackSchema);