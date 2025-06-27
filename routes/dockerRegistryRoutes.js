const express = require('express');
const router = express.Router();
const dockerRegistryController = require('../controllers/dockerRegistryController');

const { ensureAuthenticated } = require('../middleware/authMiddleware'); 


router.post('/docker-registries',ensureAuthenticated, dockerRegistryController.addDockerRegistry);
router.get('/docker-registries',ensureAuthenticated, dockerRegistryController.getDockerRegistries);
router.get('/docker-registries/:registryId/search/:query', dockerRegistryController.searchImages);
router.put('/docker-registries/:registryId',ensureAuthenticated, dockerRegistryController.updateDockerRegistry); 
router.delete('/docker-registries/:registryId',ensureAuthenticated, dockerRegistryController.deleteDockerRegistry); 
module.exports = router;