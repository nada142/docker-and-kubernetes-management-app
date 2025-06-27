// models/KubernetesCluster.js
const mongoose = require('mongoose');

const nodeSchema = new mongoose.Schema({
  name: { type: String, required: true },
  role: { type: String, enum: ['control-plane', 'worker'], required: true },
  status: { type: String, enum: ['ready', 'not-ready', 'unknown'], default: 'unknown' },
  ip: { type: String, required: true },
  joinedAt: { type: Date, default: Date.now },
  lastSeen: { type: Date, default: Date.now },
          userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  
});

const kubernetesClusterSchema = new mongoose.Schema({
  clusterName: { type: String, required: true, unique: true },
  status: { type: String, default: 'creating' },
  joinCommand: { type: String },
  joinToken: { type: String },
  caHash: { type: String },
  tokenExpiration: { type: Date },
  nodes: [{
    vmId: { type: String },
    name: { type: String },
    ip: { type: String },
            userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    
    status: { type: String, enum: ['ready', 'joining', 'joined', 'error'] }
  }],
 
  kubeconfig: {  
    type: String,
    select: false 
  },
  pkiBackup: {  
    type: String,
    select: false
  },
          userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  
  
}, {
  timestamps: true
});

kubernetesClusterSchema.methods.saveState = async function(config) {
  this.kubeconfig = fs.readFileSync('/etc/kubernetes/admin.conf', 'utf-8');
  
  const pkiFiles = await execPromise('sudo tar czf - /etc/kubernetes/pki | base64 -w 0');
  this.pkiBackup = pkiFiles.stdout;
  
  this.status = 'running';
  this.lastInitialized = new Date();
  
  return this.save();
};

kubernetesClusterSchema.methods.restoreState = async function() {
  if (!this.kubeconfig || !this.pkiBackup) {
    throw new Error('No saved state to restore');
  }
  
  fs.writeFileSync('/etc/kubernetes/admin.conf', this.kubeconfig);
  await execPromise('sudo chmod 600 /etc/kubernetes/admin.conf');
  
  await execPromise(`echo '${this.pkiBackup}' | base64 -d | sudo tar xz -C /`);
  
  return { success: true };
};

module.exports = mongoose.model('KubernetesCluster', kubernetesClusterSchema);