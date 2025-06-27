const { body } = require('express-validator');

const validateJenkinsConfig = () => {
  return [
    body('jenkinsUrl').isURL().withMessage('Invalid Jenkins URL'),
    body('username').notEmpty().withMessage('Username is required'),
    body('apiToken').notEmpty().withMessage('API token is required')
  ];
};

const validateGitLabConfig = () => {
  return [
    body('gitlabUrl').isURL().withMessage('Invalid GitLab URL'),
    body('projectId').notEmpty().withMessage('Project ID is required'),
    body('accessToken').notEmpty().withMessage('Access token is required')
  ];
};

const validatePipelineConfig = () => {
  return [
    body('pipelineName').notEmpty().withMessage('Pipeline name is required'),
    body('gitRepoUrl').isURL().withMessage('Invalid repository URL'),
    body('deploymentName').notEmpty().withMessage('Deployment name is required'),
    body('imageName').notEmpty().withMessage('Image name is required')
  ];
};

module.exports = {
  validateJenkinsConfig,
  validateGitLabConfig,
  validatePipelineConfig
};