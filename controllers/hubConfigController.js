const Docker = require('dockerode');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const HubConfig = require('../models/hubConfig');

const docker = new Docker({ socketPath: '/var/run/docker.sock' });


exports.saveHubConfig = async (req, res) => {
    const { username, password, repositoryUrl } = req.body;

    if (!username || !password || !repositoryUrl) {
        return res.status(400).json({ message: 'All fields are required.' });
    }

    try {
        const hubConfig = new HubConfig({ username, password, repositoryUrl });
        await hubConfig.save();

        res.status(200).json({ message: 'Docker Hub configuration saved successfully.' });
    } catch (error) {
        console.error('Error saving Docker Hub configuration:', error);
        res.status(500).json({ message: 'Error saving Docker Hub configuration.' });
    }
};
