// utils/swarmStateManager.js
const Docker = require('dockerode');
const docker = new Docker({ socketPath: '/var/run/docker.sock' });
const SwarmSession = require('../models/SwarmSession');
const SwarmStack = require('../models/SwarmStack');

async function restoreSwarmState(userId) {
    try {
        const session = await SwarmSession.findOne({ userId });
        if (!session) return;

        // Initialize swarm if not already active
        let swarmInfo;
        try {
            swarmInfo = await docker.swarmInspect();
        } catch (error) {
            if (error.statusCode === 503) {
                // Swarm not initialized
                await initializeSwarm();
                swarmInfo = await docker.swarmInspect();
            } else {
                throw error;
            }
        }

        // Restore nodes
        for (const node of session.nodes) {
            try {
                if (node.role === 'manager') {
                    await addManagerNode(node.ip, node.joinToken);
                } else {
                    await addWorkerNode(node.ip, node.joinToken);
                }
            } catch (error) {
                console.error(`Error restoring node ${node.hostname}:`, error);
            }
        }

        // Restore stacks
        const stacks = await SwarmStack.find({ userId });
        for (const stack of stacks) {
            try {
                await deployStackFromSession(stack);
            } catch (error) {
                console.error(`Error restoring stack ${stack.name}:`, error);
            }
        }

        // Update session
        session.active = true;
        await session.save();

    } catch (error) {
        console.error('Error restoring swarm state:', error);
        throw error;
    }
}

async function initializeSwarm() {
    return new Promise((resolve, reject) => {
        exec('docker swarm init --advertise-addr 127.0.0.1', (error, stdout, stderr) => {
            if (error) return reject(error);
            resolve(stdout);
        });
    });
}

async function addManagerNode(ip, token) {
    return new Promise((resolve, reject) => {
        exec(`docker swarm join --token ${token} ${ip}:2377`, (error, stdout, stderr) => {
            if (error) return reject(error);
            resolve(stdout);
        });
    });
}

async function addWorkerNode(ip, token) {
    return new Promise((resolve, reject) => {
        exec(`docker swarm join --token ${token} ${ip}:2377`, (error, stdout, stderr) => {
            if (error) return reject(error);
            resolve(stdout);
        });
    });
}

async function deployStackFromSession(stack) {
    const tempFilePath = `/tmp/${stack.name}-docker-compose.yml`;
    fs.writeFileSync(tempFilePath, stack.yamlContent);
    
    return new Promise((resolve, reject) => {
        exec(`docker stack deploy -c ${tempFilePath} ${stack.name}`, (error, stdout, stderr) => {
            fs.unlinkSync(tempFilePath);
            if (error) return reject(error);
            resolve(stdout);
        });
    });
}

module.exports = { restoreSwarmState };