// routes/activityRoutes.js
const express = require('express');
const router = express.Router();
const Activity = require('../models/Activity'); 
const { ensureAuthenticated } = require('../middleware/authMiddleware');

router.get('/api/activity', ensureAuthenticated, async (req, res) => {
    try {
        const activities = await Activity.find({ userId: req.session.user._id })
            .sort({ timestamp: -1 })
            .limit(5);
        res.json(activities);
    } catch (error) {
        console.error('Error fetching activities:', error);
        res.status(500).json({ error: 'Error fetching activities' });
    }
});

module.exports = router;