const express = require('express');
const router = express.Router();
const { terminateSession } = require('../middleware/authMiddleware');

router.post('/logout', terminateSession, (req, res) => {
    req.logout();
    res.json({ message: 'Logged out successfully' });
});

module.exports = router;