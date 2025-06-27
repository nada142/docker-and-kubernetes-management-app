const express = require('express');
const router = express.Router();
const volumeController = require('../controllers/volumeController');
const { ensureAuthenticated } = require('../middleware/authMiddleware'); 
const Volume = require('../models/Volume');

router.get('/volumes',ensureAuthenticated, volumeController.listVolumes);
router.post('/volumes',ensureAuthenticated, volumeController.createVolume);
router.delete('/volumes/:name',ensureAuthenticated, volumeController.deleteVolume);
router.get('/volumes/:name',ensureAuthenticated, volumeController.inspectVolume);
router.delete('/volumes-prune',ensureAuthenticated, volumeController.pruneVolumes);


router.get('/count/volumes', ensureAuthenticated, async (req, res) => {
    try {
        const volumes = await Volume.find({ userId: req.session.user._id });
        res.json({ count: volumes.length });
    } catch (error) {
        console.error('Error fetching volume count:', error);
        res.status(500).json({ error: 'Error fetching volume count' });
    }
});
module.exports = router;