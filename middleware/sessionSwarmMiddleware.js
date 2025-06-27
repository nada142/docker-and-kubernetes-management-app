// middleware/sessionSwarmMiddleware.js
const SwarmSession = require('../models/SwarmSession');
const Docker = require('dockerode');
const docker = new Docker({ socketPath: '/var/run/docker.sock' });

async function trackSwarmSession(req, res, next) {
    if (!req.user) return next();
    
    try {
        // Check for existing session
        const existingSession = await SwarmSession.findOne({ userId: req.user._id });
        
        if (existingSession) {
            // Restore swarm if needed
            if (!existingSession.active) {
                await restoreSwarmState(req.user._id);
                existingSession.active = true;
                await existingSession.save();
            }
            
            req.swarmSession = existingSession;
        } else {
            // Create new session
            const swarmInfo = await docker.swarmInspect().catch(() => null);
            const newSession = new SwarmSession({
                userId: req.user._id,
                active: !!swarmInfo,
                nodes: swarmInfo ? await docker.listNodes() : []
            });
            
            await newSession.save();
            req.swarmSession = newSession;
        }
    } catch (error) {
        console.error('Session tracking error:', error);
    }
    
    next();
}

async function persistSwarmSession(req, res, next) {
    if (!req.user) return next();
    
    try {
        if (req.swarmSession) {
            const nodes = await docker.listNodes();
            await SwarmSession.updateOne(
                { _id: req.swarmSession._id },
                { 
                    nodes: nodes,
                    lastActive: new Date()
                }
            );
        }
    } catch (error) {
        console.error('Session persistence error:', error);
    }
    
    next();
}

module.exports = { trackSwarmSession, persistSwarmSession };