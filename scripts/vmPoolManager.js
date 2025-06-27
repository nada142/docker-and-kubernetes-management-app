const { vSphere } = require('vmware-sdk');
const KubernetesCluster = require('../models/KubernetesCluster');
const fs = require('fs');

const vsphereConfig = {
  // ... your VMware config
};

const POOL_SIZE = 5; // Number of VMs to keep ready
const CHECK_INTERVAL = 300000; // 5 minutes

async function checkVMPool() {
  try {
    const client = new vSphere(vsphereConfig);
    
    // 1. Check current pool status
    const currentVMs = await client.getAllVMs('/k8s-pool');
    
    // 2. Power on any powered-off VMs
    for (const vm of currentVMs) {
      if (vm.runtime.powerState === 'poweredOff') {
        await vm.powerOn();
        console.log(`Powered on VM ${vm.name}`);
      }
    }
    
    // 3. Verify SSH access and Kubernetes readiness
    const availableVMs = [];
    for (const vm of currentVMs) {
      try {
        const ip = await vm.getIP();
        const ssh = new SSHClient({
          host: ip,
          username: 'kubeadmin',
          privateKey: fs.readFileSync(process.env.SSH_KEY_PATH)
        });
        
        await ssh.connect();
        const { stdout } = await ssh.exec('kubeadm version --short');
        await ssh.disconnect();
        
        availableVMs.push({
          vmId: vm.id,
          name: vm.name,
          ip,
          lastChecked: new Date(),
          kubeadmVersion: stdout.trim()
        });
      } catch (error) {
        console.error(`VM ${vm.name} failed health check:`, error.message);
      }
    }
    
    // 4. Maintain pool size
    if (availableVMs.length < POOL_SIZE) {
      const needed = POOL_SIZE - availableVMs.length;
      console.log(`Creating ${needed} new VMs for pool...`);
      
      for (let i = 0; i < needed; i++) {
        const vmName = `k8s-node-pool-${Date.now()}-${i}`;
        const vm = await client.cloneVM({
          name: vmName,
          template: vsphereConfig.template,
          resourcePool: vsphereConfig.cluster,
          datastore: vsphereConfig.datastore
        });
        
        await vm.powerOn();
        console.log(`Created new VM ${vmName}`);
      }
    }
    
    // Update global pool (in a real app, you'd use a proper shared state)
    vmPool.available = availableVMs;
    
  } catch (error) {
    console.error('Error in VM pool maintenance:', error);
  } finally {
    setTimeout(checkVMPool, CHECK_INTERVAL);
  }
}

// Start pool manager
checkVMPool();