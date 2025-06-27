
const { persistSwarmSession } = require('./sessionSwarmMiddleware');


function ensureAuthenticated(req, res, next) {
  if (req.session.authenticated) {
      // Make sure req.user is set for all authenticated routes
      req.user = { 
          id: req.session.user?._id || req.session.user?.id 
      };
      return next();
  }
  res.status(401).json({ error: 'Unauthorized' });
}

function logoutWithSwarmCleanup(req, res, next) {
  if (req.user) {
      persistSwarmSession(req, res, async () => {
          try {
              // Mark session as inactive
              await SwarmSession.updateOne(
                  { userId: req.user._id },
                  { active: false }
              );
              
              // Proceed with logout
              req.logout();
              next();
          } catch (error) {
              console.error('Logout cleanup error:', error);
              next(error);
          }
      });
  } else {
      next();
  }
}

module.exports = { ensureAuthenticated, logoutWithSwarmCleanup };