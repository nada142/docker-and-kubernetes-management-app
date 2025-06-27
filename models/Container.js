const mongoose = require('mongoose');

const containerSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        unique: true
    },
     status: {
        type: String,
        enum: ['running', 'exited', 'created', 'paused', 'restarting', 'dead', 'removing'],
        default: 'created'
    },
    port: {
        type: Number,
    },
    dockerImage: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Image',
        required: true
    },
    containerId: { 
        type: String,
        required: true
    },
    volumes: [{ type: String }],

    isComposeContainer: { 
        type: Boolean,
        default: false
    },
        userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    

});

module.exports = mongoose.model('Container', containerSchema);
