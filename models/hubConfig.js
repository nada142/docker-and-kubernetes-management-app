const mongoose = require('mongoose');

const hubConfigSchema = new mongoose.Schema({
    username: { type: String, required: true },
    password: { type: String, required: true },
    repositoryUrl: { type: String, required: true }
});

module.exports = mongoose.model('HubConfig', hubConfigSchema);
