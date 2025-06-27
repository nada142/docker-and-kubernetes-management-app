const express = require('express');
const router = express.Router();
const Docker = require('dockerode');
const DockerImage = require('../models/Image');

const dockerImageController = require('../controllers/dockerImageController');
const docker = new Docker({ socketPath: '/var/run/docker.sock' });
const { ensureAuthenticated } = require('../middleware/authMiddleware'); 

// Routes
router.get('/images',ensureAuthenticated, dockerImageController.listImages); 

router.post('/images/:name/push',ensureAuthenticated, dockerImageController.pushImage);
router.delete('/images/:id',ensureAuthenticated, dockerImageController.deleteImage);
router.post('/images/:id/run',ensureAuthenticated, dockerImageController.runImage); 
router.get('/images/:id/status',ensureAuthenticated, dockerImageController.getStatus);
router.get('/images/:id',ensureAuthenticated, dockerImageController.getImageById);
router.post('/images/pull',ensureAuthenticated, dockerImageController.pullImageFromRegistry);
router.get('/images/:imageId/dockerfilees/:dockerfileId', dockerImageController.getDockerFile);
router.post('/images/prune',ensureAuthenticated, dockerImageController.pruneImages);



router.get('/count/images', ensureAuthenticated, async (req, res) => {
    try {
        const images = await DockerImage.find({ userId: req.session.user._id });
        res.json({ count: images.length });
    } catch (error) {
        console.error('Error fetching image count:', error);
        res.status(500).json({ error: 'Error fetching image count' });
    }
});

module.exports = router;
