const mongoose = require('mongoose');

module.exports = (req, res, next) => {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
        return res.status(400).json({ 
            success: false, 
            message: 'Invalid ID format',
            error: `Cast to ObjectId failed for value "${req.params.id}"`
        });
    }
    next();
};