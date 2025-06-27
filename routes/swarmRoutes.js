const express = require('express');
const router = express.Router();
const swarmController = require('../controllers/swarmController');
const { ensureAuthenticated, logoutWithSwarmCleanup } = require('../middleware/authMiddleware');
const { trackSwarmSession, persistSwarmSession } = require('../middleware/sessionSwarmMiddleware');

router.use(trackSwarmSession);

// Initialize swarm
router.get('/swarm/init',swarmController.initializeSwarm);
router.post('/swarm/init',swarmController.initializeSwarm);

router.post('/logout', 
    logoutWithSwarmCleanup, 
    (req, res) => res.json({ message: 'Logged out successfully' })
);
// List all stacks
router.get('/swarm/stacks', swarmController.listStacks);

// Deploy a new stack
router.post('/swarm/stacks', swarmController.deployStack);

// List services in a stack
router.get('/swarm/stacks/:stackName/services', swarmController.listServicess);
router.get('/swarm/services', swarmController.listServices);

router.post('/swarm/services/:serviceId/restart', swarmController.restartService);

// Remove a stack
router.delete('/swarm/stacks/:stackName', swarmController.removeStack);

// List nodes
router.get('/swarm/nodes', swarmController.listNodes);
router.post('/swarm/services/:serviceId/stop', swarmController.stopService);
router.post('/swarm/nodes/:nodeId/drain', swarmController.drainNode);
router.delete('/swarm/nodes/:nodeId', swarmController.deleteNode);

router.post('/swarm/validate-yaml', swarmController.validateYAML);

router.get('/swarm/overview', swarmController.getSwarmOverview);
router.delete('/swarm/stacks/:stackName', swarmController.removeStack);
router.post('/swarm/nodes/add-worker', swarmController.addWorkerNode);
router.post('/swarm/nodes/add-manager', swarmController.addManagerNode);
// Logs & Metrics
router.get('/swarm/services/:serviceId/logs', swarmController.getServiceLogs); 
router.get('/swarm/metrics', swarmController.getClusterMetrics);
router.post('/swarm/nodes/:nodeId/promote', swarmController.promoteNode);
router.post('/swarm/nodes/:nodeId/demote', swarmController.demoteNode);
router.post('/swarm/services', swarmController.deployService);
router.post('/swarm/services/:serviceId/scale', swarmController.scaleService);
router.delete('/swarm/services/:serviceId', swarmController.deleteService);

module.exports = router;