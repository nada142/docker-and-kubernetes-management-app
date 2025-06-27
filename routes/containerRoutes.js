const express = require('express');
const router = express.Router();
const Docker = require('dockerode');
const Container = require('../models/Container');

const containerController = require('../controllers/containerController');
const docker = new Docker({ socketPath: '/var/run/docker.sock' });
const { ensureAuthenticated } = require('../middleware/authMiddleware'); // Add this

router.post('/containers',ensureAuthenticated, containerController.createContainer);

router.post('/containers/:id/restart',ensureAuthenticated, containerController.startContainer);
router.post('/containers/:id/stop',ensureAuthenticated, containerController.stopContainer);
router.delete('/containers/:id',ensureAuthenticated, containerController.deleteContainer);
router.get('/containers/:id/status',ensureAuthenticated, containerController.getStatus);
router.get('/containers',ensureAuthenticated, containerController.listContainers);

router.get('/containers/:id/stats',ensureAuthenticated, async (req, res) => {
    try {
        const container = docker.getContainer(req.params.id);
        const statsStream = await container.stats({ stream: false });

        res.json(statsStream);
    } catch (error) {
        res.status(500).send({ error: 'Erreur lors de la récupération des stats' });
    }
});
router.get('/containers/:id/logs',ensureAuthenticated, async (req, res) => {
    try {
        const container = docker.getContainer(req.params.id);
        const logs = await container.logs({
            follow: false,
            stdout: true,
            stderr: true,
            timestamps: false
        });

        const logString = logs.toString('utf8');

        res.json({ logs: logString });
    } catch (error) {
        console.error('Error fetching logs:', error);
        res.status(500).json({ error: 'Failed to retrieve logs' });
    }
});

router.get('/count/containers', ensureAuthenticated, async (req, res) => {
    try {
        const containers = await Container.find({ userId: req.session.user._id });
        res.json({ count: containers.length });
    } catch (error) {
        console.error('Error fetching container count:', error);
        res.status(500).json({ error: 'Error fetching container count' });
    }
});


module.exports = router;
