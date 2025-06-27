const express = require('express');
const router = express.Router();
const composeController = require('../controllers/composeController');
const { ensureAuthenticated } = require('../middleware/authMiddleware'); 

// List all services
router.get('/compose/services',ensureAuthenticated, composeController.listServices);
router.get('/compose/stats',ensureAuthenticated, composeController.getComposeStats);
// Start a service
router.post('/compose/services/:name/start',ensureAuthenticated, composeController.startService);

// Stop a service
router.post('/compose/services/:name/stop',ensureAuthenticated, composeController.stopService);

// Restart a service
router.post('/compose/services/:name/restart',ensureAuthenticated, composeController.restartService);


router.get('/compose/services/:name/logs',ensureAuthenticated, composeController.viewLogs);
router.get('/compose/containers/:containerId/logs', ensureAuthenticated, composeController.viewContainerLogs);

router.delete('/compose/services/:name',ensureAuthenticated, composeController.deleteService);

router.post('/compose/add', ensureAuthenticated,composeController.addService);

router.post('/compose/validate', ensureAuthenticated,composeController.validateYAML);
router.post('/compose/analyze-compose', ensureAuthenticated, composeController.analyzeCompose);
router.get('/compose/templates',ensureAuthenticated, composeController.getTemplates);

router.get('/compose/services/:name/containers',ensureAuthenticated, composeController.getContainers);
router.post('/compose/containers/:containerId/terminal',ensureAuthenticated, composeController.openTerminal);


router.delete('/compose/services/:name',ensureAuthenticated, composeController.deleteService);

router.get('/compose/services/:name/details', composeController.viewServiceDetails);


router.delete('/compose/stacks/:name',ensureAuthenticated, composeController.deleteStack);


router.put('/compose/stacks/:name',ensureAuthenticated, composeController.updateStack);


router.post('/compose/containers/:containerId/restart',ensureAuthenticated, composeController.restartContainer);


router.post('/compose/containers/:containerId/stop',ensureAuthenticated, composeController.stopContainer);


router.delete('/compose/containers/:containerId',ensureAuthenticated, composeController.deleteContainer);
router.get('/compose/stacks/:name',ensureAuthenticated, composeController.getStack);

module.exports = router;

