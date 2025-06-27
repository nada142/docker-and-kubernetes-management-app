const express = require('express');
const router = express.Router();
const dockerController = require('../controllers/dockerController');
const Dockerfile = require('../models/dockerfilee'); 
const Docker = require('dockerode');
const axios = require("axios");
const fs = require('fs'); 
const path = require('path');
const { ensureAuthenticated } = require('../middleware/authMiddleware'); 

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

router.post('/dockerfilees/:id/generate',ensureAuthenticated, dockerController.generateDockerfile);
router.post('/dockerfilees/build',ensureAuthenticated, dockerController.buildDockerImage);
router.post('/dockerfilees', ensureAuthenticated, dockerController.createDockerFile);
router.get('/dockerfilees', ensureAuthenticated, dockerController.getAllDockerFiles);
router.get('/dockerfilees/:id',ensureAuthenticated, dockerController.getDockerFileById);
router.put('/dockerfilees/:id',ensureAuthenticated, dockerController.updateDockerFile);
router.delete('/dockerfilees/:id', ensureAuthenticated, dockerController.deleteDockerFile);
router.post('/dockerfilees/:id/lines', dockerController.addLineToDockerFile);
router.delete('/dockerfilees/:id/lines/:lineIndex', dockerController.deleteLineFromDockerFile);
router.put('/dockerfilees/:id/lines/:lineIndex', dockerController.updateLineInDockerFile);
router.get('/dockerfilees/:id/lines', dockerController.getLinesFromDockerFile);
router.post('/dockerfilees/analyze',ensureAuthenticated, dockerController.analyzeDockerfile);
router.get('/dockerfilees/templates',ensureAuthenticated, dockerController.getDockerTemplates);
router.post('/dockerfilees/validate', ensureAuthenticated, dockerController.validateDockerfile);

router.get('/count/dockerfiles', ensureAuthenticated, async (req, res) => {
    try {
        const dockerfiles = await Dockerfile.find({ userId: req.session.user._id });
        res.json({ count: dockerfiles.length });
    } catch (error) {
        console.error('Error fetching dockerfile count:', error);
        res.status(500).json({ error: 'Error fetching dockerfile count' });
    }
});
const multer = require('multer');

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadDir = path.join(__dirname, '../uploads/build-context', req.params.dockerfileId);
    fs.mkdirSync(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    cb(null, file.originalname); 
  }
});

const upload = multer({ 
  storage: storage,
  limits: {
    fileSize: 10 * 1024 * 1024, 
    files: 20 
  }
});
router.post('/dockerfilees/:dockerfileId/upload-files', 
    ensureAuthenticated, 
    upload.array('files'), 
    dockerController.uploadBuildContextFiles
);

router.get('/dockerfilees/:dockerfileId/uploaded-files', 
    ensureAuthenticated, 
    dockerController.getBuildContextFiles
);

router.delete('/dockerfilees/:dockerfileId/uploaded-files/:filename', 
    ensureAuthenticated, 
    dockerController.deleteBuildContextFile
);
module.exports = router;
