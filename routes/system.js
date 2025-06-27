// routes/system.js
const express = require('express');
const router = express.Router();
const { exec } = require('child_process');
const os = require('os');
const disk = require('diskusage');

router.get('/status', async (req, res) => {
    try {
        const dockerStatus = await checkDockerStatus();
        
        const kubernetesStatus = await checkKubernetesStatus();
        
        res.json({
            docker: { status: dockerStatus },
            kubernetes: { status: kubernetesStatus },
            api: { status: 'OK' }
        });
    } catch (error) {
        console.error('Error checking system status:', error);
        res.status(500).json({ error: 'Failed to check system status' });
    }
});

router.get('/resources', async (req, res) => {
    try {
        const cpuUsage = await getCpuUsage();
        
        const totalMem = os.totalmem();
        const freeMem = os.freemem();
        const memoryUsage = ((totalMem - freeMem) / totalMem * 100).toFixed(1);
        
        // Disk usage
        const diskInfo = await disk.check('/');
        const diskUsage = (100 - (diskInfo.free / diskInfo.total * 100)).toFixed(1);
        
        res.json({
            cpu: cpuUsage,
            memory: memoryUsage,
            disk: diskUsage
        });
    } catch (error) {
        console.error('Error fetching system resources:', error);
        res.status(500).json({ error: 'Failed to fetch system resources' });
    }
});

async function checkDockerStatus() {
    return new Promise((resolve) => {
        exec('docker ps', (error) => {
            resolve(error ? 'Not Running' : 'Running');
        });
    });
}

async function checkKubernetesStatus() {
    return new Promise((resolve) => {
        exec('kubectl cluster-info', (error) => {
            resolve(error ? 'Not Running' : 'Running');
        });
    });
}

async function getCpuUsage() {
    return new Promise((resolve) => {
        const start = os.cpus();
        setTimeout(() => {
            const end = os.cpus();
            let totalIdle = 0, totalTick = 0;
            
            for (let i = 0; i < start.length; i++) {
                const startCpu = start[i];
                const endCpu = end[i];
                
                for (let type in startCpu.times) {
                    totalIdle += endCpu.times[type] - startCpu.times[type];
                }
                totalTick += endCpu.times.user - startCpu.times.user;
                totalTick += endCpu.times.nice - startCpu.times.nice;
                totalTick += endCpu.times.sys - startCpu.times.sys;
                totalTick += endCpu.times.idle - startCpu.times.idle;
                totalTick += endCpu.times.irq - startCpu.times.irq;
            }
            
            const usage = (100 - (100 * totalIdle / totalTick)).toFixed(1);
            resolve(usage);
        }, 1000);
    });
}

module.exports = router;