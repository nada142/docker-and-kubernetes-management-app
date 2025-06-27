const express = require('express');
const router = express.Router();
const DockerFile = require('../models/dockerfilee'); 
const DockerImage = require('../models/Image'); 
const Docker = require('dockerode');
const docker = new Docker();
const { ensureAuthenticated } = require('../middleware/authMiddleware'); 
const Container = require('../models/Container');

router.get('/api/stats', ensureAuthenticated, async (req, res) => {
    try {
        const containers = await Container.find({ userId: req.session.user._id });
        
        const stats = {
            running: 0,
            exited: 0,
            created: 0,
            paused: 0,
            restarting: 0,
            all: containers.length
        };

        containers.forEach(container => {
            if (container.status && stats.hasOwnProperty(container.status)) {
                stats[container.status]++;
            }
        });
        
        res.json(stats);
    } catch (error) {
        console.error('Error fetching container stats:', error);
        res.status(500).json({ 
            error: 'Error fetching container stats',
            details: error.message 
        });
    }
});


module.exports = router;
