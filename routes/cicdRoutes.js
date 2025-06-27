const express = require('express');
const router = express.Router();
const cicdController = require('../controllers/cicdController');
const { ensureAuthenticated } = require('../middleware/authMiddleware');
const validateObjectId = require('../middleware/validateObjectId');

// CI/CD Integration
router.post('/cicd/jenkins/connect', cicdController.connectJenkins);
router.post('/cicd/gitlab/connect', cicdController.connectGitLab);

// Pipeline Management
router.post('/cicd/jenkins/pipeline', cicdController.createJenkinsPipeline);
router.post('/cicd/gitlab/pipeline', cicdController.createGitLabPipeline);

// Pipeline Operations
router.get('/cicd/pipelines/:id/status', cicdController.getPipelineStatus);
router.get('/cicd/pipelines/:id/jobs', cicdController.getPipelineJobs);

router.get('/cicd/templates', cicdController.getPipelineTemplates);
router.get('/cicd/templates/:templateId', cicdController.getTemplate);
router.get('/cicd/integrations', cicdController.getIntegrations);
router.post('/cicd/webhooks', cicdController.setupWebhooks);
router.get('/cicd/webhooks', cicdController.getWebhooks);
router.post('/cicd/pipelines/validate', cicdController.validatePipeline);


router.get('/cicd/pipelines/:id/file-status', cicdController.checkFileStatus);
router.post('/cicd/pipelines/:id/recreate-file', cicdController.recreateFile);
// Pipeline management
router.post('/cicd/pipelines', cicdController.createPipeline);
router.post('/cicd/pipelines/:id/run', validateObjectId, cicdController.runPipeline);
router.get('/cicd/pipelines', cicdController.getAllPipelines);
router.get('/cicd/pipelines/:id', validateObjectId, cicdController.getPipelineDetails);
router.delete('/cicd/pipelines/:id', validateObjectId, cicdController.deletePipeline);
router.delete('/cicd/integrations/:integrationId', cicdController.disconnectIntegration);
router.get('/cicd/pipeline-stats', cicdController.getPipelineStats);


router.get('/cicd/analysis', cicdController.analyzeRepository);


module.exports = router;