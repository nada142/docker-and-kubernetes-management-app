const mongoose = require('mongoose');

const dockerImageSchema = new mongoose.Schema({
    name: {
        type: String,
        required: [true, 'Image name is required']
    },
    imageId: {
        type: String,
        required: [true, 'Image ID is required']
    },
    dateOfCreation: {
        type: Date,
        default: Date.now 
    },
    dockerfileId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Dockerfile',
        
        
    },
    dockerfileContent: {
        type: String,
      
    },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    
    tags: [{
        type: String
    }]
   

});

module.exports = mongoose.model('Image', dockerImageSchema);
