const { exec } = require('child_process');
const Service = require('../models/Service');
const fs = require('fs');
const path = require('path');
const jsyaml = require('js-yaml');
const Stack = require('../models/Stack');

const Docker = require('dockerode');
const docker = new Docker();
const axios = require('axios');

const verifyStackOwnership = async (stackName, userId) => {
    const stack = await Stack.findOne({ name: stackName, userId });
    if (!stack) throw new Error('Stack not found or access denied');
    return stack;
};


exports.getComposeStats = async (req, res) => {
    try {
        const services = await Service.find();
        
        const stats = {
            running: 0,
            stopped: 0,
            paused: 0,
            error: 0
        };

        services.forEach(service => {
            if (service.status === 'running') stats.running++;
            else if (service.status === 'stopped') stats.stopped++;
            else if (service.status === 'paused') stats.paused++;
            else stats.error++;
        });

        res.json(stats);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};
const executeCommand = (command, res) => {
    exec(command, (error, stdout, stderr) => {
        if (error) {
            return res.status(500).json({ error: stderr });
        }
        res.status(200).json({ message: stdout });
    });
};

// List all services

exports.listServices = async (req, res) => {
    try {
        const services = await Service.find({ userId: req.session.user._id });
        const groupedServices = services.reduce((acc, service) => {
            if (!acc[service.stack]) acc[service.stack] = [];
            acc[service.stack].push(service);
            return acc;
        }, {});
        res.status(200).json(groupedServices);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

exports.getContainers = async (req, res) => {
    const { name } = req.params;
    console.log(`Fetching containers for service: ${name}`); 

    try {
        const service = await Service.findOne({ name });
        if (!service) {
            return res.status(404).json({ error: `Service ${name} not found.` });
        }

        // Return the containers associated with the service
        res.status(200).json(service.containers);
    } catch (error) {
        console.error(`Error in getContainers: ${error.message}`); 
        res.status(500).json({ error: error.message });
    }
};


exports.analyzeCompose = async (req, res) => {
    try {
        const { yaml } = req.body;
        
        // Validate YAML first
        const yamlObj = jsyaml.load(yaml);
        if (!yamlObj?.services) {
            return res.status(400).json({ error: 'Invalid Docker Compose format' });
        }

        // Call mistral
        const response = await axios.post('http://localhost:11434/api/generate', {
            model: 'mistral:7b-instruct-q2_K',
            prompt: `Analyze this Docker Compose file and give me suggestions on how to improve it (in three sentences)\`\`\`
                ${yaml}
                \`\`\`
            `,
            stream: false,
            max_tokens: 300
        });

        if (!response.data) {
            throw new Error('Empty response from AI service');
        }

        res.json({ suggestions: response.data.response });
    } catch (error) {
        console.error('AI Analysis Error:', error);
        res.status(500).json({ 
            error: error.response?.data?.error || error.message 
        });
    }
};
exports.openTerminal = async (req, res) => {
    const { containerId } = req.params;
    console.log(`Opening terminal for container: ${containerId}`);

    try {
        //  docker exec to open a terminal session
        const childProcess = exec(`docker exec -it ${containerId} sh`, (error, stdout, stderr) => {
            if (error) {
                console.error(`Error opening terminal: ${stderr}`); 
                return res.status(500).json({ error: stderr });
            }
            console.log(`Terminal output: ${stdout}`);
            res.status(200).json({ message: 'Terminal session opened.' });
        });

        process.stdin.pipe(childProcess.stdin);
        childProcess.stdout.pipe(process.stdout);
    } catch (error) {
        console.error(`Error in openTerminal: ${error.message}`); 
        res.status(500).json({ error: error.message });
    }
};

// Start a service
exports.startService = async (req, res) => {
    const { name } = req.params;
    console.log(`Starting service: ${name}`); 

    try {
        const service = await Service.findOne({ name });
        if (!service) {
            return res.status(404).json({ error: `Service ${name} not found.` });
        }

        const stack = await Stack.findOne({ name: service.stack });
        if (!stack) {
            return res.status(404).json({ error: `Stack ${service.stack} not found.` });
        }

        // Start the service using docker-compose
        const childProcess = exec(`docker compose -f - up -d`, async (error, stdout, stderr) => {
            if (error) {
                console.error(`Error starting service: ${stderr}`); 
                return res.status(500).json({ error: stderr });
            }
            console.log(`Service started: ${stdout}`); 

            // Update the service status in the database
            await Service.updateOne({ name }, { $set: { status: 'running' } });

            res.status(200).json({ message: stdout });
        });

        childProcess.stdin.write(stack.yamlContent);
        childProcess.stdin.end();
    } catch (error) {
        console.error(`Error in startService: ${error.message}`); 
        res.status(500).json({ error: error.message });
    }
};

// Stop a service

exports.stopService = async (req, res) => {
    const { name } = req.params;
    console.log(`Stopping service: ${name}`); 

    try {
        // Find the service to get the stack name
        const service = await Service.findOne({ name });
        if (!service) {
            return res.status(404).json({ error: `Service ${name} not found.` });
        }

        // Find the stack to get the YAML content
        const stack = await Stack.findOne({ name: service.stack });
        if (!stack) {
            return res.status(404).json({ error: `Stack ${service.stack} not found.` });
        }

        // Stop the service using docker-compose
        const childProcess = exec(`docker compose -f - stop ${name}`, async (error, stdout, stderr) => {
            if (error) {
                console.error(`Error stopping service: ${stderr}`); 
                return res.status(500).json({ error: stderr });
            }
            console.log(`Service stopped: ${stdout}`); 

            // Update the service status in the database
            await Service.updateOne({ name }, { $set: { status: 'stopped' } });

            res.status(200).json({ message: stdout });
        });

        childProcess.stdin.write(stack.yamlContent);
        childProcess.stdin.end();
    } catch (error) {
        console.error(`Error in stopService: ${error.message}`); 
        res.status(500).json({ error: error.message });
    }
};

// Restart a service
exports.restartService = async (req, res) => {
    const { name } = req.params;
    console.log(`Restarting service: ${name}`); 

    try {
        // Find the service to get the stack name
        const service = await Service.findOne({ name });
        if (!service) {
            return res.status(404).json({ error: `Service ${name} not found.` });
        }

        // Find the stack to get the YAML content
        const stack = await Stack.findOne({ name: service.stack });
        if (!stack) {
            return res.status(404).json({ error: `Stack ${service.stack} not found.` });
        }

        // Restart the service using docker-compose
        const childProcess = exec(`docker compose -f - restart ${name}`, async (error, stdout, stderr) => {
            if (error) {
                console.error(`Error restarting service: ${stderr}`); 
                return res.status(500).json({ error: stderr });
            }
            console.log(`Service restarted: ${stdout}`); 

            // Update the service status in the database
            await Service.updateOne({ name }, { $set: { status: 'running' } });

            res.status(200).json({ message: stdout });
        });

        // Pass the YAML content to the docker-compose command
        childProcess.stdin.write(stack.yamlContent);
        childProcess.stdin.end();
    } catch (error) {
        console.error(`Error in restartService: ${error.message}`); 
        res.status(500).json({ error: error.message });
    }
};

// View logs for a service
exports.viewLogs = async (req, res) => {
    const { name } = req.params;
    console.log(`Viewing logs for service: ${name}`);

    try {
        const service = await Service.findOne({ name });
        if (!service) {
            return res.status(404).json({ error: `Service ${name} not found.` });
        }

        // Get logs from Docker 
        const container = docker.getContainer(service.containers[0].id);
        const logs = await container.logs({
            stdout: true,
            stderr: true,
            timestamps: false,
            follow: false
        });

        res.status(200).json({ logs: logs.toString() });
    } catch (error) {
        console.error(`Error in viewLogs: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
};

exports.viewContainerLogs = async (req, res) => {
    const { containerId } = req.params;
    console.log(`Viewing logs for container: ${containerId}`);

    try {
        const container = docker.getContainer(containerId);
        const logs = await container.logs({
            stdout: true,
            stderr: true,
            timestamps: false,
            follow: false
        });

        res.status(200).json({ logs: logs.toString() });
    } catch (error) {
        console.error(`Error in viewContainerLogs: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
};



// Remove a service
exports.removeService = async (req, res) => {
    try {
        const { name } = req.params;
        executeCommand(`docker compose down ${name}`, res);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};



exports.addService = async (req, res) => {
    const { composeFile, stackName } = req.body;
    const userId = req.session.user._id;

    try {
        // Validate YAML
        const yamlObject = jsyaml.load(composeFile);
        if (!yamlObject?.services) {
            return res.status(400).json({ error: 'YAML must contain services' });
        }

        // Check if stack exists
        const existingStack = await Stack.findOne({ name: stackName, userId });
        if (existingStack) {
            return res.status(400).json({ error: 'Stack already exists' });
        }

        // Create stack directory
        const stackDir = path.join(__dirname, '..', 'stacks', stackName);
        if (!fs.existsSync(stackDir)) {
            fs.mkdirSync(stackDir, { recursive: true });
        }

        // Save compose file
        const composeFilePath = path.join(stackDir, 'docker-compose.yml');
        fs.writeFileSync(composeFilePath, composeFile);

        // Deploy stack
        exec(`docker compose -f ${composeFilePath} up -d --remove-orphans`, async (error) => {
            if (error) {
                return res.status(500).json({ error: error.message });
            }

            // Save stack to database
            const stack = new Stack({
                name: stackName,
                yamlContent: composeFile,
                userId
            });
            await stack.save();

            // Save services to database
            const services = Object.keys(yamlObject.services).map(serviceName => ({
                name: serviceName,
                stack: stackName,
                status: 'running',
                containers: [],
                userId
            }));
            await Service.insertMany(services);

            // Update with container details
            const containers = await docker.listContainers({ all: true });
            for (const serviceName of Object.keys(yamlObject.services)) {
                const serviceContainers = containers
                    .filter(c => c.Labels['com.docker.compose.service'] === serviceName)
                    .map(c => ({
                        id: c.Id,
                        name: c.Names[0].replace(/^\//, ''),
                        status: c.State
                    }));

                await Service.updateOne(
                    { name: serviceName, stack: stackName, userId },
                    { $set: { containers: serviceContainers } }
                );
            }

            res.status(200).json({ message: 'Stack deployed successfully' });
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

// Validate YAML configuration
exports.validateYAML = async (req, res) => {
    try {
        const { yaml } = req.body;
        
        if (!yaml) {
            return res.status(400).json({ 
                valid: false, 
                error: 'YAML content is required' 
            });
        }

        // Validate YAML syntax
        const result = jsyaml.load(yaml);
        
        // Basic structure validation
        if (!result || typeof result !== 'object') {
            return res.status(400).json({ 
                valid: false, 
                error: 'Invalid YAML structure - must be a valid YAML object' 
            });
        }

        if (!result.services) {
            return res.status(400).json({ 
                valid: false, 
                error: 'Docker Compose file must contain a "services" section' 
            });
        }

        for (const [serviceName, serviceConfig] of Object.entries(result.services)) {
            if (!serviceConfig.image && !serviceConfig.build) {
                return res.status(400).json({
                    valid: false,
                    error: `Service "${serviceName}" must have either "image" or "build" specified`
                });
            }
        }

        res.json({ valid: true });
    } catch (e) {
        let errorMessage = e.message;
        
        // Common YAML errors
        if (e.message.includes('end of the stream')) {
            errorMessage = 'Incomplete YAML - unexpected end of file';
        } else if (e.message.includes('bad indentation')) {
            errorMessage = 'Incorrect indentation in YAML';
        } else if (e.message.includes('duplicate key')) {
            errorMessage = 'Duplicate key found in YAML';
        }
        
        res.status(400).json({ 
            valid: false, 
            error: errorMessage.replace(/js-yaml/g, 'YAML') 
        });
    }
};

// Get predefined templates
exports.getTemplates = async (req, res) => {
    try {
        const templates = [
            {
                name: 'Node.js + MongoDB',
                yaml: `
version: '3'
services:
  web:
    image: node:14
    ports:
      - "3000:3000"
    volumes:
      - .:/app
    environment:
      - NODE_ENV=development
    depends_on:
      - mongo
  mongo:
    image: mongo:latest
    ports:
      - "27017:27017"
    volumes:
      - mongo-data:/data/db
volumes:
  mongo-data:
                `,
            },
            {
                name: 'WordPress + MySQL',
                yaml: `
version: '3'
services:
  wordpress:
    image: wordpress:latest
    ports:
      - "8080:80"
    environment:
      WORDPRESS_DB_HOST: db
      WORDPRESS_DB_USER: wordpress
      WORDPRESS_DB_PASSWORD: wordpress
    depends_on:
      - db
  db:
    image: mysql:5.7
    environment:
      MYSQL_ROOT_PASSWORD: root
      MYSQL_DATABASE: wordpress
      MYSQL_USER: wordpress
      MYSQL_PASSWORD: wordpress
    volumes:
      - db-data:/var/lib/mysql
volumes:
  db-data:
                `,
            },
        ];

        res.status(200).json(templates);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

exports.deleteStack = async (req, res) => {
    const { name } = req.params;
    console.log(`Deleting Project: ${name}`); 

    try {
        const stack = await Stack.findOne({ name });
        if (!stack) {
            return res.status(404).json({ error: `Stack ${name} not found.` });
        }

        const stackDir = path.join(__dirname, '..', 'stacks', name);
        const composeFilePath = path.join(stackDir, 'docker-compose.yml');
        const childProcess = exec(`docker compose -f ${composeFilePath} down --remove-orphans`, async (error, stdout, stderr) => {
            if (error) {
                console.error(`Error deleting stack: ${stderr}`); 
                return res.status(500).json({ error: stderr });
            }
            console.log(`Stack deleted: ${stdout}`); 

            await Stack.deleteOne({ name });
            await Service.deleteMany({ stack: name });

            fs.rmdirSync(stackDir, { recursive: true });

            res.status(200).json({ message: 'Project deleted successfully.' });
        });
    } catch (error) {
        console.error(`Error in deleteProject: ${error.message}`); 
        res.status(500).json({ error: error.message });
    }
};


// Get stack details
exports.getStack = async (req, res) => {
    const { name } = req.params;
    console.log(`Fetching project: ${name}`); 

    try {
        const stack = await Stack.findOne({ name });
        if (!stack) {
            return res.status(404).json({ error: `Stack ${name} not found.` });
        }

        res.status(200).json(stack);
    } catch (error) {
        console.error(`Error in getProject: ${error.message}`); 
        res.status(500).json({ error: error.message });
    }
};
exports.updateStack = async (req, res) => {
    const { name } = req.params;
    const { composeFile } = req.body;
    console.log(`Attempting to update project: ${name}`); 

    try {
        // Find the existing stack
        const stack = await Stack.findOne({ name });
        if (!stack) {
            console.log(`Project ${name} not found in the database.`); 
            return res.status(404).json({ error: `Project ${name} not found.` });
        }

        // Validate the new YAML content
        let yamlObject;
        try {
            yamlObject = jsyaml.load(composeFile);
        } catch (e) {
            console.error(`Invalid YAML format: ${e.message}`); 
            return res.status(400).json({ error: 'Invalid YAML format.' });
        }

        if (!yamlObject || !yamlObject.services) {
            console.error('YAML must contain a "services" key.'); 
            return res.status(400).json({ error: 'YAML must contain a "services" key.' });
        }

        // Save the updated YAML content to the file
        const stackDir = path.join(__dirname, '..', 'stacks', name);
        const composeFilePath = path.join(stackDir, 'docker-compose.yml');
        fs.writeFileSync(composeFilePath, composeFile);

        // Stop and remove the existing stack in Docker
        console.log(`Stopping and removing existing project ${name} in Docker...`); 
        const deleteProcess = exec(`docker compose -f ${composeFilePath} down`, async (error, stdout, stderr) => {
            if (error) {
                console.error(`Error stopping and removing project: ${stderr}`); 
                return res.status(500).json({ error: stderr });
            }
            console.log(`Project ${name} stopped and removed: ${stdout}`); 

            //  Update the stack's YAML content in the database
            stack.yamlContent = composeFile;
            await stack.save();
            console.log(`Project ${name} updated in the database.`); 

            // Redeploy the stack with the updated YAML
            console.log(`Redeploying project ${name}...`); 
            const childProcess = exec(`docker compose -f ${composeFilePath} up -d --remove-orphans`, (error, stdout, stderr) => {
                if (error) {
                    console.error(`Error redeploying project: ${stderr}`); 
                    return res.status(500).json({ error: stderr });
                }
                console.log(`Project ${name} redeployed successfully: ${stdout}`); 
                res.status(200).json({ message: `Project ${name} updated successfully.` });
            });
        });
    } catch (error) {
        console.error(`Error in updateProject: ${error.message}`); 
        res.status(500).json({ error: error.message });
    }
};

exports.deleteService = async (req, res) => {
    const { name } = req.params;
    console.log(`Attempting to delete service: ${name}`); 

    try {
        // Find the service in the database
        const service = await Service.findOne({ name });
        if (!service) {
            console.log(`Service ${name} not found in the database.`); 
            return res.status(404).json({ error: `Service ${name} not found.` });
        }

        // Find the stack associated with the service
        const stack = await Stack.findOne({ name: service.stack });
        if (!stack) {
            console.log(`Project ${service.stack} not found in the database.`); 
            return res.status(404).json({ error: `Project ${service.stack} not found.` });
        }

        // Delete the service from Docker using docker-compose
        const stackDir = path.join(__dirname, '..', 'stacks', stack.name);
        const composeFilePath = path.join(stackDir, 'docker-compose.yml');
        const childProcess = exec(`docker compose -f ${composeFilePath} rm -f --remove-orphans ${name}`, async (error, stdout, stderr) => {
            if (error) {
                console.error(`Error deleting service from Docker: ${stderr}`); 
                return res.status(500).json({ error: stderr });
            }
            console.log(`Service ${name} deleted from Docker: ${stdout}`); 

            // Delete the service from the database
            await Service.deleteOne({ name });

            console.log(`Service ${name} deleted successfully.`); 
            res.status(200).json({ message: `Service ${name} deleted successfully.` });
        });
    } catch (error) {
        console.error(`Error in deleteService: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
};

exports.viewServiceDetails = async (req, res) => {
    const { name } = req.params;
    console.log(`Viewing details for service: ${name}`); 

    try {
        // Find the service to get the stack name
        const service = await Service.findOne({ name });
        if (!service) {
            return res.status(404).json({ error: `Service ${name} not found.` });
        }

        // Find the stack to get the YAML content
        const stack = await Stack.findOne({ name: service.stack });
        if (!stack) {
            return res.status(404).json({ error: `Project ${service.stack} not found.` });
        }

        // Inspect the service using docker-compose
        const childProcess = exec(`docker compose -f - config`, (error, stdout, stderr) => {
            if (error) {
                console.error(`Error inspecting service: ${stderr}`); 
                return res.status(500).json({ error: stderr });
            }
            console.log(`Service details: ${stdout}`); 
            res.status(200).json({ details: stdout });
        });

        // Pass the YAML content to the docker-compose command
        childProcess.stdin.write(stack.yamlContent);
        childProcess.stdin.end();
    } catch (error) {
        console.error(`Error in viewServiceDetails: ${error.message}`); 
        res.status(500).json({ error: error.message });
    }
};

exports.restartContainer = async (req, res) => {
    const { containerId } = req.params;
    console.log(`Restarting container: ${containerId}`); 

    try {
        // Restart the container
        const childProcess = exec(`docker restart ${containerId}`, async (error, stdout, stderr) => {
            if (error) {
                console.error(`Error restarting container: ${stderr}`); 
                return res.status(500).json({ error: stderr });
            }
            console.log(`Container restarted: ${stdout}`); 

            // Update the container status in the database
            await Service.updateOne(
                { 'containers.id': containerId },
                { $set: { 'containers.$.status': 'running' } }
            );

            res.status(200).json({ message: stdout });
        });
    } catch (error) {
        console.error(`Error in restartContainer: ${error.message}`); 
        res.status(500).json({ error: error.message });
    }
};

exports.stopContainer = async (req, res) => {
    const { containerId } = req.params;
    console.log(`Stopping container: ${containerId}`); 

    try {
        // Stop the container
        const childProcess = exec(`docker stop ${containerId}`, async (error, stdout, stderr) => {
            if (error) {
                console.error(`Error stopping container: ${stderr}`); 
                return res.status(500).json({ error: stderr });
            }
            console.log(`Container stopped: ${stdout}`); 

            // Update the container status in the database
            await Service.updateOne(
                { 'containers.id': containerId },
                { $set: { 'containers.$.status': 'stopped' } }
            );

            res.status(200).json({ message: stdout });
        });
    } catch (error) {
        console.error(`Error in stopContainer: ${error.message}`); 
        res.status(500).json({ error: error.message });
    }
};

exports.deleteContainer = async (req, res) => {
    const { containerId } = req.params;
    console.log(`Deleting container: ${containerId}`); 

    try {
        // Delete the container
        const childProcess = exec(`docker rm -f ${containerId}`, async (error, stdout, stderr) => {
            if (error) {
                console.error(`Error deleting container: ${stderr}`); 
                return res.status(500).json({ error: stderr });
            }
            console.log(`Container deleted: ${stdout}`); 

            // Remove the container from the database
            await Service.updateMany(
                { 'containers.id': containerId },
                { $pull: { containers: { id: containerId } } }
            );

            res.status(200).json({ message: 'Container deleted successfully.' });
        });
    } catch (error) {
        console.error(`Error in deleteContainer: ${error.message}`); 
        res.status(500).json({ error: error.message });
    }
};


const syncDatabaseWithDocker = async () => {
    try {
        const containers = await docker.listContainers({ all: true });

        // Update the database to match the actual state of Docker containers
        for (const container of containers) {
            const serviceName = container.Labels['com.docker.compose.service'];
            if (serviceName) {
                await Service.updateOne(
                    { 'containers.id': container.Id },
                    { $set: { 'containers.$.status': container.State } }
                );
            }
        }
    } catch (error) {
        console.error('Error syncing database with Docker:', error);
    }
};

// Run the sync function periodically (every 5 minutes)
setInterval(syncDatabaseWithDocker, 5 * 60 * 1000);
