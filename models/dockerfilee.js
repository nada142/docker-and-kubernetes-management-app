const mongoose = require('mongoose');

const dockerfileSchema = new mongoose.Schema({
    lines: {
        type: [String], 
        required: [true, 'Lines are required']
    },
    name: {
        type: String,
    },
    content: {
        type: String, 
    },
    dateOfCreation: {
        type: Date,
        default: Date.now 
    },
    status: { 
        type: String, 
        enum: ['valid', 'invalid'], 
        default: 'valid' 
    },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    buildContextFiles: [{
        originalName: String,
        storedName: String,
        path: String,
        size: Number,
        uploadDate: {
            type: Date,
            default: Date.now
        }
    }],
    errors: [{ 
        type: String 
    }]
});

module.exports = mongoose.model('dockerfilee', dockerfileSchema);
