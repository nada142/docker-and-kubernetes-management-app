const express = require('express');
const router = express.Router();
const hubConfigController = require('../controllers/hubConfigController'); 

router.post('/save', hubConfigController.saveHubConfig);


module.exports = router;
