const DockerImage = require('../models/Image');
const { exec } = require('child_process');
const Docker = require('dockerode');
const DockerRegistry = require('../models/dockerRegistry');

const Container = require('../models/Container');


const docker = new Docker({ socketPath: '/var/run/docker.sock' });

const verifyImageOwnership = async (imageId, userId) => {
    const image = await DockerImage.findOne({ _id: imageId, userId });
    if (!image) throw new Error('Image not found or access denied');
    return image;
};

// List all images for current user
exports.listImages = async (req, res) => {
    try {
        const images = await DockerImage.find({ userId: req.session.user._id })
            .select('name imageId dockerfileId tags dateOfCreation');
        res.status(200).json(images);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
};


// Pull an image
exports.pullImage = async (req, res) => {
    try {
        const { name } = req.body;

        exec(`docker pull ${name}`, (error, stdout, stderr) => {
            if (error) {
                return res.status(500).json({ error: error.message });
            }
            res.status(200).json({ message: stdout });
        });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
};
exports.pullImageFromRegistry = async (req, res) => {
    const { imageName, tag, registryId } = req.body;

    try {
        const registry = await DockerRegistry.findOne({ 
            _id: registryId, 
            userId: req.session.user._id 
        });
        if (!registry) {
            return res.status(404).json({ type: 'error', message: 'Registry not found or access denied' });
        }

        let fullImageName;
        if (registry.url === 'docker.io') {
           
            fullImageName = `${imageName}:${tag}`;
        } else {
            // For other registries, the format is <registry.url>/<image>:<tag>
            fullImageName = `${registry.url}/${imageName}:${tag}`;
        }

        console.log(`Pulling image: ${fullImageName}`); 

        // Authenticate with the registry
        const authConfig = {
            username: registry.username,
            password: registry.password,
        };

        // Pull the image
        const stream = await docker.pull(fullImageName, { authconfig: authConfig });

        await new Promise((resolve, reject) => {
            docker.modem.followProgress(stream, (err, result) => {
                if (err) {
                    return reject(new Error(`Docker pull failed: ${err.message}`));
                }
                resolve(result);
            });
        });

        // Inspect the pulled image to get the image ID
        const image = docker.getImage(fullImageName);
        const imageDetails = await image.inspect();
        const imageId = imageDetails.Id;

        // Save the pulled image to the database
        const newImage = new DockerImage({
            name: imageName,
            imageId: imageId,
            tags: [tag], 
            dateOfCreation: new Date(),
            userId: req.session.user._id  

        });

        await newImage.save();

        res.status(201).json({ type: 'success', message: 'Docker image pulled and saved successfully', imageId });
    } catch (error) {
        console.error('Error pulling Docker image:', error);
        res.status(500).json({ type: 'error', message: error.message });
    }
};


exports.pushImage = async (req, res) => {
    const imageName = req.params.name; 
    const { registryId } = req.body;

    try {
        const registry = await DockerRegistry.findById(registryId);
        if (!registry) {
            return res.status(404).json({ success: false, message: 'Docker registry not found' });
        }

        let fullImageName;
        if (registry.url === 'docker.io') {
            // For Docker Hub, the format is <username>/<repository>:<tag>
            fullImageName = `${registry.username}/${imageName}`; 
        } else {
            // For other registries, the format is <registry.url>/<repository>:<tag>
            fullImageName = `${registry.url}/${imageName}:latest`;
        }

        console.log(`Pushing image: ${fullImageName}`); 

        const image = docker.getImage(imageName);

        await new Promise((resolve, reject) => {
            image.tag({ repo: fullImageName.split(':')[0], tag: 'latest' }, (err) => {
                if (err) {
                    return reject(new Error(`Docker tag failed: ${err.message}`));
                }
                resolve();
            });
        });

        // Push the tagged image to the registry
        const authConfig = {
            username: registry.username,
            password: registry.password,
        };

        const taggedImage = docker.getImage(fullImageName);
        await new Promise((resolve, reject) => {
            taggedImage.push({ authconfig: authConfig }, (err, stream) => {
                if (err) {
                    return reject(new Error(`Docker push failed: ${err.message}`));
                }

                let errorOccurred = false;
                stream.on('data', (chunk) => {
                    const parsedData = JSON.parse(chunk.toString());
                    if (parsedData.error) {
                        errorOccurred = true;
                        reject(new Error(`Docker push failed: ${parsedData.error}`));
                    }
                });

                stream.on('end', () => {
                    if (!errorOccurred) {
                        console.log('Image pushed successfully'); 
                        resolve();
                    }
                });
            });
        });

        res.status(200).json({ success: true, message: "Docker image pushed successfully" });
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};




exports.deleteImage = async (req, res) => {
    try {
        //  Verify ownership and get image document
        const image = await verifyImageOwnership(req.params.id, req.session.user._id);
        
        //  Check if image is used by any running containers
        const containers = await docker.listContainers({ all: true });
        const containersUsingImage = containers.filter(container => 
            container.ImageID.includes(image.imageId) || 
            container.Image === image.name
        );

        if (containersUsingImage.length > 0) {
            const containerNames = containersUsingImage.map(c => c.Names[0]).join(', ');
            return res.status(409).json({ 
                error: `Cannot delete image - it's being used by these containers: ${containerNames}. Stop the containers first.`
            });
        }

        // Attempt to delete the Docker image
        try {
            await docker.getImage(image.imageId).remove({ force: true });
        } catch (dockerError) {
            // Handle  Docker errors
            if (dockerError.statusCode === 409) {
                return res.status(409).json({
                    error: 'Cannot delete image - it has dependent child images or is being used'
                });
            }
            throw dockerError;
        }

        //  Delete from MongoDB
        await DockerImage.findByIdAndDelete(req.params.id);

        res.status(200).json({ 
            message: 'Docker image deleted successfully',
            deletedImage: image.name
        });
    } catch (error) {
        console.error('Error deleting image:', error);
        
        if (error.message.includes('not found or access denied')) {
            res.status(404).json({ error: error.message });
        } else if (error.message.includes('no such image')) {
            res.status(404).json({ error: 'Image not found in Docker' });
        } else {
            res.status(500).json({ 
                error: error.message || 'Failed to delete image',
                details: error.reason || 'Unknown error occurred'
            });
        }
    }
};






// Run an image
exports.runImage = async (req, res) => {
    try {
        const { id } = req.params;

        const dockerImage = await DockerImage.findOne({ imageId: id });
        if (!dockerImage) {
            return res.status(404).json({ error: 'Image not found' });
        }

        let sanitizedImageName = dockerImage.name.toLowerCase().replace(/[^a-z0-9]/g, '-');
        sanitizedImageName = sanitizedImageName.replace(/^-+|-+$/g, '');
        const containerName = `${sanitizedImageName}-${Date.now()}`;
        
        exec(`docker run -d --name ${containerName} ${dockerImage.name}`, async (error, stdout, stderr) => {
            if (error) {
                console.error('Docker run error:', error.message); 
                return res.status(500).json({ error: error.message });
            }

            try {
                const container = new Container({
                    name: containerName,
                    status: 'running',
                    dockerImage: dockerImage._id,
                    containerId: stdout.trim(), 
                });

                await container.save();
                res.status(200).json({ message: 'Container started and saved successfully', container });
            } catch (saveError) {
                console.error('Error saving container to database:', saveError.message);
                res.status(500).json({ error: 'Failed to save container to the database' });
            }
        });
    } catch (error) {
        console.error('General error:', error.message);
        res.status(400).json({ error: error.message });
    }
};


// Get status of an image
exports.getStatus = async (req, res) => {
    try {
        const { id } = req.params;

        exec(`docker images ${id}`, (error, stdout, stderr) => {
            if (error) {
                return res.status(500).json({ error: error.message });
            }
            res.status(200).json({ status: stdout });
        });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
};

const DockerFile = require('../models/dockerfilee');
const Image = require('../models/Image'); 
const mongoose = require('mongoose');

exports.getDockerFile = async (req, res) => {
    try {
        const { imageId } = req.params;

        if (!mongoose.Types.ObjectId.isValid(imageId)) {
            return res.status(400).json({ message: 'Invalid image ID' });
        }

        const image = await Image.findById(imageId);
        if (!image) {
            return res.status(404).json({ message: 'Image not found' });
        }

        res.json({
            name: image.name,
            content: image.dockerfileContent
        });
    } catch (error) {
        console.error('Error fetching Dockerfile content:', error);
        res.status(500).json({ message: 'Server error' });
    }
};




exports.getImageById = async (req, res) => {
    try {
        const { id } = req.params;  
        console.log(`Received imageId: ${id}`);

        const images = await docker.listImages({ all: true });

        const image = images.find(img => img.Id.includes(id));

        if (!image) {
            return res.status(404).json({ message: 'Image not found' });
        }

        const imageDetails = await docker.getImage(image.Id).inspect();
        res.json(imageDetails);
    } catch (error) {
        console.error('Error fetching image by ID:', error);
        res.status(500).json({ message: 'Server error' });
    }
};




// Prune unused Docker images and synchronize the database
exports.pruneImages = async (req, res) => {
    try {
        //  Prune unused Docker images
        const pruneResult = await docker.pruneImages({
            filters: {
                dangling: { 'true': true }
            }
        });

        //  Get the list of remaining images in Docker
        const dockerImages = await docker.listImages({ all: true });
        const dockerImageIds = dockerImages.map(image => image.Id);

        // Get all images from the database
        const dbImages = await Image.find({});

        const imagesToDelete = dbImages.filter(dbImage => {
            return !dockerImageIds.some(dockerId => dockerId.includes(dbImage.imageId));
        });

        for (const image of imagesToDelete) {
            await Image.deleteOne({ imageId: image.imageId });
        }

        res.status(200).json({
            message: 'Unused Docker images pruned successfully and database synchronized',
            data: {
                pruneResult,
                deletedFromDB: imagesToDelete.length
            }
        });
    } catch (error) {
        console.error('Error pruning Docker images:', error);
        res.status(500).json({ error: 'Failed to prune Docker images' });
    }
};
    



