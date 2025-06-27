// routes/api.js
const express = require('express');
const router = express.Router();
const DockerImage = require('../models/Image');
const Container = require('../models/Container');
const Dockerfile = require('../models/dockerfilee');
const Volume = require('../models/Volume');

router.get('/user/counts', ensureAuthenticated, async (req, res) => {
    try {
        const userId = req.query.userId || req.session.user._id;
        
        const counts = {
            images: await DockerImage.countDocuments({ userId }),
            containers: await Container.countDocuments({ userId }),
            dockerfiles: await Dockerfile.countDocuments({ userId }),
            volumes: await Volume.countDocuments({ userId })
        };
        
        res.json({ success: true, counts });
    } catch (error) {
        console.error('Error fetching user counts:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch counts' });
    }
});

router.get('/user/container-stats', ensureAuthenticated, async (req, res) => {
    try {
        const userId = req.query.userId || req.session.user._id;
        
        const containers = await Container.find({ userId });
        
        const stats = {
            running: containers.filter(c => c.status === 'running').length,
            exited: containers.filter(c => c.status === 'exited').length,
            paused: containers.filter(c => c.status === 'paused').length,
            other: containers.filter(c => !['running', 'exited', 'paused'].includes(c.status)).length
        };
        
        res.json(stats);
    } catch (error) {
        console.error('Error fetching container stats:', error);
        res.status(500).json({ error: 'Failed to fetch container stats' });
    }
});

router.get('/user/activity', ensureAuthenticated, async (req, res) => {
    try {
        const userId = req.query.userId || req.session.user._id;
        const limit = parseInt(req.query.limit) || 5;
        
        const activities = await Activity.find({ userId })
            .sort({ timestamp: -1 })
            .limit(limit);
            
        res.json(activities);
    } catch (error) {
        console.error('Error fetching user activity:', error);
        res.status(500).json({ error: 'Failed to fetch activity' });
    }
});

module.exports = router;