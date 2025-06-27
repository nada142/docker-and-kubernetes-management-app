const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const PipelineSchema = new Schema({
    name: {
        type: String,
        required: true
    },
    gitRepoUrl: {
        type: String,
        required: true
    },
    branch: {
        type: String,
        default: 'main'
    },
    gitlabCi: {
        type: String,
        default: ''
    },
    jenkinsfile: {
        type: String,
        default: ''
    },
    ciCd: {
        type: {
            type: String,
            enum: ['gitlab', 'jenkins'],
            required: true
        },
        integrationId: {
            type: Schema.Types.ObjectId,
            ref: 'CICDIntegration',
            required: true
        },
        name: {
            type: String,
            required: true
        },
        branch: {
            type: String,
            default: 'main'
        },
        webhook: {
            url: String,
            active: Boolean,
            lastTrigger: Date,
            events: [String]
        }
    },
    status: {
        type: String,
        enum: ['created', 'running', 'success', 'failed', 'unknown'],
        default: 'created'
    },
    lastRun: Date,
lastPipelineId: {
  type: String,
  index: true
},
gitlabPipelineData: {  
  type: Object
},
    lastRunDuration: Number,
    stages: [{
        name: String,
        status: String,
        duration: Number,
        startedAt: Date,
        jobs: [{
            name: String,
            status: String,
            duration: Number,
            errorMessage: String,
            logExcerpt: String
        }]
    }],
    errorDetails: {
        stage: String,
        jobName: String,
        errorMessage: String,
        logExcerpt: String
    },
 webhookEvents: [{
        eventType: String,
        payload: Object,
        receivedAt: { type: Date, default: Date.now }
    }],
    lastStatusChange: Date,
    statusHistory: [{
        status: String,
        changedAt: { type: Date, default: Date.now },
        triggeredBy: String 
    }]
}, {
    timestamps: true
});

PipelineSchema.pre('save', function(next) {
    if (this.isModified('status')) {
        this.statusHistory.push({
            status: this.status,
            changedAt: new Date(),
            triggeredBy: this.statusChangeReason || 'system'
        });
        this.lastStatusChange = new Date();
    }
    next();
});

module.exports = mongoose.model('Pipeline', PipelineSchema);