const Docker = require('dockerode');
const docker = new Docker({ socketPath: '/var/run/docker.sock' });
const Volume = require('../models/Volume');



const verifyVolumeOwnership = async (volumeName, userId) => {
    const volume = await Volume.findOne({ name: volumeName, userId });
    if (!volume) throw new Error('Volume not found or access denied');
    return volume;
};

exports.listVolumes = async (req, res) => {
    try {
        const userId = req.session.user._id;
        
        // Get volumes from Docker
        const dockerVolumes = await docker.listVolumes();
        
        // Get volumes from database for this user
        const userVolumes = await Volume.find({ userId });
        
        // Filter Docker volumes to only owned by the user
        const userVolumeNames = userVolumes.map(v => v.name);
        const filteredVolumes = dockerVolumes.Volumes.filter(v => 
            userVolumeNames.includes(v.Name)
        );

        // Sync database
        await Promise.all(userVolumes.map(async dbVolume => {
            const existsInDocker = dockerVolumes.Volumes.some(v => v.Name === dbVolume.name);
            if (!existsInDocker) {
                await Volume.deleteOne({ _id: dbVolume._id });
            }
        }));

        res.status(200).json(filteredVolumes);
    } catch (error) {
        console.error('Error listing volumes:', error);
        res.status(500).json({ 
            message: 'Error listing volumes',
            error: error.message 
        });
    }
};



// Create a new Docker volume
exports.createVolume = async (req, res) => {
    const { name, driver, options, labels } = req.body;
    const userId = req.session.user._id;

    try {
        // Check if volume already exists in database
        const existingVolume = await Volume.findOne({ name, userId });
        if (existingVolume) {
            return res.status(400).json({ message: 'Volume with this name already exists' });
        }

        // Create in Docker
        const volume = await docker.createVolume({
            Name: name,
            Driver: driver || 'local',
            DriverOpts: options || {},
            Labels: { ...(labels || {}), user: userId.toString() }
        });

        // Save to database
        const newVolume = new Volume({
            name,
            driver: driver || 'local',
            options: options || {},
            labels: labels || {},
            userId
        });
        await newVolume.save();

        res.status(201).json({ message: 'Volume created successfully', volume });
    } catch (error) {
        res.status(500).json({ message: 'Error creating volume', error: error.message });
    }
};

// Delete a Docker volume
exports.deleteVolume = async (req, res) => {
    const { name } = req.params;
    const userId = req.session.user._id;

    try {
        // Verify ownership
        await verifyVolumeOwnership(name, userId);
        
        // Check if volume is in use
        const containers = await docker.listContainers({ all: true });
        const usingContainers = containers.filter(container => {
            return container.Mounts.some(mount => mount.Name === name);
        });

        if (usingContainers.length > 0) {
            const containerNames = usingContainers.map(c => c.Names[0]).join(', ');
            return res.status(400).json({
                message: `Volume is in use by: ${containerNames}`
            });
        }

        // Delete from Docker
        const volume = docker.getVolume(name);
        await volume.remove();
        
        // Delete from database
        await Volume.deleteOne({ name, userId });

        res.status(200).json({ message: 'Volume deleted successfully' });
    } catch (error) {
        res.status(500).json({ message: 'Error deleting volume', error: error.message });
    }
};

exports.inspectVolume = async (req, res) => {
    const { name } = req.params;

    try {
        const volume = docker.getVolume(name);
        const details = await volume.inspect();

        // Add usage statistics
        const usageStats = {
            size: details.UsageData?.Size || 'N/A',
            refCount: details.UsageData?.RefCount || 'N/A',
        };

        res.status(200).json({ ...details, usageStats });
    } catch (error) {
        console.error('Error inspecting Docker volume:', error);
        res.status(500).json({ message: 'Error inspecting Docker volume', error: error.message });
    }
};

exports.pruneVolumes = async (req, res) => {
    try {
        const result = await docker.pruneVolumes();
        res.status(200).json({ message: 'Unused volumes pruned successfully', result });
    } catch (error) {
        console.error('Error pruning Docker volumes:', error);
        res.status(500).json({ message: 'Error pruning Docker volumes', error: error.message });
    }
};
