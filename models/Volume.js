const mongoose = require('mongoose');

const volumeSchema = new mongoose.Schema({
    name: {
        type: String,
        required: [true, "Le nom du volume est requis"],
        unique: true,
        trim: true,
        match: [/^[a-zA-Z0-9-_]+$/, "Nom invalide (lettres, chiffres, tirets seulement)"]
    },
    driver: { 
        type: String, 
        default: 'local',
        enum: ['local', 'overlay', 'nfs', 'tmpfs']
    },
    options: { 
        type: Object,
        default: {}
    },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    
    labels: { 
        type: Map,
        of: String,
        default: {}
    }
}, { timestamps: true });

module.exports = mongoose.model('Volume', volumeSchema);