const User = require('../models/User');

function updateUserActivity(req, res, next) {
    // Check if the user is logged in (i.e., req.session.user exists)
    if (req.session && req.session.user && req.session.user._id) {
        User.findByIdAndUpdate(req.session.user._id, { lastActive: new Date() }, { new: true })
            .then(() => next())
            .catch(err => next(err));
    } else {
        // If the user is not logged in, simply proceed to the next middleware
        next();
    }
}

module.exports = updateUserActivity;