const Docker = require('dockerode');
const DockerFile = require('../models/dockerfilee');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const user = require('../models/User');
const upload = require('../middleware/fileUpload');
const { v4: uuidv4 } = require('uuid');


const Image = require('../models/Image'); 
const docker = new Docker({ socketPath: '/var/run/docker.sock' });



const dockerfilePath = path.join(__dirname, 'Dockerfile');




exports.uploadBuildContextFiles = async (req, res) => {
    try {
        const { dockerfileId } = req.params;
        const files = req.files; 
        
        // Verify Dockerfile ownership
        const dockerFile = await verifyOwnership(dockerfileId, req.session.user._id);
        
        const buildContextFiles = files.map(file => {
            return {
                originalName: file.originalname,
                path: file.path, 
                size: file.size,
                uploadDate: new Date()
            };
        });

        // Update Dockerfile with build context files
        dockerFile.buildContextFiles = buildContextFiles;
        await dockerFile.save();

        res.status(200).json({
            success: true,
            message: 'Files uploaded successfully',
            files: buildContextFiles.map(f => f.originalName)
        });
    } catch (error) {
        console.error('Error uploading build context files:', error);
        res.status(500).json({
            success: false,
            message: 'Error uploading files',
            error: error.message
        });
    }
};

exports.getBuildContextFiles = async (req, res) => {
    try {
        const dockerFile = await verifyOwnership(req.params.dockerfileId, req.session.user._id);
        
        res.status(200).json({
            success: true,
            files: dockerFile.buildContextFiles || []
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Error fetching build context files',
            error: error.message
        });
    }
};

exports.deleteBuildContextFile = async (req, res) => {
    try {
        const { dockerfileId, filename } = req.params;
        const dockerFile = await verifyOwnership(dockerfileId, req.session.user._id);
        
        // Find and remove the file
        const fileIndex = dockerFile.buildContextFiles.findIndex(f => f.originalName === filename);
        if (fileIndex === -1) {
            return res.status(404).json({
                success: false,
                message: 'File not found'
            });
        }
        
        // Remove physical file
        const fileToDelete = dockerFile.buildContextFiles[fileIndex];
        fs.unlinkSync(fileToDelete.path);
        
       
        dockerFile.buildContextFiles.splice(fileIndex, 1);
        await dockerFile.save();
        
        res.status(200).json({
            success: true,
            message: 'File deleted successfully'
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Error deleting file',
            error: error.message
        });
    }
};

const verifyOwnership = async (dockerfileId, userId) => {
    const dockerFile = await DockerFile.findOne({ _id: dockerfileId, userId });
    if (!dockerFile) throw new Error('Dockerfile not found or access denied');
    return dockerFile;
};

exports.generateDockerfile = async (req, res) => {
    const dockerFile = await verifyOwnership(req.params.id, req.session.user._id);
    const dockerFileId = req.params.id;
    
    try {
      const dockerFile = await DockerFile.findById(dockerFileId);
      if (!dockerFile) {
        return res.status(404).json({ message: 'Dockerfile not found' });
      }
  
      const dockerfileContent = dockerFile.lines.join('\n');
  
      const filePath = path.join(__dirname,'..', 'Dockerfile');
      fs.writeFileSync(filePath, dockerfileContent);
  
      res.json({ message: 'Dockerfile generated successfully!' });
    } catch (error) {
      console.error('Error generating Dockerfile:', error);
      res.status(500).json({ message: 'Error generating Dockerfile' });
    }
  };


  
  

exports.buildDockerImage = async (req, res) => {
    try {
        const { dockerfileId, imageName, tags, includeAllFiles } = req.body;
        const userId = req.session.user._id;

        // Verify ownership and get Dockerfile
        const dockerFile = await verifyOwnership(dockerfileId, userId);
        
        if (!dockerFile) {
            return res.status(404).json({ type: 'error', message: 'Dockerfile not found' });
        }

        // Create temporary build directory with unique name
        const buildDir = path.join(__dirname, '../temp-builds', `build-${Date.now()}`);
        fs.mkdirSync(buildDir, { recursive: true });

        try {
            // Write Dockerfile to build directory
            const dockerfilePath = path.join(buildDir, 'Dockerfile');
            fs.writeFileSync(dockerfilePath, dockerFile.content || dockerFile.lines.join('\n'));

            // Copy build context files if they exist and includeAllFiles is true
            if (includeAllFiles && dockerFile.buildContextFiles && dockerFile.buildContextFiles.length > 0) {
                for (const file of dockerFile.buildContextFiles) {
                    // Verify the file path exists
                    if (!file.path || !fs.existsSync(file.path)) {
                        console.warn(`Skipping file ${file.originalName} - path not found`);
                        continue;
                    }

                    const destPath = path.join(buildDir, file.originalName);
                    
                    const destDir = path.dirname(destPath);
                    if (!fs.existsSync(destDir)) {
                        fs.mkdirSync(destDir, { recursive: true });
                    }
                    
                    fs.copyFileSync(file.path, destPath);
                }
            }

            // Build the image
            const tar = require('tar-fs').pack(buildDir);
            const stream = await docker.buildImage(tar, { 
                t: imageName,
                dockerfile: 'Dockerfile'
            });

            let imageId;
            let errorMessage = '';
            let detailedErrors = [];

            stream.on('data', data => {
                const output = data.toString();
                console.log('Build output:', output);

                if (output.includes('errorDetail')) {
                    try {
                        const errorDetail = JSON.parse(output);
                        errorMessage = errorDetail.errorDetail.message;
                        detailedErrors.push(errorMessage);
                    } catch (e) {
                        console.error('Error parsing build output:', e);
                    }
                }

                // Extract image ID if build is successful
                const matches = output.match(/Successfully built ([a-f0-9]+)/);
                if (matches) {
                    imageId = matches[1];
                }
            });

            return new Promise((resolve) => {
                stream.on('end', async () => {
                    try {
                        // Clean up build directory
                        fs.rmSync(buildDir, { recursive: true, force: true });
                    } catch (cleanupError) {
                        console.error('Error cleaning up build directory:', cleanupError);
                    }

                    if (errorMessage) {
                        const suggestions = await getAISuggestions(errorMessage);
                        res.status(500).json({
                            type: 'error',
                            message: 'Error building Docker image',
                            errors: detailedErrors,
                            suggestions: suggestions
                        });
                        resolve();
                        return;
                    }

                    if (imageId) {
                        try {
                            const newImage = new Image({
                                name: imageName,
                                imageId: imageId,
                                dockerfileId: dockerFile._id,
                                dockerfileContent: dockerFile.content || dockerFile.lines.join('\n'),
                                tags: tags || [],
                                dateOfCreation: new Date(),
                                userId: userId
                            });

                            await newImage.save();
                            res.status(201).json({ type: 'success', message: 'Docker image built and saved successfully' });
                        } catch (dbError) {
                            console.error('Error saving Docker image to database:', dbError);
                            res.status(500).json({ type: 'error', message: 'Docker image built but error saving to database' });
                        }
                    } else {
                        console.error('Image ID not found in build output');
                        res.status(500).json({ type: 'error', message: 'Error! Docker image built but Image ID not found' });
                    }
                    resolve();
                });

                stream.on('error', error => {
                    console.error('Error during Docker image build:', error);
                    try {
                        fs.rmSync(buildDir, { recursive: true, force: true });
                    } catch (cleanupError) {
                        console.error('Error cleaning up build directory:', cleanupError);
                    }
                    res.status(500).json({ type: 'error', message: 'Error building Docker image' });
                    resolve();
                });
            });

        } catch (error) {
            // Clean up build directory if error occurs
            try {
                fs.rmSync(buildDir, { recursive: true, force: true });
            } catch (cleanupError) {
                console.error('Error cleaning up build directory:', cleanupError);
            }
            console.error('Build error:', error);
            res.status(500).json({ 
                type: 'error', 
                message: 'An error occurred during the image build process',
                error: error.message
            });
        }
    } catch (error) {
        console.error('Error in buildDockerImage:', error);
        res.status(500).json({ 
            type: 'error', 
            message: 'An error occurred while processing the build request',
            error: error.message
        });
    }
};
  
  // Function to call mistral for suggestions
  async function getAISuggestions(errorMessage) {
      try {
          const response = await axios.post('http://localhost:11434/api/generate', {
              model: 'mistral:7b-instruct-q2_K',
              prompt: `
[INST]You are a Docker expert. The following error occurred while building a Docker image:                  \`\`\`
                  ${errorMessage}
                  \`\`\`
Provide 2-3 short and concise suggestions to fix the issue. Each suggestion should be one sentence.[/INST]              `,
              stream: false, 
              max_tokens: 150 ,
              temperature: 0.3
          }, { headers: { 'Content-Type': 'application/json' } });
  
          if (response.status !== 200 || !response.data) {
              console.error('Unexpected Mistral API Response:', response);
              return ['Failed to generate suggestions. Please check the error message manually.'];
          }
  
          // Extract the suggestions from the response
          const suggestions = response.data.response.split('\n')
            .filter(line => line.trim() !== '')
            .map(line => line.replace(/^- /, '').trim()); 
        return suggestions;
      } catch (error) {
          console.error('Error calling Mistral:', error);
          return ['Failed to generate suggestions. Please check the error message manually.'];
      }
  }



    


      





const { logError, logInfo } = require('../utils/logger');

// Validate Dockerfile content
const validateDockerfile = (content) => {
    if (!content) {
        return ['Dockerfile content is missing.']; 
    }

    const errors = [];
    const lines = content.split('\n');

     let hasFrom = false;

    lines.forEach((line, index) => {
        const trimmedLine = line.trim();

        // Skip empty lines and comments
        if (!trimmedLine || trimmedLine.startsWith('#')) {
            return;
        }

        // Check for incomplete FROM command
        if (trimmedLine.startsWith('FROM')) {
            hasFrom = true;
            if (trimmedLine.split(' ').length < 2) {
                errors.push(`Line ${index + 1}: Incomplete FROM command. Please specify a base image.`);
            }
        }

        // Ensure there is at least one FROM statement
        if (index === lines.length - 1 && !hasFrom) {
            errors.push('Missing FROM statement. A Dockerfile must start with a base image.');
        }

        // Check for incomplete RUN command
        if (trimmedLine.startsWith('RUN') && trimmedLine.split(' ').length < 2) {
            errors.push(`Line ${index + 1}: Incomplete RUN command. Please specify a command to run.`);
        }

        // Check for incomplete CMD command
        if (trimmedLine.startsWith('CMD') && !trimmedLine.includes('[')) {
            errors.push(`Line ${index + 1}: CMD should use JSON format: CMD ["executable", "arg1", "arg2"]`);
        }

        // Check for incomplete ENTRYPOINT command
        if (trimmedLine.startsWith('ENTRYPOINT') && !trimmedLine.includes('[')) {
            errors.push(`Line ${index + 1}: ENTRYPOINT should use JSON format: ENTRYPOINT ["executable", "arg1", "arg2"]`);
        }

        // Check for COPY and ADD without specifying source and destination
        if ((trimmedLine.startsWith('COPY') || trimmedLine.startsWith('ADD')) && trimmedLine.split(' ').length < 3) {
            errors.push(`Line ${index + 1}: Incomplete ${trimmedLine.split(' ')[0]} command. Specify source and destination.`);
        }

        // Check for EXPOSE command with valid port
        if (trimmedLine.startsWith('EXPOSE')) {
            const parts = trimmedLine.split(' ');
            if (parts.length < 2 || isNaN(parts[1])) {
                errors.push(`Line ${index + 1}: Invalid EXPOSE command. Specify a valid port number.`);
            }
        }

        // Check for WORKDIR without a specified path
        if (trimmedLine.startsWith('WORKDIR') && trimmedLine.split(' ').length < 2) {
            errors.push(`Line ${index + 1}: Incomplete WORKDIR command. Specify a working directory.`);
        }

        // Check for ENV without key-value pair
        if (trimmedLine.startsWith('ENV') && trimmedLine.split(' ').length < 3) {
            errors.push(`Line ${index + 1}: Incomplete ENV command. Use format: ENV KEY VALUE.`);
        }

        // Check for invalid format in ARG
        if (trimmedLine.startsWith('ARG') && trimmedLine.split(' ').length < 2) {
            errors.push(`Line ${index + 1}: Incomplete ARG command. Use format: ARG NAME[=VALUE].`);
        }

        // Check for invalid SHELL usage
        if (trimmedLine.startsWith('SHELL') && !trimmedLine.includes('[')) {
            errors.push(`Line ${index + 1}: SHELL should use JSON format: SHELL ["executable", "arg1"]`);
        }
    });

    return errors;
};

// Save Dockerfile with validation
exports.createDockerFile = async (req, res) => {
    const { name, content, tempId } = req.body;

    if (!req.session?.user?._id) {
        return res.status(401).json({ 
            success: false, 
            message: 'Unauthorized: User not logged in' 
        });
    }

    const validationErrors = validateDockerfile(content);
    const status = validationErrors.length > 0 ? 'invalid' : 'valid';

    try {
        // Create upload directory if it doesn't exist
        const uploadDir = path.join(__dirname, '../uploads/build-context');
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }

        const dockerFile = await DockerFile.create({
            name,
            content,
            status,
            userId: req.session.user._id,
            errors: validationErrors,
            buildContextFiles: []
        });

        if (tempId && tempFiles.has(tempId)) {
            const files = tempFiles.get(tempId);
            const buildContextFiles = await Promise.all(files.map(async file => {
                const uniqueName = `${uuidv4()}-${file.originalName}`;
                const filePath = path.join(uploadDir, uniqueName);
                await fs.promises.writeFile(filePath, file.buffer);
                return {
                    originalName: file.originalName,
                    storedName: uniqueName,
                    size: file.size
                };
            }));

            dockerFile.buildContextFiles = buildContextFiles;
            await dockerFile.save();
            tempFiles.delete(tempId);
        }

        res.status(201).json({ success: true, dockerFile });
    } catch (error) {
        console.error('Error saving Dockerfile:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Failed to save Dockerfile', 
            error: error.message 
        });
    }
};

exports.getAllDockerFiles = async (req, res) => {
    try {
        const dockerFiles = await DockerFile.find({ userId: req.session.user._id });
        res.send(dockerFiles);
    } catch (err) {
        logError(`Error fetching Dockerfiles: ${err.message}`);
        res.status(500).send({ message: err.message });
    }
};

exports.getDockerFileById = (req, res) => {
    DockerFile.findById(req.params.id)
        .then(dockerFile => {
            if (!dockerFile) {
                return res.status(404).send({
                    message: "Docker file not found with id " + req.params.id
                });
            }
            res.send(dockerFile);
        })
        .catch(err => {
            if (err.kind === 'ObjectId') {
                return res.status(404).send({
                    message: "Docker file not found with id " + req.params.id
                });
            }
            return res.status(500).send({
                message: "Error retrieving Docker file with id " + req.params.id
            });
        });
};

exports.updateDockerFile = async (req, res) => {
    const { name, content } = req.body;
    
    try {
        const validationErrors = validateDockerfile(content);
        const status = validationErrors.length > 0 ? 'invalid' : 'valid';

        const dockerFile = await DockerFile.findOneAndUpdate(
            { _id: req.params.id, userId: req.session.user._id },
            { name, content, status, errors: validationErrors },
            { new: true }
        );

        if (!dockerFile) throw new Error('Dockerfile not found or access denied');
        res.send(dockerFile);
    } catch (error) {
        res.status(404).send({ message: error.message });
    }
};

exports.deleteDockerFile = async (req, res) => {
    try {
        const dockerFile = await DockerFile.findOneAndDelete({
            _id: req.params.id,
            userId: req.session.user._id
        });
        if (!dockerFile) throw new Error('Dockerfile not found or access denied');
        res.send({ message: "Docker file deleted successfully!" });
    } catch (error) {
        res.status(404).send({ message: error.message });
    }
};

exports.addLineToDockerFile = (req, res) => {
    DockerFile.findById(req.params.id)
        .then(dockerFile => {
            if (!dockerFile) {
                return res.status(404).send({
                    message: "Docker file not found with id " + req.params.id
                });
            }
            dockerFile.lines.push(req.body.line);
            dockerFile.save()
                .then(updatedDockerFile => res.send(updatedDockerFile))
                .catch(err => res.status(500).send({
                    message: err.message || "Some error occurred while adding the line."
                }));
        })
        .catch(err => res.status(500).send({
            message: err.message || "Error retrieving Docker file with id " + req.params.id
        }));
};

exports.deleteLineFromDockerFile = (req, res) => {
    DockerFile.findById(req.params.id)
        .then(dockerFile => {
            if (!dockerFile) {
                return res.status(404).send({
                    message: "Docker file not found with id " + req.params.id
                });
            }
            dockerFile.lines.splice(req.params.lineIndex, 1);
            dockerFile.save()
                .then(updatedDockerFile => res.send(updatedDockerFile))
                .catch(err => res.status(500).send({
                    message: err.message || "Some error occurred while deleting the line."
                }));
        })
        .catch(err => res.status(500).send({
            message: err.message || "Error retrieving Docker file with id " + req.params.id
        }));
};

exports.updateLineInDockerFile = (req, res) => {
    DockerFile.findById(req.params.id)
        .then(dockerFile => {
            if (!dockerFile) {
                return res.status(404).send({
                    message: "Docker file not found with id " + req.params.id
                });
            }
            dockerFile.lines[req.params.lineIndex] = req.body.line;
            dockerFile.save()
                .then(updatedDockerFile => res.send(updatedDockerFile))
                .catch(err => res.status(500).send({
                    message: err.message || "Some error occurred while updating the line."
                }));
        })
        .catch(err => res.status(500).send({
            message: err.message || "Error retrieving Docker file with id " + req.params.id
        }));
};

exports.getLinesFromDockerFile = (req, res) => {
    DockerFile.findById(req.params.id)
        .then(dockerFile => {
            if (!dockerFile) {
                return res.status(404).send({
                    message: "Docker file not found with id " + req.params.id
                });
            }
            res.send(dockerFile.lines);
        })
        .catch(err => res.status(500).send({
            message: err.message || "Error retrieving lines from Docker file with id " + req.params.id
        }));
};


const axios = require('axios');

exports.analyzeDockerfile = async (req, res) => {
    const { content } = req.body;

    try {
        console.log('Dockerfile Content:\n', content);

        // Make API request to Ollama
        const response = await axios.post('http://localhost:11434/api/generate', {
            model: 'mistral:7b-instruct-q2_K',
            prompt: `
                [INST]You are a Docker expert. Analyze the following Dockerfile and suggest optimizations.
                For each suggestion, provide an explanation in Dockerfile comments (using #).
                Then, write the complete optimized Dockerfile code that can be directly applied.
                Here is the Dockerfile:
                \`\`\`
                ${content}
                \`\`\`[/INST]
            `,
            stream: false,  
            max_tokens: 1500,
            temperature: 0.2
        }, { headers: { 'Content-Type': 'application/json' } });

        console.log('Ollama API Response Status:', response.status);

        if (response.status !== 200 || !response.data) {
            console.error('Unexpected Ollama API Response:', response);
            return res.status(500).json({ message: 'Unexpected API response', error: response.data });
        }

        // Handle response from Ollama
        let suggestions = response.data.response || response.data; 
        console.log('Full Response:\n', suggestions);

        res.json({ suggestions });
    } catch (error) {
        console.error('Error analyzing Dockerfile:', error.message);
        res.status(500).json({ message: 'Error analyzing Dockerfile', error: error.message });
    }
};



const templates = {
    node: `FROM node:18\nWORKDIR /app\nCOPY . .\nRUN npm install\nCMD ["node", "server.js"]`,
    python: `FROM python:3.9\nWORKDIR /app\nCOPY . .\nRUN pip install -r requirements.txt\nCMD ["python", "app.py"]`,
    go: `FROM golang:1.19\nWORKDIR /app\nCOPY . .\nRUN go build -o app\nCMD ["./app"]`,
};

exports.getDockerTemplates = (req, res) => {
    res.json(templates);
};


exports.validateDockerfile = async (req, res) => {
    const { content } = req.body;
    
    if (!content) {
        return res.status(400).json({ 
            success: false, 
            message: 'Dockerfile content is required' 
        });
    }

    try {
        // Create a temporary directory for the build context
        const tempDir = path.join(__dirname, '../temp-validate', uuidv4());
        fs.mkdirSync(tempDir, { recursive: true });
        
        // Write Dockerfile to temp directory
        const dockerfilePath = path.join(tempDir, 'Dockerfile');
        fs.writeFileSync(dockerfilePath, content);
        
        // Create a dummy .dockerignore to prevent any context issues
        fs.writeFileSync(path.join(tempDir, '.dockerignore'), '');

        // Try to build the image with --dry-run flag (simulated)
        const stream = await docker.buildImage({
            context: tempDir,
            src: ['Dockerfile', '.dockerignore']
        }, { 
            t: 'dry-run-validation', 
            dockerfile: 'Dockerfile',
            forcerm: true,
            pull: false
        });

        let buildOutput = '';
        let isValid = true;
        let errors = [];

        // Process the build output stream
        return new Promise((resolve) => {
            stream.on('data', (chunk) => {
                const output = chunk.toString();
                buildOutput += output;
                
                // Check for errors in the output
                if (output.includes('errorDetail') || output.includes('ERROR:')) {
                    isValid = false;
                    try {
                        const errorDetail = JSON.parse(output);
                        if (errorDetail.errorDetail) {
                            errors.push(errorDetail.errorDetail.message);
                        }
                    } catch (e) {
                        errors.push(output);
                    }
                }
            });

            stream.on('end', () => {
                // Clean up the temporary directory
                try {
                    fs.rmdirSync(tempDir, { recursive: true });
                } catch (cleanupError) {
                    console.error('Error cleaning up temp directory:', cleanupError);
                }

                if (isValid) {
                    res.status(200).json({ 
                        success: true, 
                        message: 'Dockerfile is valid', 
                        output: buildOutput 
                    });
                } else {
                    res.status(400).json({ 
                        success: false, 
                        message: 'Dockerfile validation failed',
                        errors: errors,
                        output: buildOutput 
                    });
                }
                resolve();
            });

            stream.on('error', (error) => {
                // Clean up the temporary directory
                try {
                    fs.rmdirSync(tempDir, { recursive: true });
                } catch (cleanupError) {
                    console.error('Error cleaning up temp directory:', cleanupError);
                }

                res.status(500).json({ 
                    success: false, 
                    message: 'Error during validation',
                    error: error.message 
                });
                resolve();
            });
        });

    } catch (error) {
        console.error('Validation error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Error validating Dockerfile',
            error: error.message 
        });
    }
};


