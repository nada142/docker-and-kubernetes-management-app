const crypto = require('crypto');
const axios = require('axios');
const fs = require('fs');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const CICDIntegration = require('../models/CICDIntegration');
const KubernetesDeployment = require('../models/KubernetesCluster');
const logger = require('../config/logger');
// const { validateJenkinsConfig, validateGitLabConfig } = require('../validators/cicdValidators');
const Pipeline = require('../models/Pipeline');


// Encryption configuration
const ENCRYPTION_KEY = (() => {
  let key = process.env.ENCRYPTION_KEY || 'your-secret-key-here';
  // Ensure key is 32 bytes for aes-256-cbc
  if (Buffer.byteLength(key, 'utf8') !== 32) {
      // Hash the key to produce a 32-byte key
      return crypto.createHash('sha256').update(key).digest();
  }
  return Buffer.from(key);
})();
const IV_LENGTH = 16;

// Helper function to encrypt text
function encrypt(text) {
    let iv = crypto.randomBytes(IV_LENGTH);
    let cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
    let encrypted = cipher.update(text);
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    return iv.toString('hex') + ':' + encrypted.toString('hex');
}

// Helper function to decrypt text
function decrypt(text) {
    let textParts = text.split(':');
    let iv = Buffer.from(textParts.shift(), 'hex');
    let encryptedText = Buffer.from(textParts.join(':'), 'hex');
    let decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
    let decrypted = decipher.update(encryptedText);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    return decrypted.toString();
}
const encrypted = '10dd7b62d306b3ae3c59e56d2c11eaed:5f60ff8e405e4e96ce3aeb779ea8f58248488afd8cb1885bea6ffab873846d26';
console.log(decrypt(encrypted));
// Jenkins API Helper
const jenkinsApi = {
    get: async (url, username, apiToken, retries = 3) => {
        const auth = Buffer.from(`${username}:${apiToken}`).toString('base64');
        for (let i = 0; i < retries; i++) {
            try {
                const response = await axios.get(url, {
                    headers: { 'Authorization': `Basic ${auth}` },
                    timeout: 10000
                });
                return response;
            } catch (error) {
                if (i === retries - 1) throw error;
                await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
            }
        }
    },
    post: async (url, xmlConfig, username, apiToken, retries = 3) => {
        const auth = Buffer.from(`${username}:${apiToken}`).toString('base64');
        for (let i = 0; i < retries; i++) {
            try {
                const response = await axios.post(url, xmlConfig, {
                    headers: {
                        'Authorization': `Basic ${auth}`,
                        'Content-Type': 'application/xml'
                    },
                    timeout: 15000
                });
                return response;
            } catch (error) {
                if (i === retries - 1) throw error;
                await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
            }
        }
    }
};

// GitLab API Helper
const gitlabApi = {
    request: async (method, url, token, data = null, retries = 3) => {
        for (let i = 0; i < retries; i++) {
            try {
                const response = await axios({
                    method,
                    url,
                    headers: {
                        'PRIVATE-TOKEN': token,
                        'Content-Type': 'application/json'
                    },
                    data,
                    timeout: 10000
                });
                return response;
            } catch (error) {
                if (i === retries - 1) {
                    throw error;
                }
                await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
            }
        }
    },
    fileExists: async (url, projectPath, filePath, token, branch = 'main') => {
        try {
          await axios.get(
            `${url}/api/v4/projects/${projectPath}/repository/files/${encodeURIComponent(filePath)}?ref=${branch}`,
            {
              headers: { 'PRIVATE-TOKEN': token },
              timeout: 5000
            }
          );
          return true;
        } catch (error) {
          if (error.response?.status === 404) {
            return false;
          }
          throw error;
        }
      }
};

exports.connectGitLab = async (req, res) => {
    console.log('GitLab connect request:', req.body);

    try {
        const { gitlabUrl, projectId, accessToken } = req.body;

        // Basic input check
        if (!gitlabUrl || !projectId || !accessToken) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields',
                errors: ['GitLab URL, Project ID, and Access Token are required']
            });
        }

        // Normalize GitLab URL
        const normalizedUrl = gitlabUrl.endsWith('/') ? gitlabUrl.slice(0, -1) : gitlabUrl;

        // Test GitLab connection
        const response = await gitlabApi.request(
            'get',
            `${normalizedUrl}/api/v4/projects/${projectId}`,
            accessToken
        );

        // Encrypt access token before saving
        const encryptedToken = encrypt(accessToken);

        // Save integration
        const integration = new CICDIntegration({
            type: 'gitlab',
            url: normalizedUrl,
            projectId,
            credentials: { accessToken: encryptedToken },
            status: 'connected',
            lastTested: new Date(),
            projectName: response.data.name_with_namespace || 'unknown'
        });

        await integration.save();

        logger.info(`GitLab integration created: ${integration._id}`);

        res.json({
            success: true,
            message: 'GitLab connected successfully',
            data: {
                id: integration._id,
                url: integration.url,
                projectName: integration.projectName,
                status: integration.status
            }
        });
    } catch (error) {
        logger.error(`GitLab connection failed: ${error.message}`, { error });

        let userMessage = 'Failed to connect to GitLab';
        let statusCode = 500;
        if (error.response) {
            if (error.response.status === 404) {
                userMessage = 'Project not found. Please check the Project ID.';
                statusCode = 400;
            } else if (error.response.status === 401) {
                userMessage = 'Invalid access token. Please check your credentials.';
                statusCode = 401;
            }
        } else if (error.message.includes('Invalid URL')) {
            userMessage = 'Invalid GitLab URL format';
            statusCode = 400;
        }

        res.status(statusCode).json({
            success: false,
            message: userMessage,
            error: error.message
        });
    }
};

exports.connectJenkins = async (req, res) => {
    console.log('Jenkins connect request:', req.body);

    try {
        const { jenkinsUrl, username, apiToken } = req.body;

        // Basic input check
        if (!jenkinsUrl || !username || !apiToken) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields',
                errors: ['Jenkins URL, Username, and API Token are required']
            });
        }

        // Test Jenkins connection
        const response = await jenkinsApi.get(`${jenkinsUrl}/api/json`, username, apiToken);

        // Encrypt API token before saving
        const encryptedToken = encrypt(apiToken);

        // Save integration
        const integration = new CICDIntegration({
            type: 'jenkins',
            url: jenkinsUrl,
            credentials: { username, apiToken: encryptedToken },
            status: 'connected',
            lastTested: new Date(),
            version: response.data.version || 'unknown'
        });

        await integration.save();

        logger.info(`Jenkins integration created: ${integration._id}`);

        res.json({
            success: true,
            message: 'Jenkins connected successfully',
            data: {
                id: integration._id,
                url: integration.url,
                version: integration.version,
                status: integration.status
            }
        });
    } catch (error) {
        logger.error(`Jenkins connection failed: ${error.message}`, { error });

        let userMessage = 'Failed to connect to Jenkins';
        let statusCode = 500;
        if (error.response) {
            if (error.response.status === 401) {
                userMessage = 'Invalid username or API token';
                statusCode = 401;
            } else if (error.response.status === 404) {
                userMessage = 'Jenkins URL not found';
                statusCode = 400;
            }
        } else if (error.message.includes('Invalid URL')) {
            userMessage = 'Invalid Jenkins URL format';
            statusCode = 400;
        }

        res.status(statusCode).json({
            success: false,
            message: userMessage,
            error: error.message.includes('timeout') ? 'Connection timed out. Please check the URL and try again.' : error.message
        });
    }
};

exports.setupWebhooks = async (req, res) => {
  try {
    const { deploymentName, namespace, webhookUrl } = req.body;
    
    const deployment = await KubernetesDeployment.findOne({ 
      name: deploymentName, 
      namespace 
    }).populate('ciCd.integrationId');
    
    if (!deployment || !deployment.ciCd) {
      return res.status(404).json({
        success: false,
        message: 'No CI/CD pipeline found for this deployment'
      });
    }
    
    const { ciCd } = deployment;
    let result;
    
    if (ciCd.type === 'jenkins') {
      // Setup Jenkins webhook
      const credentials = {
        username: ciCd.integrationId.credentials.username,
        apiToken: decrypt(ciCd.integrationId.credentials.apiToken)
      };
      
      try {
        await jenkinsApi.get(
          `${ciCd.integrationId.url}/job/${ciCd.name}/config.xml`,
          credentials.username,
          credentials.apiToken
        );
        
       
        result = { message: 'Jenkins webhook configured' };
      } catch (error) {
        throw new Error(`Failed to configure Jenkins webhook: ${error.message}`);
      }
    } else if (ciCd.type === 'gitlab') {
      // Setup GitLab webhook
      const response = await gitlabApi.request(
        'post',
        `${ciCd.integrationId.url}/api/v4/projects/${ciCd.integrationId.projectId}/hooks`,
        decrypt(ciCd.integrationId.credentials.accessToken),
        {
          url: webhookUrl,
          push_events: true,
          pipeline_events: true,
          merge_requests_events: true
        }
      );
      
      result = {
        message: 'GitLab webhook created successfully',
        webhookId: response.data.id
      };
    }
    
    // Save webhook reference
    deployment.ciCd.webhook = result;
    await deployment.save();
    
    res.json({
      success: true,
      data: result
    });
    
  } catch (error) {
    logger.error(`Webhook setup failed: ${error.message}`, { error });
    res.status(500).json({
      success: false,
      message: 'Failed to setup webhook',
      error: error.message
    });
  }
};




const pipelineTemplates = {
  basicDockerBuild: {
    id: 'basicDockerBuild',
    name: 'Basic Docker Build',
    description: 'Build and push a Docker image',
    tags: ['docker', 'build'],
    jenkins: (imageName = 'your-image') => `pipeline {
  agent any
  environment {
    DOCKER_IMAGE = "${imageName}"
  }
  stages {
    stage('Build') {
      steps {
        script {
          docker.build("\${DOCKER_IMAGE}")
        }
      }
    }
    stage('Push') {
      steps {
        script {
          docker.withRegistry('https://registry.hub.docker.com', 'docker-hub-credentials') {
            docker.image("\${DOCKER_IMAGE}").push()
          }
        }
      }
    }
  }
}`,
    gitlab: `variables:
  DOCKER_IMAGE: your-image

stages:
  - build
  - push

build:
  stage: build
  script:
    - docker build -t \$DOCKER_IMAGE .
    - echo "Docker image built"

push:
  stage: push
  script:
    - docker login -u \$CI_REGISTRY_USER -p \$CI_REGISTRY_PASSWORD \$CI_REGISTRY
    - docker push \$DOCKER_IMAGE
`,
    suggestedName: 'docker-build-pipeline'
  },
  k8sDeployment: {
    id: 'k8sDeployment',
    name: 'Kubernetes Deployment',
    description: 'Build Docker image and deploy to Kubernetes',
    tags: ['docker', 'kubernetes', 'deployment'],
    jenkins: (imageName = 'your-image', deploymentName = 'your-deployment') => `pipeline {
  agent any
  environment {
    DOCKER_IMAGE = "${imageName}"
    K8S_DEPLOYMENT = "${deploymentName}"
    K8S_NAMESPACE = "default"
  }
  stages {
    stage('Build') {
      steps {
        script {
          docker.build("\${DOCKER_IMAGE}")
        }
      }
    }
    stage('Push') {
      steps {
        script {
          docker.withRegistry('https://registry.hub.docker.com', 'docker-hub-credentials') {
            docker.image("\${DOCKER_IMAGE}").push()
          }
        }
      }
    }
    stage('Deploy') {
      steps {
        script {
          sh """
            kubectl set image deployment/\${K8S_DEPLOYMENT} \${K8S_DEPLOYMENT}=\${DOCKER_IMAGE} -n \${K8S_NAMESPACE}
            kubectl rollout status deployment/\${K8S_DEPLOYMENT} -n \${K8S_NAMESPACE}
          """
        }
      }
    }
  }
}`,
    gitlab: `variables:
  DOCKER_IMAGE: your-image
  K8S_DEPLOYMENT: your-deployment
  K8S_NAMESPACE: default

stages:
  - build
  - push
  - deploy

build:
  stage: build
  script:
    - docker build -t \$DOCKER_IMAGE .

push:
  stage: push
  script:
    - docker login -u \$CI_REGISTRY_USER -p \$CI_REGISTRY_PASSWORD \$CI_REGISTRY
    - docker push \$DOCKER_IMAGE

deploy:
  stage: deploy
  script:
    - kubectl set image deployment/\$K8S_DEPLOYMENT \$K8S_DEPLOYMENT=\$DOCKER_IMAGE -n \$K8S_NAMESPACE
    - kubectl rollout status deployment/\$K8S_DEPLOYMENT -n \$K8S_NAMESPACE
`,
    suggestedName: 'k8s-deployment-pipeline'
  },
  nodejsApp: {
    id: 'nodejsApp',
    name: 'Node.js Application',
    description: 'Build, test and deploy a Node.js application',
    parameters: [
      {
        name: 'NODE_VERSION',
        description: 'Node.js version to use',
        defaultValue: '16',
        required: true
      },
      {
        name: 'TEST_SCRIPT',
        description: 'npm test script',
        defaultValue: 'test'
      }
    ],
    jenkins: (params = {}) => `pipeline {
  agent any
  environment {
    NODE_VERSION = '${params.NODE_VERSION || '16'}'
    APP_NAME = 'my-node-app'
  }
  stages {
    stage('Install') {
      steps {
        sh 'nvm install \$NODE_VERSION'
        sh 'npm install'
      }
    }
    stage('Test') {
      steps {
        sh 'npm run ${params.TEST_SCRIPT || 'test'}'
      }
    }
    stage('Build') {
      when {
        branch 'main'
      }
      steps {
        sh 'npm run build'
        archiveArtifacts 'dist/**/*'
      }
    }
  }
}`,
    gitlab: (params = {}) => `image: node:${params.NODE_VERSION || '16'}-alpine

stages:
  - install
  - test
  - build

cache:
  paths:
    - node_modules/

install_dependencies:
  stage: install
  script:
    - npm install

run_tests:
  stage: test
  script:
    - npm run ${params.TEST_SCRIPT || 'test'}

build_app:
  stage: build
  only:
    - main
  script:
    - npm run build
  artifacts:
    paths:
      - dist/`,
    suggestedName: 'nodejs-app-pipeline'
  },
  pythonDjango: {
    id: 'pythonDjango',
    name: 'Python Django',
    description: 'Build, test and deploy a Django application',
    parameters: [
      {
        name: 'PYTHON_VERSION',
        description: 'Python version',
        defaultValue: '3.9'
      },
      {
        name: 'DJANGO_VERSION',
        description: 'Django version constraint',
        defaultValue: '>=3.2,<4.0'
      }
    ],
    jenkins: (params = {}) => `pipeline {
  agent {
    docker {
      image 'python:${params.PYTHON_VERSION || '3.9'}-slim'
    }
  }
  environment {
    DJANGO_SETTINGS_MODULE = 'project.settings'
  }
  stages {
    stage('Setup') {
      steps {
        sh 'python -m pip install --upgrade pip'
        sh 'pip install "django${params.DJANGO_VERSION || '>=3.2,<4.0'}"'
        sh 'pip install -r requirements.txt'
      }
    }
    stage('Test') {
      steps {
        sh 'python manage.py test'
      }
    }
    stage('Migrate') {
      when {
        branch 'main'
      }
      steps {
        sh 'python manage.py migrate'
      }
    }
  }
}`,
    gitlab: (params = {}) => `image: python:${params.PYTHON_VERSION || '3.9'}-slim

variables:
  DJANGO_SETTINGS_MODULE: "project.settings"

stages:
  - setup
  - test
  - migrate

before_script:
  - python -m pip install --upgrade pip
  - pip install "django${params.DJANGO_VERSION || '>=3.2,<4.0'}"
  - pip install -r requirements.txt

run_tests:
  stage: test
  script:
    - python manage.py test

run_migrations:
  stage: migrate
  only:
    - main
  script:
    - python manage.py migrate`,
    suggestedName: 'django-app-pipeline'
  },
 flaskApp: {
    id: 'flaskApp',
    name: 'Flask Application',
    description: 'Build, test and deploy a Flask application',
    parameters: [], 
    jenkins: () => ``, 
    gitlab: () => `stages:
  - test
  - build

variables:
  DOCKER_DRIVER: overlay2
  IMAGE_NAME: flask-app-test-image

# Test stage
test-flask:
  stage: test
  image: python:3.10
  script:
    - pip install -r requirements.txt
    - python -m py_compile app.py

# Build stage
build-image:
  stage: build
  image: docker:latest
  services:
    - docker:dind
  script:
    - docker build -t $IMAGE_NAME:$CI_COMMIT_SHORT_SHA .
    - docker tag $IMAGE_NAME:$CI_COMMIT_SHORT_SHA $IMAGE_NAME:latest`,
    suggestedName: 'flask-app-pipeline'
  }
};

exports.getPipelineTemplates = async (req, res) => {
  try {
    res.json({
      success: true,
      data: Object.keys(pipelineTemplates).map(key => ({
        id: key,
        name: pipelineTemplates[key].name,
        description: pipelineTemplates[key].description
      }))
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to fetch templates',
      error: error.message
    });
  }
};


exports.getWebhooks = async (req, res) => {
  try {
    const deployments = await KubernetesDeployment.find({ 'ciCd.webhook': { $exists: true } })
      .populate('ciCd.integrationId');

    const webhooks = deployments.map(d => ({
      id: d._id,
      pipelineName: d.ciCd.name || d.name,
      type: d.ciCd.type,
      url: d.ciCd.webhook?.url,
      active: d.ciCd.webhook?.active || false,
      lastTrigger: d.ciCd.webhook?.lastTrigger
    }));

    res.json({ success: true, data: webhooks });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to fetch webhooks',
      error: error.message
    });
  }
};

exports.getTemplate = async (req, res) => {
  try {
    const { templateId } = req.params;
    const template = pipelineTemplates[templateId];
    
    if (!template) {
      return res.status(404).json({
        success: false,
        message: 'Template not found'
      });
    }

    const templateData = {
      id: templateId,
      name: template.name,
      description: template.description,
      jenkins: typeof template.jenkins === 'function' ? template.jenkins() : template.jenkins,
      gitlab: typeof template.gitlab === 'function' ? template.gitlab() : template.gitlab,
      suggestedName: template.suggestedName || template.name.toLowerCase().replace(/\s+/g, '-') + '-pipeline',
      parameters: template.parameters || []
    };

    res.json({
      success: true,
      data: templateData
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to fetch template',
      error: error.message
    });
  }
};

exports.createPipeline = async (req, res) => {
    try {
const { pipelineName, gitRepoUrl, branch, jenkinsfile, gitlabCi, ciCdType } = req.body;
        // Validate input
        if (!pipelineName || !gitRepoUrl || !ciCdType) {
            return res.status(400).json({
                success: false,
                message: 'Pipeline name, repository URL and CI/CD type are required'
            });
        }

        // Get GitLab integration
         const integration = await CICDIntegration.findOne({ type: ciCdType, status: 'connected' });
        if (!integration) {
            return res.status(400).json({
                success: false,
                message: `No ${ciCdType} integration configured`
            });
        }

        // Decrypt access token
        let decryptedToken;
        try {
            decryptedToken = decrypt(integration.credentials.accessToken);
        } catch (decryptError) {
            console.error('Token decryption failed:', decryptError);
            return res.status(500).json({
                success: false,
                message: 'Failed to decrypt access token'
            });
        }

        // Create pipeline
        const pipeline = new Pipeline({
            name: pipelineName,
            gitRepoUrl,
            branch: branch || 'main',
            jenkinsfile: ciCdType === 'jenkins' ? jenkinsfile : undefined,
            gitlabCi: ciCdType === 'gitlab' ? gitlabCi : undefined,
            ciCd: {
                type: ciCdType,
                integrationId: integration._id,
                name: pipelineName,
                branch: branch || 'main'
            },
            status: 'created'
        });

        await pipeline.save();

        // Commit .gitlab-ci.yml to repository if gitlabCi is provided
        if (gitlabCi) {
            const repoUrl = gitRepoUrl.replace(/\.git$/, '');
            const projectPath = repoUrl.replace('https://gitlab.com/', '');
            const encodedProjectPath = encodeURIComponent(projectPath);
            const commitApiUrl = `${integration.url}/api/v4/projects/${encodedProjectPath}/repository/commits`;

            try {
                await axios.post(
                    commitApiUrl,
                    {
                        branch: branch || 'main',
                        commit_message: `Add .gitlab-ci.yml for pipeline ${pipelineName}`,
                        actions: [
                            {
                                action: 'create',
                                file_path: '.gitlab-ci.yml',
                                content: gitlabCi
                            }
                        ]
                    },
                    {
                        headers: {
                            'PRIVATE-TOKEN': decryptedToken,
                            'Content-Type': 'application/json'
                        },
                        timeout: 10000
                    }
                );
                console.log(`Committed .gitlab-ci.yml to ${gitRepoUrl}`);
            } catch (commitError) {
                console.error('Failed to commit .gitlab-ci.yml:', commitError.response?.data || commitError.message);
                // Don't fail the pipeline creation if commit fails; log and proceed
            }
        }

        res.json({
            success: true,
            message: 'Pipeline created successfully',
            data: pipeline
        });
    } catch (error) {
        console.error('Create pipeline error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to create pipeline',
            error: error.message
        });
    }
};


exports.runPipeline = async (req, res) => {
  const { id } = req.params;
  let pipeline;

  try {
    // 1. Validate pipeline exists
    pipeline = await Pipeline.findById(id).populate('ciCd.integrationId');
    if (!pipeline) {
      return res.status(404).json({ 
        success: false, 
        message: 'Pipeline not found' 
      });
    }

    // 2. Validate GitLab integration
    if (!pipeline.ciCd?.integrationId || pipeline.ciCd.type !== 'gitlab') {
      return res.status(400).json({
        success: false,
        message: 'Pipeline is not properly configured with GitLab'
      });
    }

    const integration = pipeline.ciCd.integrationId;

    // 3. Decrypt token safely
    let decryptedToken;
    try {
      decryptedToken = decrypt(integration.credentials.accessToken);
    } catch (decryptError) {
      console.error('Token decryption failed:', decryptError);
      return res.status(500).json({
        success: false,
        message: 'Failed to authenticate with GitLab'
      });
    }

    // 4. Extract project path from GitLab URL
    let projectPath;
    try {
      const repoUrl = new URL(pipeline.gitRepoUrl);
      projectPath = repoUrl.pathname.replace(/^\//, '').replace(/\.git$/, '');
      if (!projectPath) throw new Error('Empty project path');
    } catch (error) {
      return res.status(400).json({
        success: false,
        message: 'Invalid GitLab repository URL',
        details: pipeline.gitRepoUrl
      });
    }

    const encodedProjectPath = encodeURIComponent(projectPath);
    const branch = pipeline.branch || 'main';

    if (pipeline.gitlabCi) {
      const fileExists = await gitlabApi.fileExists(
        integration.url,
        encodedProjectPath,
        '.gitlab-ci.yml',
        decryptedToken,
        branch
      );

      const action = fileExists ? 'update' : 'create';
      try {
        await gitlabApi.request(
          'post',
          `${integration.url}/api/v4/projects/${encodedProjectPath}/repository/commits`,
          decryptedToken,
          {
            branch,
            commit_message: `${action === 'update' ? 'Update' : 'Create'} .gitlab-ci.yml for pipeline ${pipeline.name}`,
            actions: [
              {
                action,
                file_path: '.gitlab-ci.yml',
                content: pipeline.gitlabCi
              }
            ]
          }
        );
        console.log(`${action === 'update' ? 'Updated' : 'Created'} .gitlab-ci.yml for pipeline ${pipeline.name}`);
      } catch (commitError) {
        console.error(`Failed to ${action} .gitlab-ci.yml:`, commitError.response?.data || commitError.message);
      }
    } else {
      console.warn(`No .gitlab-ci.yml content found for pipeline ${pipeline.name}`);
    }

    // 6. Trigger GitLab pipeline
    const gitlabResponse = await axios.post(
      `${integration.url}/api/v4/projects/${encodedProjectPath}/pipeline?ref=${branch}`,
      {},
      { 
        headers: { 
          'PRIVATE-TOKEN': decryptedToken,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      }
    );

    // 7. Update pipeline status
    pipeline.status = 'running';
    pipeline.lastRun = new Date();
    pipeline.lastPipelineId = gitlabResponse.data.id;
    await pipeline.save();

    // 8. Broadcast initial status
    const { broadcastCICDEvent } = require('../app');
    broadcastCICDEvent(id, {
      type: 'pipeline_status',
      status: 'running',
      pipelineId: id,
      gitlabPipelineId: gitlabResponse.data.id,
      webUrl: gitlabResponse.data.web_url,
      message: 'Pipeline started'
    });

    // 9. Start status polling
    startPipelinePolling(id, gitlabResponse.data.id, integration, encodedProjectPath, decryptedToken);

    res.json({
      success: true,
      message: 'Pipeline triggered successfully',
      data: gitlabResponse.data
    });

  } catch (error) {
    console.error('Pipeline run error:', error);

    // Update status to failed if pipeline exists
    if (pipeline) {
      pipeline.status = 'failed';
      await pipeline.save();

      const { broadcastCICDEvent } = require('../app');
      broadcastCICDEvent(id, {
        type: 'pipeline_status',
        status: 'failed',
        error: error.message
      });
    }

    let errorMessage = 'Failed to trigger pipeline';
    if (error.response) {
      errorMessage = error.response.data?.message || errorMessage;
      console.error('GitLab API error:', error.response.data);
      if (error.response.status === 400 && error.response.data?.message.includes('No CI configuration found')) {
        errorMessage = 'No .gitlab-ci.yml file found. Please ensure the pipeline configuration is saved.';
      }
    }

    res.status(500).json({
      success: false,
      message: errorMessage,
      error: error.message,
      details: error.response?.data || null
    });
  }
};

// Add to controller
exports.checkFileStatus = async (req, res) => {
    try {
        const { id } = req.params;
        const pipeline = await Pipeline.findById(id).populate('ciCd.integrationId');
        
        if (!pipeline || pipeline.ciCd.type !== 'gitlab') {
            return res.json({ exists: false });
        }

        const integration = pipeline.ciCd.integrationId;
        const decryptedToken = decrypt(integration.credentials.accessToken);
        const repoUrl = pipeline.gitRepoUrl.replace(/\.git$/, '');
        const projectPath = repoUrl.replace('https://gitlab.com/', '');
        const encodedProjectPath = encodeURIComponent(projectPath);
        
        try {
            await axios.get(
                `${integration.url}/api/v4/projects/${encodedProjectPath}/repository/files/.gitlab-ci.yml`,
                {
                    headers: { 'PRIVATE-TOKEN': decryptedToken },
                    params: { ref: pipeline.branch || 'main' }
                }
            );
            res.json({ exists: true });
        } catch (error) {
            if (error.response?.status === 404) {
                res.json({ exists: false });
            } else {
                throw error;
            }
        }
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Failed to check file status',
            error: error.message
        });
    }
};

exports.recreateFile = async (req, res) => {
    try {
        const { id } = req.params;
        const { content } = req.body;
        
        const pipeline = await Pipeline.findById(id).populate('ciCd.integrationId');
        if (!pipeline || pipeline.ciCd.type !== 'gitlab') {
            return res.status(400).json({ success: false, message: 'Invalid pipeline' });
        }

        const integration = pipeline.ciCd.integrationId;
        const decryptedToken = decrypt(integration.credentials.accessToken);
        const repoUrl = pipeline.gitRepoUrl.replace(/\.git$/, '');
        const projectPath = repoUrl.replace('https://gitlab.com/', '');
        const encodedProjectPath = encodeURIComponent(projectPath);
        
        await axios.post(
            `${integration.url}/api/v4/projects/${encodedProjectPath}/repository/files/.gitlab-ci.yml`,
            {
                branch: pipeline.branch || 'main',
                content: Buffer.from(content).toString('base64'),
                commit_message: `Recreated .gitlab-ci.yml for pipeline ${pipeline.name}`
            },
            {
                headers: { 'PRIVATE-TOKEN': decryptedToken }
            }
        );
        
        res.json({ success: true, message: 'File recreated successfully' });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Failed to recreate file',
            error: error.message
        });
    }
};
exports.getPipelineJobs = async (req, res) => {
  const { id } = req.params;

  try {
    const pipeline = await Pipeline.findById(id).populate('ciCd.integrationId');
    if (!pipeline?.lastPipelineId) {
      return res.status(404).json({ success: false, message: 'No pipeline runs found' });
    }

    const integration = pipeline.ciCd.integrationId;
    const decryptedToken = decrypt(integration.credentials.accessToken);
    const repoUrl = new URL(pipeline.gitRepoUrl);
    const projectPath = encodeURIComponent(repoUrl.pathname.replace(/^\//, '').replace(/\.git$/, ''));

    // Get jobs with logs
    const jobsResponse = await axios.get(
      `${integration.url}/api/v4/projects/${projectPath}/pipelines/${pipeline.lastPipelineId}/jobs`,
      { 
        headers: { 'PRIVATE-TOKEN': decryptedToken },
        params: { scope: 'failed' } // Only get failed jobs by default
      }
    );

    // Enhance with log data
    const jobsWithLogs = await Promise.all(jobsResponse.data.map(async job => {
      try {
        const logResponse = await axios.get(
          `${integration.url}/api/v4/projects/${projectPath}/jobs/${job.id}/trace`,
          { headers: { 'PRIVATE-TOKEN': decryptedToken } }
        );
        return {
          ...job,
          log: logResponse.data,
          logExcerpt: logResponse.data.split('\n').slice(-20).join('\n') // Last 20 lines
        };
      } catch (e) {
        return { ...job, log: 'Failed to load logs', logExcerpt: 'Failed to load logs' };
      }
    }));

    res.json({
      success: true,
      data: {
        pipeline: pipeline.toObject(),
        jobs: jobsWithLogs
      }
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to get pipeline jobs',
      error: error.message
    });
  }
};
async function startPipelinePolling(pipelineId, gitlabPipelineId, integration, projectPath, token) {
  const { broadcastCICDEvent } = require('../app');
  let pollingInterval = 5000; //  5 second interval
  
  const poll = async () => {
    try {
      const response = await axios.get(
        `${integration.url}/api/v4/projects/${projectPath}/pipelines/${gitlabPipelineId}`,
        { 
          headers: { 'PRIVATE-TOKEN': token },
          timeout: 10000
        }
      );
      
      const status = response.data.status;
      const pipeline = await Pipeline.findById(pipelineId);
      
      if (pipeline) {
        // Update pipeline status
        pipeline.status = status;
        pipeline.lastRun = new Date();
        
        // If pipeline finished, get detailed job info
        if (status === 'success' || status === 'failed') {
          const jobsResponse = await axios.get(
            `${integration.url}/api/v4/projects/${projectPath}/pipelines/${gitlabPipelineId}/jobs`,
            { headers: { 'PRIVATE-TOKEN': token } }
          );
          
          pipeline.stages = jobsResponse.data.reduce((stages, job) => {
            let stage = stages.find(s => s.name === job.stage);
            if (!stage) {
              stage = { name: job.stage, status: job.status, jobs: [] };
              stages.push(stage);
            }
            stage.jobs.push({
              name: job.name,
              status: job.status,
              duration: job.duration,
              webUrl: job.web_url
            });
            return stages;
          }, []);
          
          if (status === 'failed') {
            const failedJob = jobsResponse.data.find(j => j.status === 'failed');
            if (failedJob) {
              pipeline.errorDetails = {
                stage: failedJob.stage,
                jobName: failedJob.name,
                errorMessage: failedJob.failure_reason || 'Job failed'
              };
            }
          }
        }
        
        await pipeline.save();
      }
      
      // Broadcast update
      broadcastCICDEvent(pipelineId, {
        type: 'pipeline_status',
        status: status,
        stages: pipeline?.stages,
        webUrl: response.data.web_url,
        lastRun: new Date(),
        ...(status === 'failed' && pipeline?.errorDetails 
          ? { error: pipeline.errorDetails.errorMessage } 
          : {})
      });
      
      // Adjust polling interval based on status
      if (status === 'running') {
        pollingInterval = 5000; // Poll every 5 seconds when running
        setTimeout(poll, pollingInterval);
      } else if (status === 'pending') {
        pollingInterval = 3000; // Poll more frequently when pending
        setTimeout(poll, pollingInterval);
      }
      // Stop polling if pipeline is finished
      
    } catch (error) {
      console.error('Polling error:', error);
      // Retry with backoff
      pollingInterval = Math.min(30000, pollingInterval * 2);
      setTimeout(poll, pollingInterval);
    }
  };
  
  // Start initial poll
  poll();
}




exports.createJenkinsPipeline = async (req, res) => {
  try {
    const { 
      pipelineName, 
      gitRepoUrl, 
      branch = 'main',
      kubeNamespace = 'default',
      deploymentName,
      dockerfilePath = 'Dockerfile',
      imageName,
      template
    } = req.body;
    
    // Validate required fields
    if (!pipelineName || !gitRepoUrl || !deploymentName || !imageName) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields',
        required: ['pipelineName', 'gitRepoUrl', 'deploymentName', 'imageName']
      });
    }
    
    // Get Jenkins integration
    const integration = await CICDIntegration.findOne({ type: 'jenkins', status: 'connected' });
    if (!integration) {
      return res.status(400).json({
        success: false,
        message: 'No active Jenkins integration found'
      });
    }
    
    // Use template if specified
    let jenkinsfileContent;
    if (template && pipelineTemplates[template]) {
      jenkinsfileContent = pipelineTemplates[template].jenkins(imageName)
        .replace(/\${KUBE_NAMESPACE}/g, kubeNamespace)
        .replace(/\${DEPLOYMENT_NAME}/g, deploymentName);
    } else {
      // Default Jenkinsfile content
      jenkinsfileContent = `
pipeline {
  agent any
  
  environment {
    DOCKER_IMAGE = "${imageName}"
    KUBE_NAMESPACE = "${kubeNamespace}"
    DEPLOYMENT_NAME = "${deploymentName}"
  }
  
  stages {
    stage('Checkout') {
      steps {
        checkout scm
      }
    }
    
    stage('Build Docker Image') {
      steps {
        script {
          docker.build("\${DOCKER_IMAGE}", "-f ${dockerfilePath} .")
        }
      }
    }
    
    stage('Push to Registry') {
      steps {
        script {
          docker.withRegistry('https://registry.hub.docker.com', 'docker-hub-credentials') {
            docker.image("\${DOCKER_IMAGE}").push()
          }
        }
      }
    }
    
    stage('Deploy to Kubernetes') {
      steps {
        script {
          sh """
            kubectl set image deployment/\${DEPLOYMENT_NAME} \${DEPLOYMENT_NAME}=\${DOCKER_IMAGE} -n \${KUBE_NAMESPACE}
            kubectl rollout status deployment/\${DEPLOYMENT_NAME} -n \${KUBE_NAMESPACE}
          """
        }
      }
    }
  }
  
  post {
    success {
      slackSend(color: '#00FF00', message: 'Pipeline SUCCESS: \${JOB_NAME} - \${BUILD_NUMBER}')
    }
    failure {
      slackSend(color: '#FF0000', message: 'Pipeline FAILED: \${JOB_NAME} - \${BUILD_NUMBER}')
    }
  }
}`;
    }
    
    
    
    res.json({
      success: true,
      message: 'Jenkins pipeline created successfully',
      data: { jenkinsfileContent }
    });
    
  } catch (error) {
    logger.error(`Pipeline creation failed: ${error.message}`, { error });
    res.status(500).json({
      success: false,
      message: 'Failed to create pipeline',
      error: error.message,
      details: error.response?.data || null
    });
  }
};
exports.validatePipeline = async (req, res) => {
  try {
      const { content, type } = req.body;
      
      if (!content || !type) {
          return res.status(400).json({
              success: false,
              message: 'Content and type are required'
          });
      }

      let isValid = true;
      const errors = [];

      if (type === 'jenkins') {
          if (!content.includes('pipeline') && !content.includes('node')) {
              isValid = false;
              errors.push('Jenkinsfile should contain at least a pipeline or node block');
          }
      } else if (type === 'gitlab') {
          if (!content.includes('stages:')) {
              isValid = false;
              errors.push('GitLab CI file should contain stages definition');
          }
      }

      if (isValid) {
          res.json({ success: true, message: 'Pipeline is valid' });
      } else {
          res.status(400).json({ 
              success: false, 
              message: 'Validation failed',
              errors: errors 
          });
      }
  } catch (error) {
      res.status(500).json({
          success: false,
          message: 'Validation error',
          error: error.message
      });
  }
};
exports.createGitLabPipeline = async (req, res) => {
  try {
    const {
      gitRepoUrl,
      branch,
      kubeNamespace,
      deploymentName,
      dockerfilePath,
      imageName
    } = req.body;
    
    // Get GitLab integration
    const integration = await CICDIntegration.findOne({ type: 'gitlab', status: 'connected' });
    if (!integration) {
      throw new Error('No active GitLab integration found');
    }
    
    // GitLab CI/CD configuration
    const gitlabCiContent = `
stages:
  - build
  - test
  - deploy

variables:
  DOCKER_IMAGE: ${imageName}
  KUBE_NAMESPACE: ${kubeNamespace}
  DEPLOYMENT_NAME: ${deploymentName}

build:
  stage: build
  script:
    - docker build -t $DOCKER_IMAGE -f ${dockerfilePath} .
    - docker push $DOCKER_IMAGE
  only:
    - ${branch}

deploy:
  stage: deploy
  script:
    - kubectl set image deployment/$DEPLOYMENT_NAME $DEPLOYMENT_NAME=$DOCKER_IMAGE -n $KUBE_NAMESPACE
    - kubectl rollout status deployment/$DEPLOYMENT_NAME -n $KUBE_NAMESPACE
  only:
    - ${branch}
    `;
    
    // Create .gitlab-ci.yml file in the repository
    const response = await gitlabApi.request(
      'post',
      `${integration.url}/api/v4/projects/${integration.projectId}/repository/files/.gitlab-ci.yml`,
      integration.credentials.accessToken,
      {
        branch,
        content: Buffer.from(gitlabCiContent).toString('base64'),
        commit_message: 'Add CI/CD configuration'
      }
    );
    
    // Save pipeline reference
    const pipeline = {
      name: 'GitLab CI/CD',
      type: 'gitlab',
      integrationId: integration._id,
      gitRepoUrl,
      branch,
      kubeNamespace,
      deploymentName,
      gitlabCi: gitlabCiContent,
      createdAt: new Date()
    };
    
    // Update deployment with CI/CD info
    await KubernetesDeployment.findOneAndUpdate(
      { name: deploymentName, namespace: kubeNamespace },
      { $set: { ciCd: pipeline } },
      { new: true, upsert: false }
    );
    
    res.json({
      success: true,
      message: 'GitLab CI/CD pipeline configured successfully',
      data: {
        pipeline,
        gitlabCi: gitlabCiContent
      }
    });
    
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to configure GitLab CI/CD',
      error: error.message
    });
  }
};
exports.getPipelineStatus = async (req, res) => {
     const { id } = req.params;
  
  try {
    const pipeline = await Pipeline.findById(id);
    if (!pipeline) {
      return res.status(404).json({ 
        success: false, 
        message: 'Pipeline not found' 
      });
    }

    // If pipeline was never run
    if (!pipeline.lastPipelineId || !pipeline.ciCd?.integrationId) {
      return res.json({
        success: true,
        data: {
          status: pipeline.status || 'not_run',
          stages: [],
          lastRun: pipeline.lastRun
        }
      });
    }

    const integration = await CICDIntegration.findById(pipeline.ciCd.integrationId);
    if (!integration) {
      return res.status(400).json({
        success: false,
        message: 'Linked integration not found'
      });
    }

        let decryptedToken;
        try {
            decryptedToken = decrypt(integration.credentials.accessToken);
        } catch (decryptError) {
            return res.status(500).json({ success: false, message: 'Failed to decrypt access token', error: decryptError.message });
        }

        const repoUrl = pipeline.gitRepoUrl.replace(/\.git$/, '');
        const projectPath = repoUrl.replace('https://gitlab.com/', '');
        const encodedProjectPath = encodeURIComponent(projectPath);
        const statusApiUrl = `${integration.url}/api/v4/projects/${encodedProjectPath}/pipelines/${pipeline.lastPipelineId}`;

        const response = await axios.get(statusApiUrl, {
            headers: {
                'PRIVATE-TOKEN': decryptedToken
            },
            timeout: 10000
        });

        const gitlabStatus = response.data.status;
        let appStatus;
        let errorDetails = null;

        switch (gitlabStatus) {
            case 'running':
            case 'pending':
                appStatus = 'running';
                break;
            case 'success':
                appStatus = 'success';
                break;
            case 'failed':
            case 'canceled':
            case 'skipped':
                appStatus = 'failed';
                // Fetch job logs for error details
                const jobsResponse = await axios.get(
                    `${integration.url}/api/v4/projects/${encodedProjectPath}/pipelines/${pipeline.lastPipelineId}/jobs`,
                    { headers: { 'PRIVATE-TOKEN': decryptedToken } }
                );
                const failedJob = jobsResponse.data.find(job => job.status === 'failed');
                if (failedJob) {
                    errorDetails = {
                        jobName: failedJob.name,
                        stage: failedJob.stage,
                        errorMessage: failedJob.failure_reason || 'Unknown error'
                    };
                }
                break;
            default:
                appStatus = 'unknown';
        }

        await Pipeline.updateOne(
            { _id: id },
            { 
                status: appStatus,
                lastRun: new Date()
            }
        );

        res.json({
            success: true,
            data: {
                status: appStatus,
                gitlabStatus: gitlabStatus,
                webUrl: response.data.web_url,
                pipelineId: pipeline.lastPipelineId,
                errorDetails: errorDetails
            }
        });
    } catch (error) {
        console.error('Get pipeline status error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get pipeline status',
            error: error.message
        });
    }
};

exports.updatePipelineStatus = async (req, res) => {
  try {
      const { pipelineId } = req.params;
      const { status } = req.body;

      const pipeline = await Pipeline.findByIdAndUpdate(
          pipelineId,
          { 
              status,
              lastRun: new Date()
          },
          { new: true }
      );

      if (!pipeline) {
          return res.status(404).json({
              success: false,
              message: 'Pipeline not found'
          });
      }

      res.json({
          success: true,
          data: pipeline
      });
  } catch (error) {
      res.status(500).json({
          success: false,
          message: 'Failed to update pipeline status',
          error: error.message
      });
  }
};


exports.getPipelineVariables = async (req, res) => {
  try {
      const { templateId } = req.params;
      const template = pipelineTemplates[templateId];
      
      if (!template) {
          return res.status(404).json({ 
              success: false, 
              message: 'Template not found' 
          });
      }

      // Extract variables from template
      const variables = [];
      const jenkinsContent = template.jenkins('').toString();
      const gitlabContent = template.gitlab.toString();
      
      // Regex to find variables like ${VAR_NAME} or $VAR_NAME
      const varRegex = /\${?([A-Z0-9_]+)}?/g;
      
      let match;
      const foundVars = new Set();
      
      while ((match = varRegex.exec(jenkinsContent + gitlabContent)) !== null) {
          foundVars.add(match[1]);
      }
      
      // Convert to array of variable objects
      foundVars.forEach(v => {
          variables.push({
              name: v,
              description: `Value for ${v}`,
              defaultValue: '',
              required: true
          });
      });

      res.json({ success: true, data: variables });
  } catch (error) {
      res.status(500).json({
          success: false,
          message: 'Failed to extract variables',
          error: error.message
      });
  }
};

exports.getPipelineStats = async (req, res) => {
    try {
        const pipelines = await Pipeline.find().lean();

        // Calculate time-based data for charts
        const now = new Date();
        const last7Days = Array(7).fill(0).map((_, i) => {
            const date = new Date(now);
            date.setDate(date.getDate() - (6 - i));
            return date;
        });
        
        const stats = {
            totalPipelines: pipelines.length,
            byType: {
                jenkins: pipelines.filter(p => p.ciCd?.type === 'jenkins').length,
                gitlab: pipelines.filter(p => p.ciCd?.type === 'gitlab').length
            },
            byStatus: {
                success: pipelines.filter(p => p.status === 'success').length,
                failed: pipelines.filter(p => p.status === 'failed').length,
                running: pipelines.filter(p => p.status === 'running').length,
                created: pipelines.filter(p => p.status === 'created').length
            },
            avgDuration: {
                jenkins: 0,
                gitlab: 0
            },
            activity: {
                last7Days: Array(7).fill(0),
                byHour: Array(24).fill(0)
            }
        };

        let jenkinsDurations = [];
        let gitlabDurations = [];

        // Calculate durations and activity
        pipelines.forEach(pipeline => {
            if (pipeline.lastRunDuration && pipeline.lastRunDuration > 0) {
                if (pipeline.ciCd?.type === 'jenkins') {
                    jenkinsDurations.push(pipeline.lastRunDuration);
                } else if (pipeline.ciCd?.type === 'gitlab') {
                    gitlabDurations.push(pipeline.lastRunDuration);
                }
            }

            if (pipeline.lastRun) {
                const runDate = new Date(pipeline.lastRun);
                
                // Count by day (last 7 days)
                const daysAgo = Math.floor((Date.now() - runDate) / (1000 * 60 * 60 * 24));
                if (daysAgo >= 0 && daysAgo < 7) {
                    stats.activity.last7Days[6 - daysAgo]++;
                }
                
                // Count by hour (last 24 hours)
                const hoursAgo = Math.floor((Date.now() - runDate) / (1000 * 60 * 60));
                if (hoursAgo >= 0 && hoursAgo < 24) {
                    stats.activity.byHour[23 - hoursAgo]++;
                }
            }
        });

        // Calculate average durations
        if (jenkinsDurations.length > 0) {
            stats.avgDuration.jenkins = Math.round(
                jenkinsDurations.reduce((a, b) => a + b, 0) / jenkinsDurations.length
            );
        }

        if (gitlabDurations.length > 0) {
            stats.avgDuration.gitlab = Math.round(
                gitlabDurations.reduce((a, b) => a + b, 0) / gitlabDurations.length
            );
        }

        res.json({ success: true, data: stats });
    } catch (error) {
        console.error('Pipeline stats error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to calculate statistics',
            error: error.message
        });
    }
};

exports.triggerPipeline = async (req, res) => {
  try {
    const { deploymentName, namespace } = req.params;
    
    // Get deployment with CI/CD info
    const deployment = await KubernetesDeployment.findOne({ 
      name: deploymentName, 
      namespace 
    }).populate('ciCd.integrationId');
    
    if (!deployment || !deployment.ciCd) {
      return res.status(404).json({
        success: false,
        message: 'No CI/CD pipeline found for this deployment'
      });
    }
    
    const { ciCd } = deployment;
    let result;
    
    if (ciCd.type === 'jenkins') {
      // Trigger Jenkins build
      const response = await jenkinsApi.post(
        `${ciCd.integrationId.url}/job/${ciCd.name}/build`,
        '',
        ciCd.integrationId.credentials.username,
        ciCd.integrationId.credentials.apiToken
      );
      
      result = {
        message: 'Jenkins build triggered successfully',
        queueUrl: response.headers.location
      };
    } else if (ciCd.type === 'gitlab') {
      // Trigger GitLab pipeline
      const response = await gitlabApi.request(
        'post',
        `${ciCd.integrationId.url}/api/v4/projects/${ciCd.integrationId.projectId}/pipeline?ref=${ciCd.branch}`,
        ciCd.integrationId.credentials.accessToken
      );
      
      result = {
        message: 'GitLab pipeline triggered successfully',
        pipelineId: response.data.id,
        webUrl: response.data.web_url
      };
    }
    
    res.json({
      success: true,
      data: result
    });
    
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to trigger pipeline',
      error: error.message
    });
  }
};


// Get all pipelines
exports.getAllPipelines = async (req, res) => {
  try {
    const pipelines = await Pipeline.find()
      .populate('ciCd.integrationId')
      .sort({ createdAt: -1 });

    res.json({
      success: true,
      data: pipelines.map(pipeline => ({
        id: pipeline._id,
        name: pipeline.name,
        type: pipeline.ciCd?.type,
        repoUrl: pipeline.gitRepoUrl,
        branch: pipeline.branch,
        status: pipeline.status,
        lastRun: pipeline.lastRun,
        createdAt: pipeline.createdAt
      }))
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to fetch pipelines',
      error: error.message
    });
  }
};


exports.getIntegrations = async (req, res) => {
  try {
    // Get all active CI/CD integrations
    const integrations = await CICDIntegration.find({ status: 'connected' })
      .sort({ createdAt: -1 })
      .lean();

    // Decrypt sensitive information for the frontend
    const sanitizedIntegrations = integrations.map(integration => {
      const baseData = {
        _id: integration._id,
        type: integration.type,
        url: integration.url,
        status: integration.status,
        version: integration.version,
        createdAt: integration.createdAt,
        lastTested: integration.lastTested
      };

      // Type-specific fields
      if (integration.type === 'gitlab') {
        return {
          ...baseData,
          projectId: integration.projectId,
          projectName: integration.projectName
        };
      } else if (integration.type === 'jenkins') {
        return {
          ...baseData,
          username: integration.credentials.username
        };
      }

      return baseData;
    });

    res.json({
      success: true,
      data: sanitizedIntegrations
    });

  } catch (error) {
    logger.error(`Failed to fetch integrations: ${error.message}`, { error });
    res.status(500).json({
      success: false,
      message: 'Failed to fetch integrations',
      error: error.message
    });
  }
};

exports.disconnectIntegration = async (req, res) => {
  try {
    const { integrationId } = req.params;

    // Check if any pipelines are using this integration
    const dependentPipelines = await KubernetesDeployment.countDocuments({
      'ciCd.integrationId': integrationId
    });

    if (dependentPipelines > 0) {
      return res.status(400).json({
        success: false,
        message: 'Cannot disconnect integration with active pipelines',
        count: dependentPipelines
      });
    }

    // Mark as disconnected rather than deleting to maintain history
    const integration = await CICDIntegration.findByIdAndUpdate(
      integrationId,
      { status: 'disconnected', disconnectedAt: new Date() },
      { new: true }
    );

    if (!integration) {
      return res.status(404).json({
        success: false,
        message: 'Integration not found'
      });
    }

    res.json({
      success: true,
      message: 'Integration disconnected successfully',
      data: {
        id: integration._id,
        type: integration.type,
        url: integration.url
      }
    });

  } catch (error) {
    logger.error(`Failed to disconnect integration: ${error.message}`, { error });
    res.status(500).json({
      success: false,
      message: 'Failed to disconnect integration',
      error: error.message
    });
  }
};
exports.getPipelineDetails = async (req, res) => {
    try {
        const { id } = req.params;
        const pipeline = await Pipeline.findById(id).populate('ciCd.integrationId');
        if (!pipeline) {
            return res.status(404).json({
                success: false,
                message: 'Pipeline not found'
            });
        }
        res.json({
            success: true,
            data: {
                id: pipeline._id, 
                name: pipeline.name,
                gitRepoUrl: pipeline.gitRepoUrl,
                branch: pipeline.branch,
                status: pipeline.status,
                lastRun: pipeline.lastRun,
                jenkinsfile: pipeline.jenkinsfile,
                gitlabCi: pipeline.gitlabCi,
                ciCd: pipeline.ciCd
            }
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Failed to fetch pipeline details',
            error: error.message
        });
    }
};

exports.deletePipeline = async (req, res) => {
    try {
        const { id } = req.params;
        console.log('Deleting pipeline with ID:', id); 
        const pipeline = await Pipeline.findByIdAndDelete(id);
        if (!pipeline) {
            return res.status(404).json({
                success: false,
                message: 'Pipeline not found'
            });
        }
        res.json({ success: true, message: 'Pipeline deleted successfully' });
    } catch (error) {
        console.error('Error deleting pipeline:', error); 
        res.status(500).json({
            success: false,
            message: 'Failed to delete pipeline',
            error: error.message
        });
    }
};



exports.handleWebhook = async (req, res) => {
    try {
        const { headers, body } = req;
        const eventType = headers['x-gitlab-event'] || headers['x-jenkins-event'];
        
        // Find the pipeline that matches this webhook
        const pipeline = await Pipeline.findOne({
            'ciCd.webhook.url': req.originalUrl,
            'ciCd.webhook.active': true
        });
        
        if (!pipeline) {
            return res.status(404).json({ success: false, message: 'Pipeline not found' });
        }
        
        // Process the webhook based on type
        if (eventType === 'Pipeline Hook') {
            const { object_attributes: pipelineData } = body;
            
            // Update pipeline status
            pipeline.status = pipelineData.status;
            pipeline.stages = pipelineData.stages.map(stage => ({
                name: stage.name,
                status: stage.status,
                duration: stage.duration
            }));
            
            if (pipelineData.status === 'failed') {
                pipeline.errorDetails = {
                    stage: pipelineData.failure_reason,
                    jobName: 'unknown',
                    errorMessage: 'Pipeline failed'
                };
            }
            
            await pipeline.save();
            
            // Broadcast update
            const { broadcastCICDEvent, CICD_EVENT_TYPES } = require('../app');
            broadcastCICDEvent(pipeline._id, {
                type: CICD_EVENT_TYPES.PIPELINE_STATUS,
                status: pipeline.status,
                stages: pipeline.stages,
                errorDetails: pipeline.errorDetails
            });
        }
        
        res.json({ success: true });
    } catch (error) {
        console.error('Webhook processing error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
};



exports.analyzeRepository = async (req, res) => {
  try {
    const { repoUrl, branch } = req.query;
    
    if (!repoUrl) {
      return res.status(400).json({ 
        success: false, 
        message: 'Repository URL is required' 
      });
    }

    const integration = await CICDIntegration.findOne({ 
      type: 'gitlab', 
      status: 'connected' 
    });
    
    if (!integration) {
      return res.status(400).json({ 
        success: false, 
        message: 'No GitLab integration found' 
      });
    }

    const decryptedToken = decrypt(integration.credentials.accessToken);
    const repoPath = new URL(repoUrl).pathname.replace(/^\//, '').replace(/\.git$/, '');
    const projectPath = encodeURIComponent(repoPath);

    // Get repository file structure
    const treeResponse = await axios.get(
      `${integration.url}/api/v4/projects/${projectPath}/repository/tree`,
      {
        headers: { 'PRIVATE-TOKEN': decryptedToken },
        params: { recursive: true, ref: branch || 'main' }
      }
    );

    // Analyze files
    const files = treeResponse.data;
    const fileAnalysis = {
      hasDockerfile: files.some(f => f.name.toLowerCase() === 'dockerfile'),
      hasPackageJson: files.some(f => f.name.toLowerCase() === 'package.json'),
      hasRequirementsTxt: files.some(f => f.name.toLowerCase() === 'requirements.txt'),
      hasPomXml: files.some(f => f.name.toLowerCase() === 'pom.xml'),
      hasGoMod: files.some(f => f.name.toLowerCase() === 'go.mod'),
      hasMakefile: files.some(f => f.name.toLowerCase() === 'makefile'),
      language: 'unknown'
    };

    // Determine language
    if (fileAnalysis.hasPackageJson) fileAnalysis.language = 'javascript';
    if (fileAnalysis.hasRequirementsTxt) fileAnalysis.language = 'python';
    if (fileAnalysis.hasPomXml) fileAnalysis.language = 'java';
    if (fileAnalysis.hasGoMod) fileAnalysis.language = 'go';

    res.json({
      success: true,
      data: {
        fileAnalysis,
        suggestions: await generatePipelineSuggestions(fileAnalysis, {})
      }
    });
  } catch (error) {
    console.error('Repository analysis error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to analyze repository',
      error: error.message
    });
  }
};
exports.getRepositoryAnalysis = async (req, res) => {
    try {
        const { pipelineId } = req.params;
        const { repoUrl, branch } = req.query;

        // Get pipeline details
       if (pipelineId) {
      const pipeline = await Pipeline.findById(pipelineId).populate('ciCd.integrationId');
      if (!pipeline) {
        return res.status(404).json({ success: false, message: 'Pipeline not found' });
      }
    }
        if (pipeline.ciCd.type !== 'gitlab') {
            return res.status(400).json({ 
                success: false, 
                message: 'AI suggestions only available for GitLab pipelines' 
            });
        }

        const integration = pipeline.ciCd.integrationId;
        const decryptedToken = decrypt(integration.credentials.accessToken);
        const projectPath = encodeURIComponent(repoUrl.pathname.replace(/^\//, '').replace(/\.git$/, ''));

        // 1. Get repository file structure
        const treeResponse = await axios.get(
            `${integration.url}/api/v4/projects/${projectPath}/repository/tree`,
            {
                headers: { 'PRIVATE-TOKEN': decryptedToken },
                params: { recursive: true }
            }
        );

        // 2. Identify key files 
        const files = treeResponse.data;
        const fileAnalysis = {
            hasDockerfile: files.some(f => f.name.toLowerCase() === 'dockerfile'),
            hasPackageJson: files.some(f => f.name.toLowerCase() === 'package.json'),
            hasRequirementsTxt: files.some(f => f.name.toLowerCase() === 'requirements.txt'),
            hasPomXml: files.some(f => f.name.toLowerCase() === 'pom.xml'),
            hasGoMod: files.some(f => f.name.toLowerCase() === 'go.mod'),
            hasMakefile: files.some(f => f.name.toLowerCase() === 'makefile'),
            language: 'unknown'
        };

        // 3. Determine primary language
        if (fileAnalysis.hasPackageJson) fileAnalysis.language = 'javascript';
        if (fileAnalysis.hasRequirementsTxt) fileAnalysis.language = 'python';
        if (fileAnalysis.hasPomXml) fileAnalysis.language = 'java';
        if (fileAnalysis.hasGoMod) fileAnalysis.language = 'go';

        // 4. Get content of key files for more detailed analysis
        const fileContents = {};
        const filesToCheck = ['Dockerfile', 'package.json', 'requirements.txt', 'pom.xml'];
        
        for (const file of filesToCheck) {
            const fileExists = files.some(f => f.name === file);
            if (fileExists) {
                try {
                    const contentResponse = await axios.get(
                        `${integration.url}/api/v4/projects/${projectPath}/repository/files/${encodeURIComponent(file)}/raw`,
                        {
                            headers: { 'PRIVATE-TOKEN': decryptedToken },
                            params: { ref: pipeline.branch || 'main' }
                        }
                    );
                    fileContents[file] = contentResponse.data;
                } catch (error) {
                    console.error(`Error fetching ${file}:`, error.message);
                }
            }
        }

        res.json({
            success: true,
            data: {
                fileAnalysis,
                fileContents,
                suggestions: await generatePipelineSuggestions(fileAnalysis, fileContents)
            }
        });
    } catch (error) {
        console.error('Repository analysis error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to analyze repository',
            error: error.message
        });
    }
};

async function generatePipelineSuggestions(fileAnalysis, fileContents) {
    // Prepare prompt for LLM
    let prompt = `[INST]You are a CI/CD pipeline expert. Analyze this repository and suggest appropriate pipeline configurations.

Repository Analysis:
- Language: ${fileAnalysis.language}
- Has Dockerfile: ${fileAnalysis.hasDockerfile}
- Key files present: ${Object.keys(fileContents).join(', ')}

Based on this information, provide the most suitable pipeline configuration suggestions for GitLab CI/CD (.gitlab-ci.yml). 
the suggestion should include:
1. A brief description of when to use it
2. The complete YAML pipeline code 
3. Any important notes about the configuration

Format your response as markdown with clear section headings.[/INST]`;

    // Add file contents to prompt if available
    if (fileContents['Dockerfile']) {
        prompt += `\n\nDockerfile content:\n\`\`\`\n${fileContents['Dockerfile'].substring(0, 1000)}\n\`\`\``;
    }
    if (fileContents['package.json']) {
        prompt += `\n\npackage.json content:\n\`\`\`json\n${fileContents['package.json'].substring(0, 1000)}\n\`\`\``;
    }
    if (fileAnalysis.hasRequirementsTxt) {
        prompt += "\n\nAdditional Context: This is a Python project (requirements.txt found)";
    }

    // Call Mistral LLM
    try {
        const response = await axios.post('http://localhost:11434/api/generate', {
            model: 'mistral:7b-instruct-q2_K',
            prompt: prompt,
            stream: false,
            max_tokens: 1500,
            temperature: 0.3
        }, { 
            headers: { 'Content-Type': 'application/json' },
            timeout: 300000 
        });

        return response.data.response || "No suggestions generated";
    } catch (error) {
        console.error('LLM suggestion error:', error);
        return "Failed to generate suggestions";
    }
}