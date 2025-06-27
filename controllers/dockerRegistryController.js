const DockerRegistry = require('../models/dockerRegistry');
const axios = require('axios');

exports.addDockerRegistry = async (req, res) => {
    const { name, url, username, password } = req.body;
    const userId = req.session.user._id;

    try {
        const newRegistry = await DockerRegistry.create({
            name,
            url,
            username,
            password,
            userId
        });

        res.status(201).json({ success: true, registry: newRegistry });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to add Docker registry', error: error.message });
    }
};

exports.getDockerRegistries = async (req, res) => {
    const userId = req.session.user._id;
    
    try {
        const registries = await DockerRegistry.find({ userId });
        res.status(200).json({ success: true, registries });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to fetch Docker registries', error: error.message });
    }
};


async function searchQuayImages(query, registry) {
    const graphqlUrl = 'https://quay.io/api/v1/graphql';
    const graphqlQuery = `
        query {
            searchRepositories(query: "${query}", first: 10) {
                edges {
                    node {
                        name
                    }
                }
            }
        }
    `;

    try {
        const response = await axios.post(graphqlUrl, {
            query: graphqlQuery,
        }, {
            headers: {
                Authorization: `Bearer ${registry.password}`,
            },
        });

        const images = response.data.data.searchRepositories.edges.map(edge => edge.node.name);
        return images;
    } catch (error) {
        console.error('Error searching Quay.io:', error);
        return [];
    }
}
exports.searchImages = async (req, res) => {
    const { registryId, query } = req.params;

    try {
        const registry = await DockerRegistry.findById(registryId);
        if (!registry) {
            return res.status(404).json({ success: false, message: 'Docker registry not found' });
        }

        let searchUrl;
        let response;

        // Handle Docker Hub
        if (registry.url.includes('docker.io') || registry.url.includes('hub.docker.com')) {
            searchUrl = `https://hub.docker.com/v2/search/repositories/?query=${query}`;
            response = await axios.get(searchUrl);
            const images = response.data.results.map(result => result.repo_name);
            return res.status(200).json({ success: true, images });
        }

        // Handle Quay.io (example)
        if (registry.url.includes('quay.io')) {
            const images = await searchQuayImages(query, registry);
            return res.status(200).json({ success: true, images });
        }
        // Handle GitHub Container Registry (GHCR)
        if (registry.url.includes('ghcr.io')) {
            // Use GitHub API to search for container images
            searchUrl = `https://api.github.com/search/code?q=${query}+in:path+extension:yaml+repo:${registry.username}/${registry.repo}`;
            response = await axios.get(searchUrl, {
                headers: {
                    Authorization: `Bearer ${registry.password}`,
                },
            });
            const images = response.data.items.map(item => item.name);
            return res.status(200).json({ success: true, images });
        }

     

        // Default case for other registries
        return res.status(200).json({ success: true, images: [] });
    } catch (error) {
        console.error('Error searching images:', error);
        res.status(500).json({ success: false, message: 'Failed to search images', error: error.message });
    }
};

exports.updateDockerRegistry = async (req, res) => {
    const { registryId } = req.params;
    const { name, url, username, password } = req.body;

    try {
        const updatedRegistry = await DockerRegistry.findByIdAndUpdate(
            registryId,
            { name, url, username, password },
            { new: true } 
        );

        if (!updatedRegistry) {
            return res.status(404).json({ success: false, message: 'Docker registry not found' });
        }

        res.status(200).json({ success: true, registry: updatedRegistry });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to update Docker registry', error: error.message });
    }
};


exports.deleteDockerRegistry = async (req, res) => {
    const { registryId } = req.params;

    try {
        const deletedRegistry = await DockerRegistry.findByIdAndDelete(registryId);

        if (!deletedRegistry) {
            return res.status(404).json({ success: false, message: 'Docker registry not found' });
        }

        res.status(200).json({ success: true, message: 'Docker registry deleted successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to delete Docker registry', error: error.message });
    }
};