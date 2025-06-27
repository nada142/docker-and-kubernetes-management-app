const mongoose = require('mongoose');

const containerSchema = new mongoose.Schema({
    id: { type: String, required: true }, 
    name: { type: String, required: true }, 
    status: { type: String, default: 'running' }, 
    
    isComposeContainer: { 
        type: Boolean,
        default: true
    }
});

const serviceSchema = new mongoose.Schema({
    name: { type: String, required: true, unique: true }, 
    stack: { type: String, required: true }, 
    status: { type: String, default: 'stopped' }, 
    containers: [containerSchema], 
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    
    createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('Service', serviceSchema);









