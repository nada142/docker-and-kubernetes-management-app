const mongoose = require('mongoose');

const dockerRegistrySchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
    },
    url: {
        type: String,
        required: true,
    },
    username: {
        type: String,
        required: true,
    },
    password: {
        type: String,
        required: true,
    },
    dateOfCreation: {
        type: Date,
        default: Date.now,
    },
        userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    
});

module.exports = mongoose.model('DockerRegistry', dockerRegistrySchema);