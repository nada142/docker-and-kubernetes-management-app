const Docker = require('dockerode');
const docker = new Docker({ socketPath: '/var/run/docker.sock' });
const SwarmStack = require('../models/SwarmStack');
const yaml = require('js-yaml');
const axios = require('axios');
const { exec } = require('child_process');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const util = require('util');

const execPromise = util.promisify(exec);

const os = require('os');
const net = require('net');

const getNodeIP = async () => {
  try {
    const { stdout } = await require('util').promisify(require('child_process').exec)(
      "hostname -I | awk '{print $1}'"
    );
    const ip = stdout.trim();
    
    if (net.isIP(ip)) {
      return ip;
    }
    
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal) {
          return iface.address;
        }
      }
    }
    
    return '127.0.0.1'; 
  } catch (error) {
    console.error('Error getting node IP:', error);
    return '127.0.0.1';
  }
};

exports.getSwarmOverview = async (req, res) => {
    try {
        const swarmInfo = await docker.swarmInspect();
        const nodes = await docker.listNodes();
        const services = await docker.listServices();
        const tasks = await docker.listTasks();

        const servicesWithNodes = services.map(service => {
            const serviceTasks = tasks.filter(task => task.ServiceID === service.ID);
            const associatedNodes = serviceTasks.map(task => {
                const node = nodes.find(node => node.ID === task.NodeID);
                return node ? node.Description.Hostname : 'Unknown';
            });

            return {
                ...service,
                nodes: [...new Set(associatedNodes)], 
            };
        });

        res.json({
            status: swarmInfo.Spec.AcceptancePolicy?.Policies?.[0]?.State === 'active' ? 'Active' : 'Inactive',
            leaderManager: nodes.find(node => node.ManagerStatus && node.ManagerStatus.Leader)?.Description?.Hostname || 'N/A',
            totalNodes: nodes.length,
            totalServices: services.length,
            managers: nodes.filter(node => node.Spec.Role === 'manager').length,
            workers: nodes.filter(node => node.Spec.Role === 'worker').length,
            nodes: nodes.map(node => ({
                id: node.ID,
                label: node.Description.Hostname,
                role: node.Spec.Role,
                status: node.Status.State,
            })),
            services: servicesWithNodes, 
        });
    } catch (error) {
        console.error('Error fetching Swarm overview:', error);
        res.status(500).json({ message: 'Error fetching Swarm overview', error: error.message });
    }
};


exports.initializeSwarm = async (req, res) => {
    try {
        console.log('Starting swarm initialization...');
        const advertiseAddr = await getNodeIP();

        const swarmDataDir = '/tmp/swarm-data';
        
        await fs.promises.mkdir(swarmDataDir, { recursive: true });
        await fs.promises.chmod(swarmDataDir, 0o755); 

        console.log('Leaving any existing swarm...');
        try {
            await execPromise('docker swarm leave --force');
        } catch (leaveError) {
            console.warn('Swarm leave warning (may be normal):', leaveError.message);
        }

        console.log('Initializing new swarm...');
        const initCommand = `docker swarm init --advertise-addr ${advertiseAddr} --default-addr-pool 10.10.0.0/16`;
        const { stdout: initStdout } = await execPromise(initCommand);

        // Store the configuration
        await Promise.all([
            execPromise(`docker swarm join-token -q worker > ${swarmDataDir}/worker.token`),
            execPromise(`docker swarm join-token -q manager > ${swarmDataDir}/manager.token`),
            fs.promises.writeFile(`${swarmDataDir}/advertise-addr`, advertiseAddr)
        ]);

        console.log('Swarm initialized successfully');
        res.json({ 
            success: true,
            message: 'Swarm initialized successfully',
            advertiseAddr,
            dataDir: swarmDataDir,
            output: initStdout 
        });
    } catch (error) {
        console.error('Swarm initialization failed:', error);
        res.status(500).json({ 
            success: false,
            message: 'Swarm initialization failed',
            error: error.message 
        });
    }
};
exports.listStacks = async (req, res) => {
    try {
        exec('docker stack ls --format "{{.Name}}"', (error, stdout, stderr) => {
            if (error) {
                console.error('Error listing stacks:', error);
                return res.status(500).json({ message: 'Error listing stacks', error: error.message });
            }
            if (stderr) {
                console.error('Docker CLI stderr:', stderr);
                return res.status(500).json({ message: 'Error listing stacks', error: stderr });
            }

            const stacks = stdout.trim().split('\n').filter(name => name.trim() !== '');
            res.json(stacks);
        });
    } catch (error) {
        console.error('Error fetching stacks:', error);
        res.status(500).json({ message: 'Error fetching stacks', error: error.message });
    }
};

// Deploy a new stack to the Swarm
exports.deployStack = async (req, res) => {
    const { name, yamlContent } = req.body;
    try {
        const existingStack = await SwarmStack.findOne({ name });
        if (existingStack) {
            return res.status(400).json({ message: 'A stack with this name already exists' });
        }

        // Write the YAML content to a temporary file
        const tempFilePath = `/tmp/${name}-docker-compose.yml`;
        fs.writeFileSync(tempFilePath, yamlContent);

        // Deploy the stack to Docker Swarm using the Docker CLI
        exec(`docker stack deploy --detach=true -c ${tempFilePath} ${name}`, async (error, stdout, stderr) => {
            // Delete the temporary file after deployment
            fs.unlinkSync(tempFilePath);

            if (error) {
                console.error('Error deploying stack:', error);
                return res.status(500).json({ message: 'Error deploying stack', error: error.message });
            }
            if (stderr) {
                console.error('Docker CLI stderr:', stderr);
                return res.status(500).json({ message: 'Error deploying stack', error: stderr });
            }

            // Save the stack to the database only if deployment is successful
            const stack = await SwarmStack.create({ name, yamlContent });

            console.log('Deployed stack:', stdout); // Log the output for debugging
            res.status(201).json({ message: 'Stack deployed successfully', stack });
        });
    } catch (error) {
        console.error('Error deploying stack:', error);
        res.status(500).json({ message: 'Error deploying stack', error: error.message });
    }
};


exports.removeStack = async (req, res) => {
    const { stackName } = req.params;
    try {
        // Remove the stack from Docker Swarm
        exec(`docker stack rm ${stackName}`, async (error, stdout, stderr) => {
            if (error) {
                console.error('Error removing stack:', error);
                return res.status(500).json({ message: 'Error removing stack', error: error.message });
            }
            if (stderr) {
                console.error('Docker CLI stderr:', stderr);
                return res.status(500).json({ message: 'Error removing stack', error: stderr });
            }

            // Delete the stack from the database
            await SwarmStack.deleteOne({ name: stackName });
            res.json({ message: 'Stack removed successfully' });
        });
    } catch (error) {
        console.error('Error removing stack:', error);
        res.status(500).json({ message: 'Error removing stack', error: error.message });
    }
};
// List all services in a stack
exports.listServices = async (req, res) => {
    try {
        const services = await docker.listServices();
        const tasks = await docker.listTasks();
        const nodes = await docker.listNodes();

        const servicesWithNodes = services.map(service => {
            const serviceTasks = tasks.filter(task => task.ServiceID === service.ID);
            const associatedNodes = serviceTasks.map(task => {
                const node = nodes.find(node => node.ID === task.NodeID);
                return node ? node.Description.Hostname : 'Unknown';
            });

            return {
                ...service,
                nodes: [...new Set(associatedNodes)], 
            };
        });

        res.json(servicesWithNodes);
    } catch (error) {
        console.error('Error fetching services:', error);
        res.status(500).json({ message: 'Error fetching services', error: error.message });
    }
};

exports.stopService = async (req, res) => {
    const { serviceId } = req.params;
    try {
        const service = docker.getService(serviceId);
        const serviceInfo = await service.inspect();

        await service.update({
            ...serviceInfo.Spec,
            version: serviceInfo.Version.Index, 
            Mode: {
                Replicated: {
                    Replicas: 0, 
                },
            },
        });

        res.json({ message: 'Service stopped successfully' });
    } catch (error) {
        console.error('Error stopping service:', error);
        res.status(500).json({ message: 'Error stopping service', error: error.message });
    }
};

exports.restartService = async (req, res) => {
    const { serviceId } = req.params;
    try {
        const service = docker.getService(serviceId);
        const serviceInfo = await service.inspect();

        await service.update({
            ...serviceInfo.Spec,
            version: serviceInfo.Version.Index, 
            TaskTemplate: {
                ...serviceInfo.Spec.TaskTemplate,
                ForceUpdate: serviceInfo.Spec.TaskTemplate.ForceUpdate + 1, 
            },
        });

        res.json({ message: 'Service restarted successfully' });
    } catch (error) {
        console.error('Error restarting service:', error);
        res.status(500).json({ message: 'Error restarting service', error: error.message });
    }
};



// Remove a stack
exports.removeStack = async (req, res) => {
    const { stackName } = req.params;
    try {
        // Remove the stack from Docker Swarm
        await docker.removeStack(stackName);

        // Delete the stack from the database
        await SwarmStack.deleteOne({ name: stackName });
        res.json({ message: 'Stack removed successfully' });
    } catch (error) {
        res.status(500).json({ message: 'Error removing stack', error: error.message });
    }
};

// List all nodes in the Swarm
exports.listNodes = async (req, res) => {
    try {
        const nodes = await docker.listNodes();
        res.json(nodes);
    } catch (error) {
        res.status(500).json({ message: 'Error fetching nodes', error: error.message });
    }
};
async function getManagerIP() {
    try {
        // Try to read from stored config first
        const swarmDataDir = '/tmp/swarm-data';
        const addrFile = `${swarmDataDir}/advertise-addr`;
        
        if (fs.existsSync(addrFile)) {
            return fs.readFileSync(addrFile, 'utf8').trim();
        }
        
        // Fallback to current node IP
        return await getNodeIP();
    } catch (error) {
        console.error('Error getting manager IP:', error);
        return '127.0.0.1'; // Ultimate fallback
    }
}
exports.addWorkerNode = async (req, res) => {
    try {
        const swarmInfo = await docker.swarmInspect();
        const token = swarmInfo.JoinTokens.Worker;
        const managerIP = await getManagerIP();
        const workerName = `worker-${uuidv4().substring(0, 8)}`;

        console.log(`Creating worker container ${workerName}...`);
        const container = await docker.createContainer({
            Image: 'docker:dind',
            name: workerName,
            HostConfig: {
                Privileged: true,
                NetworkMode: 'host',
                RestartPolicy: { Name: 'unless-stopped' }
            }
        });

        await container.start();
        console.log(`Worker container ${workerName} started, waiting for initialization...`);

        let attempts = 0;
        const maxAttempts = 30;
        let lastError = null;

        while (attempts < maxAttempts) {
            try {
                const health = await new Promise((resolve, reject) => {
                    exec(`docker exec ${workerName} docker info`, 
                        (error, stdout, stderr) => error ? reject(error) : resolve(true));
                });

                if (health) break;
            } catch (error) {
                lastError = error;
                attempts++;
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }

        if (attempts >= maxAttempts) {
            throw new Error(`Docker not ready in worker after ${maxAttempts} seconds: ${lastError?.message}`);
        }

        console.log(`Joining worker ${workerName} to swarm...`);
        const joinOutput = await new Promise((resolve, reject) => {
            exec(`docker exec ${workerName} docker swarm join --token ${token} ${managerIP}:2377`,
                (error, stdout, stderr) => error ? reject(stderr || error.message) : resolve(stdout));
        });

        res.json({ 
            success: true,
            message: `Worker node added: ${joinOutput}`,
            containerId: container.id
        });
    } catch (error) {
        console.error('Error adding worker node:', error);
        res.status(500).json({ 
            success: false,
            message: 'Error adding worker node', 
            error: error.message 
        });
    }
};

exports.addManagerNode = async (req, res) => {
    try {
        const swarmInfo = await docker.swarmInspect();
        const token = swarmInfo.JoinTokens.Manager;
        
        let managerIP;
        try {
            managerIP = fs.readFileSync('/var/lib/swarm-data/advertise-addr', 'utf8').trim();
        } catch (e) {
            managerIP = await getNodeIP();
        }

        console.log("Creating a new manager node...");
        const nodeId = uuidv4().substring(0, 8);
        const managerName = `manager-node-${nodeId}`;
        const persistentDir = `/tmp/${managerName}`;

        exec(`mkdir -p ${persistentDir}`, async (mkdirError) => {
            if (mkdirError) {
                console.error(`Error creating persistent directory: ${mkdirError.message}`);
                return res.status(500).json({ message: 'Error creating persistent directory', error: mkdirError.message });
            }

            exec(`docker run -d --privileged \
                --name ${managerName} \
                --network host \
                --restart unless-stopped \
                -v ${persistentDir}:/var/lib/docker \
                docker:dind`, async (error, stdout, stderr) => {
                if (error) {
                    console.error(`Error creating manager: ${error.message}`);
                    return res.status(500).json({ message: 'Error creating manager', error: error.message });
                }
                console.log(`Manager container started: ${stdout}`);

                await new Promise(resolve => setTimeout(resolve, 5000));

                let retries = 3;
                let lastError = null;

                while (retries > 0) {
                    try {
                        const joinOutput = await new Promise((resolve, reject) => {
                            exec(`docker exec ${managerName} docker swarm join --token ${token} ${managerIP}:2377`,
                                (error, stdout, stderr) => {
                                    if (error) {
                                        reject(new Error(stderr || error.message));
                                    } else {
                                        resolve(stdout);
                                    }
                                });
                        });

                        console.log(`Manager joined the swarm: ${joinOutput}`);
                        return res.json({ message: `Manager node added: ${joinOutput}` });
                    } catch (joinError) {
                        lastError = joinError;
                        retries--;
                        await new Promise(resolve => setTimeout(resolve, 5000)); 
                    }
                }

                console.error(`Failed to join manager after 3 attempts: ${lastError.message}`);
                res.status(500).json({ 
                    message: 'Manager node created but failed to join swarm', 
                    error: lastError.message 
                });
            });
        });
    } catch (error) {
        console.error('Error adding manager node:', error);
        res.status(500).json({ message: 'Error adding manager node', error: error.message });
    }
};

// Validate YAML content
const validateYAML = (yamlContent) => {
    try {
        yaml.load(yamlContent);
        return { valid: true };
    } catch (error) {
        return { valid: false, error: error.message };
    }
};

const getAISuggestions = async (errorMessage) => {
    try {
        const response = await axios.post('http://localhost:11434/api/generate', {
            model: 'mistral:7b-instruct-q2_K',
            prompt: `
                The following error occurred while validating Docker Compose YAML:
                \`\`\`
                ${errorMessage}
                \`\`\`
                Provide 2-3 short and concise suggestions to fix the issue. Each suggestion should be one sentence.
            `,
            stream: false,
            max_tokens: 100,
        }, { headers: { 'Content-Type': 'application/json' } });

        if (response.status !== 200 || !response.data) {
            throw new Error('Failed to generate suggestions.');
        }

        return response.data.response.split('\n').filter(line => line.trim() !== '');
    } catch (error) {
        console.error('Error calling AI service:', error);
        return ['Failed to generate suggestions. Please check the error message manually.'];
    }
};

// Validate YAML endpoint
exports.validateYAML = async (req, res) => {
    const { yamlContent } = req.body;
    const validation = validateYAML(yamlContent);

    if (!validation.valid) {
        const suggestions = await getAISuggestions(validation.error);
        res.json({ valid: false, error: validation.error, suggestions });
    } else {
        res.json({ valid: true });
    }
};


exports.getServiceLogs = async (req, res) => {
    const { serviceId } = req.params;
    try {
        const service = docker.getService(serviceId);
        const logs = await service.logs({ stdout: true, stderr: true, timestamps: true });
        res.json({ logs: logs.toString() });
    } catch (error) {
        console.error('Error fetching service logs:', error);
        res.status(500).json({ message: 'Error fetching service logs', error: error.message });
    }
};
exports.listServicess = async (req, res) => {
    const { stackName } = req.params;
    try {
        const services = await docker.listServices({
            filters: { label: [`com.docker.stack.namespace=${stackName}`] },
        });
        const tasks = await docker.listTasks();
        const nodes = await docker.listNodes();

        const servicesWithNodes = services.map(service => {
            const serviceTasks = tasks.filter(task => task.ServiceID === service.ID);
            const associatedNodes = serviceTasks.map(task => {
                const node = nodes.find(node => node.ID === task.NodeID);
                return node ? node.Description.Hostname : 'Unknown';
            });

            return {
                ...service,
                nodes: [...new Set(associatedNodes)], 
            };
        });

        res.json(servicesWithNodes);
    } catch (error) {
        console.error('Error fetching services:', error);
        res.status(500).json({ message: 'Error fetching services', error: error.message });
    }
};

exports.getClusterMetrics = async (req, res) => {
    try {
        const nodes = await docker.listNodes();
        const metrics = nodes.map(node => ({
            id: node.ID,
            hostname: node.Description.Hostname,
            role: node.Spec.Role,
            status: node.Status.State,
            cpu: node.Description.Resources.NanoCPUs / 1e9, 
            memory: node.Description.Resources.MemoryBytes / 1e9, 
        }));
        res.json(metrics);
    } catch (error) {
        console.error('Error fetching cluster metrics:', error);
        res.status(500).json({ message: 'Error fetching cluster metrics', error: error.message });
    }
};


exports.promoteNode = async (req, res) => {
    const { nodeId } = req.params;

    exec(`docker node update --role manager ${nodeId}`, (error, stdout, stderr) => {
        if (error) {
            console.error('Error promoting node:', error.message);
            return res.status(500).json({ message: 'Error promoting node', error: error.message });
        }
        if (stderr) {
            console.error('Docker CLI stderr:', stderr);
            return res.status(500).json({ message: 'Error promoting node', error: stderr });
        }

        res.json({ message: 'Node promoted successfully' });
    });
};

exports.demoteNode = async (req, res) => {
    const { nodeId } = req.params;

    exec(`docker node update --role worker ${nodeId}`, (error, stdout, stderr) => {
        if (error) {
            console.error('Error demoting node:', error.message);
            return res.status(500).json({ message: 'Error demoting node', error: error.message });
        }
        if (stderr) {
            console.error('Docker CLI stderr:', stderr);
            return res.status(500).json({ message: 'Error demoting node', error: stderr });
        }

        res.json({ message: 'Node demoted successfully' });
    });
};



exports.drainNode = async (req, res) => {
    const { nodeId } = req.params;
    const { drain } = req.body;

    const availability = drain ? 'drain' : 'active';

    exec(`docker node update --availability ${availability} ${nodeId}`, (error, stdout, stderr) => {
        if (error) {
            console.error('Error updating node:', error.message);
            return res.status(500).json({ message: 'Error updating node', error: error.message });
        }
        if (stderr) {
            console.error('Docker CLI stderr:', stderr);
            return res.status(500).json({ message: 'Error updating node', error: stderr });
        }

        res.json({ message: `Node ${drain ? 'drained' : 'undrained'} successfully` });
    });
};

exports.deleteNode = async (req, res) => {
    const { nodeId } = req.params;
    try {
        exec(`docker node rm ${nodeId}`, (error, stdout, stderr) => {
            if (error) {
                console.error('Error deleting node:', error);
                return res.status(500).json({ message: 'Error deleting node', error: error.message });
            }
            if (stderr) {
                console.error('Docker CLI stderr:', stderr);
                return res.status(500).json({ message: 'Error deleting node', error: stderr });
            }

            res.json({ message: 'Node deleted successfully' });
        });
    } catch (error) {
        console.error('Error deleting node:', error);
        res.status(500).json({ message: 'Error deleting node', error: error.message });
    }
};

exports.deployService = async (req, res) => {
    const { name, image, replicas, ports, env, constraints } = req.body;

    try {
        const service = await docker.createService({
            Name: name,
            TaskTemplate: {
                ContainerSpec: {
                    Image: image,
                    Env: env.split(',').map(e => e.trim()),
                },
                Placement: {
                    Constraints: constraints.split(',').map(c => c.trim()),
                },
            },
            Mode: {
                Replicated: {
                    Replicas: parseInt(replicas, 10),
                },
            },
            EndpointSpec: {
                Ports: ports.split(',').map(p => {
                    const [published, target] = p.split(':');
                    return {
                        PublishedPort: parseInt(published, 10),
                        TargetPort: parseInt(target, 10),
                    };
                }),
            },
        });
        res.json({ message: 'Service deployed successfully', service });
    } catch (error) {
        console.error('Error deploying service:', error);
        res.status(500).json({ message: 'Error deploying service', error: error.message });
    }
};

exports.scaleService = async (req, res) => {
    const { serviceId } = req.params;
    const { replicas } = req.body;

    exec(`docker service scale ${serviceId}=${replicas}`, (error, stdout, stderr) => {
        if (error) {
            console.error('Error scaling service:', error.message);
            return res.status(500).json({ message: 'Error scaling service', error: error.message });
        }
        if (stderr) {
            console.error('Docker CLI stderr:', stderr);
            return res.status(500).json({ message: 'Error scaling service', error: stderr });
        }

        res.json({ message: `Service scaled to ${replicas} replicas` });
    });
};


exports.deleteService = async (req, res) => {
    const { serviceId } = req.params;
    try {
        const service = docker.getService(serviceId);
        await service.remove();
        res.json({ message: 'Service deleted successfully' });
    } catch (error) {
        console.error('Error deleting service:', error);
        res.status(500).json({ message: 'Error deleting service', error: error.message });
    }
};

exports.listNetworks = async (req, res) => {
    try {
        const networks = await docker.listNetworks();
        res.json(networks);
    } catch (error) {
        console.error('Error fetching networks:', error);
        res.status(500).json({ message: 'Error fetching networks', error: error.message });
    }
};

exports.listVolumes = async (req, res) => {
    try {
        const volumes = await docker.listVolumes();
        res.json(volumes);
    } catch (error) {
        console.error('Error fetching volumes:', error);
        res.status(500).json({ message: 'Error fetching volumes', error: error.message });
    }
};




async function recoverSwarm() {
    try {
        // Check current swarm status
        try {
            await docker.swarmInspect();
            console.log('Swarm is active');
            return;
        } catch (inspectError) {
            if (!inspectError.message.includes('no swarm')) {
                throw inspectError;
            }
        }

        const swarmDataDir = '/var/lib/swarm-data';
        if (fs.existsSync(`${swarmDataDir}/swarm-config.json`)) {
            console.log('Attempting to restore swarm from backup...');
            
            let advertiseAddr = '127.0.0.1';
            try {
                advertiseAddr = fs.readFileSync(`${swarmDataDir}/advertise-addr`, 'utf8').trim();
            } catch (e) {
                console.warn('Could not read advertise-addr, using fallback');
                advertiseAddr = await getNodeIP();
            }

            // Restore swarm directory
            exec(`cp ${swarmDataDir}/swarm /var/lib/docker/swarm -r`, async (copyError) => {
                if (copyError) {
                    console.error('Failed to restore swarm data:', copyError);
                    return initializeNewSwarm();
                }

                exec(`docker swarm init --force-new-cluster --advertise-addr ${advertiseAddr}`, (initError, initStdout) => {
                    if (initError) {
                        console.error('Failed to force new cluster:', initError);
                        return initializeNewSwarm();
                    }
                    console.log('Swarm recovered successfully:', initStdout);
                });
            });
        } else {
            initializeNewSwarm();
        }
    } catch (error) {
        console.error('Error in swarm recovery:', error);
        initializeNewSwarm();
    }
}

async function initializeNewSwarm() {
    console.log('Initializing new swarm...');
    const advertiseAddr = await getNodeIP();
    
    exec(`docker swarm leave --force && docker swarm init --advertise-addr ${advertiseAddr} --default-addr-pool 10.10.0.0/16`,   
        (error, stdout) => {
            if (error) {
                console.error('Failed to initialize new swarm:', error);
                return;
            }
            console.log('New swarm initialized:', stdout);
            
            // Save the configuration
            exec(`
                mkdir -p /var/lib/swarm-data
                echo "${advertiseAddr}" > /var/lib/swarm-data/advertise-addr
                docker swarm join-token -q worker > /var/lib/swarm-data/worker.token
                docker swarm join-token -q manager > /var/lib/swarm-data/manager.token
                cp /var/lib/docker/swarm /var/lib/swarm-data/swarm -r
            `);
        });
}

async function checkSwarmHealth() {
    try {
        const info = await docker.swarmInspect();
        const nodes = await docker.listNodes();
        
        // Check manager health
        const healthyManagers = nodes.filter(node => 
            node.Spec.Role === 'manager' && 
            node.ManagerStatus && 
            node.ManagerStatus.Reachability === 'reachable'
        );
        
        if (healthyManagers.length < Math.ceil(nodes.length / 2)) {
            console.error('Swarm unhealthy - not enough managers');
            await recoverSwarm();
        }
    } catch (error) {
        console.error('Swarm health check failed:', error);
        await recoverSwarm();
    }
}

recoverSwarm();
setInterval(checkSwarmHealth, 120000);
