const Container = require('../models/Container');
const DockerImage = require('../models/Image'); 

const { exec } = require('child_process'); 

const Docker = require('dockerode');
const docker = new Docker({ socketPath: '/var/run/docker.sock' });



// Run periodically every 5 minutes
setInterval(async () => {
    try {
        const containers = await docker.listContainers({ all: true });
        const containerIds = containers.map(c => c.Id);
        
        // Update statuses of existing containers
        await Promise.all(containers.map(async (containerInfo) => {
            await Container.updateOne(
                { containerId: containerInfo.Id },
                { 
                    status: containerInfo.State.toLowerCase(),
                    name: containerInfo.Names[0].replace(/^\//, '') 
                }
            );
        }));
        
        await Container.deleteMany({ 
            containerId: { $nin: containerIds },
            isComposeContainer: false 
        });
        
        console.log('Container sync completed');
    } catch (error) {
        console.error('Error syncing containers:', error);
    }
}, 300000); // 5 minutes



const { logError, logInfo } = require('../utils/logger');
const sendErrorResponse = (res, statusCode, message, error = null) => {
    if (error) {
        logError(error); 
    }
    res.status(statusCode).json({
        success: false,
        message: message,
        error: error ? error.message : null,
    });
};

exports.createContainer = async (req, res) => {
    try {
        const { imageName, containerName, volumes, port } = req.body;

        // Validate required fields
        if (!imageName || !containerName) {
            return sendErrorResponse(res, 400, 'Image name and container name are required.');
        }

        // Check if a container with the same name already exists
        const existingContainer = await Container.findOne({ name: containerName });
        if (existingContainer) {
            return sendErrorResponse(res, 409, 'A container with this name already exists. Please choose a different name.');
        }

        // Check if the Docker image exists
        const image = await DockerImage.findOne({ 
            name: imageName,
            userId: req.session.user._id 
        });
         if (!image) {
            return sendErrorResponse(res, 404, 'The specified image does not exist. Please check the image name and try again.');
        }

        // Check if the port is already in use (if provided)
        if (port) {
            const portInUse = await Container.findOne({ port });
            if (portInUse) {
                return sendErrorResponse(res, 409, 'The specified port is already in use. Please choose a different port.');
            }
        }

        // Prepare Docker run command
        const volumeBindings = volumes.map(volume => `${volume}:/mnt/${volume}`); 
        const portMapping = port ? `-p ${port}:${port}` : '';
        const volumeOptions = volumeBindings.length > 0 ? `-v ${volumeBindings.join(' -v ')}` : '';

        const defaultVolumes = ['/var/lib/mysql']; 
        const defaultVolumeBindings = defaultVolumes.map(path => `${containerName}-${path.split('/').pop()}:${path}`);
        const defaultVolumeOptions = defaultVolumeBindings.length > 0 ? `-v ${defaultVolumeBindings.join(' -v ')}` : '';

        const command = `docker run -d ${portMapping} ${volumeOptions} ${defaultVolumeOptions} --name ${containerName} ${imageName}`;

        // Execute Docker command
        exec(command, async (error, stdout, stderr) => {
            if (error) {
                if (stderr.includes('port is already allocated')) {
                    return sendErrorResponse(res, 409, 'The specified port is already in use. Please choose a different port.');
                }
                if (stderr.includes('No such image')) {
                    return sendErrorResponse(res, 404, 'The specified image does not exist. Please check the image name and try again.');
                }
                if (stderr.includes('Permission denied')) {
                    return sendErrorResponse(res, 403, 'Permission denied. Please ensure you have the necessary permissions.');
                }
                if (stderr.includes('Cannot connect to the Docker daemon')) {
                    return sendErrorResponse(res, 500, 'Docker daemon is not running. Please start Docker and try again.');
                }
                return sendErrorResponse(res, 500, 'An unexpected error occurred while creating the container.', error);
            }

            const containerId = stdout.trim(); // Capture the container ID

            // Save the container in the database
            const newContainer = new Container({
                name: containerName,
                containerId: containerId,
                image: imageName,
                volumes: volumes,
                port: port || null,
                status: 'running',
                dockerImage: image._id,
                userId: req.session.user._id

            });

            await newContainer.save();
            logInfo(`Container ${containerName} created successfully.`);
            res.status(201).json({ success: true, message: 'Container created successfully', container: newContainer });
        });
    } catch (error) {
        logError(`Unexpected error creating container: ${error.message}`);
        sendErrorResponse(res, 500, 'An unexpected error occurred. Please try again later.', error);
    }
};


// Restart a container
exports.startContainer = async (req, res) => {
    try {
        const { id } = req.params; 
        const container = await Container.findOne({ containerId: id }); // Search by containerId

        if (!container) {
            return res.status(404).json({ error: 'Container not found' });
        }

        exec(`docker start ${container.containerId}`, (error, stdout, stderr) => {
            if (error) {
                return res.status(500).json({ error: error.message });
            }

            container.status = 'running'; // Update status in the database
            container.save()
                .then(() => res.status(200).json({ message: 'Container restarted successfully', container }))
                .catch(err => res.status(500).json({ error: err.message }));
        });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
};


// Stop a container
exports.stopContainer = async (req, res) => {
    try {
        const containerId = req.params.id;

        exec(`docker stop ${containerId}`, async (error, stdout, stderr) => {
            if (error) {
                return res.status(500).json({ error: error.message });
            }

            const updatedContainer = await Container.findOneAndUpdate(
                { containerId }, 
                { status: 'exited' },  
                { new: true }
            );

            if (!updatedContainer) {
                return res.status(404).json({ message: "Container not found in the database" });
            }

            res.status(200).json({ message: "Container stopped successfully", container: updatedContainer });
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};



// Delete a container
exports.deleteContainer = async (req, res) => {
    try {
        const containerId = req.params.id;

        exec(`docker rm -f ${containerId}`, async (error, stdout, stderr) => {
            if (error) {
                return res.status(500).json({ error: error.message });
            }

            const deletedContainer = await Container.findOneAndDelete({ containerId });
            if (!deletedContainer) {
                return res.status(404).json({ message: "Container not found in the database" });
            }

            res.status(200).json({ message: "Container deleted successfully" });
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};



// Get the status of a container
exports.getStatus = async (req, res) => {
    try {
        const { id } = req.params;
        const container = await Container.findById(id);
        
        if (!container) {
            return res.status(404).json({ error: 'Container not found' });
        }

        exec(`docker ps -a --filter "name=${container.name}" --format "{{.Status}}"`, (error, stdout, stderr) => {
            if (error) {
                return res.status(500).json({ error: error.message });
            }
            res.status(200).json({ status: stdout.trim() });
        });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
};
// Get all containers
exports.listContainers = async (req, res) => {
    try {
        const userId = req.session.user._id;

        exec('docker ps -a --format "{{.ID}} {{.Names}} {{.Image}} {{.Status}}"', async (error, stdout, stderr) => {
            if (error) {
                return res.status(500).json({ error: error.message });
            }

            const containerList = stdout.trim().split('\n').map(line => {
                const [containerId, name, image, status] = line.split(' ', 4);
                return { containerId, name, image, status };
            });

            // Fetch volume information for each container
            const containersWithVolumes = await Promise.all(containerList.map(async (container) => {
                const volumeInfo = await new Promise((resolve, reject) => {
                    exec(`docker inspect ${container.containerId} --format '{{json .Mounts}}'`, (error, stdout, stderr) => {
                        if (error) {
                            console.error(`Error fetching volume info for container ${container.containerId}:`, stderr);
                            resolve([]); 
                        } else {
                            try {
                                const mounts = JSON.parse(stdout.trim());
                                resolve(mounts);
                            } catch (parseError) {
                                console.error(`Error parsing volume info for container ${container.containerId}:`, parseError);
                                resolve([]); 
                            }
                        }
                    });
                });

                return {
                    ...container,
                    volumes: volumeInfo.map(vol => vol.Source).join(', '),
                    userId: userId // Associate container with user
                };
            }));

            // Save or update containers in the database
            for (const container of containersWithVolumes) {
                try {
                    const existingContainer = await Container.findOne({ name: container.name, userId });

                    if (!existingContainer) {
                        const dockerImage = await DockerImage.findOne({ name: container.image, userId });

                        if (dockerImage) {
                            const newContainer = new Container({
                                name: container.name,
                                containerId: container.containerId,
                                image: container.image,
                                status: container.status,
                                volumes: container.volumes,
                                dockerImage: dockerImage._id,
                                isComposeContainer: false,
                                userId: userId
                            });
                            await newContainer.save();
                            console.log(`Saved new container: ${container.name}, Image: ${container.image}`); // Debug log
                        } else {
                            console.warn(`DockerImage not found for container ${container.name} with image ${container.image}`);
                        }
                    } else {
                        console.log(`Container with name ${container.name} already exists, skipping...`);
                    }
                } catch (err) {
                    console.error(`Error saving container ${container.name}:`, err.message);
                }
            }

            // Fetch only standalone containers (isComposeContainer: false) from the database
            const standaloneContainers = await Container.find(
                {userId, isComposeContainer: false },
                { containerId: 1, name: 1, dockerImage: 1, status: 1, volumes: 1, _id: 0 }
            ).populate('dockerImage', 'name'); 

            console.log('Standalone containers:', standaloneContainers); 

            // Map the standalone containers to include volume information
            const result = standaloneContainers.map(container => ({
                containerId: container.containerId,
                name: container.name,
                image: container.dockerImage ? container.dockerImage.name : 'N/A', 
                status: container.status,
                volumes: container.volumes,
            }));

            res.status(200).json(result);
        });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
};


exports.getContainerStats = async (req, res) => {
    try {
        const { containerId } = req.params;
        const container = docker.getContainer(containerId);

        const stream = await container.stats({ stream: false });

        // CPU Usage Calculation
        const cpuDelta = stream.cpu_stats.cpu_usage.total_usage - stream.precpu_stats.cpu_usage.total_usage;
        const systemDelta = stream.cpu_stats.system_cpu_usage - stream.precpu_stats.system_cpu_usage;
        const cpuUsage = systemDelta > 0 ? ((cpuDelta / systemDelta) * 100).toFixed(2) : 0;

        // Memory Usage Calculation
        const memoryUsage = ((stream.memory_stats.usage / stream.memory_stats.limit) * 100).toFixed(2);

        res.json({ cpuUsage, memoryUsage });
    } catch (error) {
        console.error(`Error fetching stats for container ${req.params.containerId}:`, error);
        res.status(500).json({ error: 'Failed to fetch container stats.' });
    }
};




exports.getContainerLogs = async (req, res) => {
    try {
        const { containerId } = req.params;
        const container = docker.getContainer(containerId);

        const logStream = await container.logs({
            follow: false,
            stdout: true,
            stderr: true,
            timestamps: true, // Include timestamps
            tail: 50, // Get last 50 lines
        });

        const logs = logStream.toString('utf-8'); 
        res.json({ logs });
    } catch (error) {
        console.error(`Error fetching logs for container ${req.params.containerId}:`, error);
        res.status(500).json({ error: 'Failed to fetch container logs.' });
    }
};
