const mongoose = require('mongoose');

const cicdIntegrationSchema = new mongoose.Schema({
  type: {
    type: String,
    required: true,
    enum: ['jenkins', 'gitlab']
  },
  url: {
    type: String,
    required: true
  },
  projectId: {
    type: String,
    required: function() { return this.type === 'gitlab'; }
  },
  credentials: {
    type: mongoose.Schema.Types.Mixed,
    required: true
  },
  status: {
    type: String,
    enum: ['connected', 'disconnected', 'error'],
    default: 'connected'
  },
  lastTested: {
    type: Date
  },
  createdAt: {
    type: Date,
    default: Date.now
  },

  updatedAt: {
    type: Date,
    default: Date.now
  }
  
});

cicdIntegrationSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.model('CICDIntegration', cicdIntegrationSchema);