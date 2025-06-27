const mongoose = require('mongoose');

const stackSchema = new mongoose.Schema({
    name: { type: String, required: true, unique: true }, 
    yamlContent: { type: String, required: true }, 
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('Stack', stackSchema);