// controllers/kubernetesController.js
const { exec } = require('child_process');
const fs = require('fs');
const axios = require('axios');
const KubernetesCluster = require('../models/KubernetesCluster');
const net = require('net');
const util = require('util');
const execPromise = util.promisify(exec);
const os = require('os');
const userHome = os.homedir();
const userName = os.userInfo().username;
const yaml = require('js-yaml');
const http = require('http');
const https = require('https');
const anomalyStore = [];

const getNodeIP = async () => {
  try {
    //  get the primary network interface IP
    const { stdout } = await execPromise("hostname -I | awk '{print $1}'");
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
exports.checkClusterState = async (req, res) => {
    try {
        
        const kubeconfigExists = fs.existsSync('/etc/kubernetes/admin.conf');
        
        if (!kubeconfigExists) {
            return res.json({ clusterExists: false });
        }

        const { stdout: components } = await execPromise('kubectl get pods -n kube-system');
        const controlPlaneRunning = components.includes('kube-apiserver') && 
                                  components.includes('kube-controller-manager') && 
                                  components.includes('kube-scheduler');

        res.json({ 
            clusterExists: true,
            controlPlaneRunning,
            components: components.split('\n').filter(line => line.trim() !== '')
        });
    } catch (error) {
        res.json({ 
            clusterExists: false,
            error: error.message
        });
    }
};

exports.restoreCluster = async (req, res) => {
    try {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();

        const sendEvent = (message, type = 'info') => {
            res.write(`data: ${JSON.stringify({message, type})}\n\n`);
        };

        sendEvent('Starting comprehensive cluster restoration...');

        // 1. Start base services
        sendEvent('Starting container runtime...');
        await execPromise('sudo systemctl start containerd');
        
        sendEvent('Starting kubelet...');
        await execPromise('sudo systemctl start kubelet');

        if (fs.existsSync('/etc/kubernetes/admin.conf')) {
            sendEvent('Found existing cluster configuration - restoring...');
            
            sendEvent('Restarting control plane...');
            await execPromise('sudo systemctl restart kube-apiserver kube-controller-manager kube-scheduler');
            
            sendEvent('Waiting for API server...');
            let apiReady = false;
            for (let i = 0; i < 10; i++) {
                try {
                    await execPromise('kubectl --kubeconfig=/etc/kubernetes/admin.conf get nodes');
                    apiReady = true;
                    break;
                } catch (e) {
                    await new Promise(resolve => setTimeout(resolve, 5000));
                }
            }
            
            if (!apiReady) {
                throw new Error('API server did not become ready');
            }
            
            // Restart networking
            sendEvent('Restarting network components...');
            await execPromise('kubectl --kubeconfig=/etc/kubernetes/admin.conf rollout restart daemonset -n kube-system');
            
            // Restart CoreDNS
            sendEvent('Restarting DNS...');
            await execPromise('kubectl --kubeconfig=/etc/kubernetes/admin.conf rollout restart deployment coredns -n kube-system');
            
            // Wait for system pods
            sendEvent('Waiting for system pods...');
            await execPromise('kubectl --kubeconfig=/etc/kubernetes/admin.conf wait --for=condition=Ready pods --all -n kube-system --timeout=300s');
            
            sendEvent('Cluster restored successfully!', 'success');
        } else {
            sendEvent('No existing cluster configuration found', 'warning');
        }
        
        res.end();
    } catch (error) {
        sendEvent(`Error restoring cluster: ${error.message}`, 'error');
        res.end();
    }
};

exports.restoreFromDB = async (req, res) => {
    try {
        const { clusterName } = req.params;
        const cluster = await KubernetesCluster.findOne({ clusterName });
        
        if (!cluster) {
            return res.status(404).json({ message: 'Cluster not found in database' });
        }

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();

        const sendEvent = (message, type = 'info') => {
            res.write(`data: ${JSON.stringify({message, type})}\n\n`);
        };

        sendEvent(`Restoring cluster ${clusterName} from database...`);
        
        //  Restore files from DB
        await cluster.restoreState();
        sendEvent('Configuration files restored');
        
        // Start services
        await execPromise('sudo systemctl start containerd kubelet');
        sendEvent('Services started');
        
        //  Restart control plane
        await execPromise('sudo systemctl restart kube-apiserver kube-controller-manager kube-scheduler');
        sendEvent('Control plane restarted');
        
        // Verify
        const { stdout: nodes } = await execPromise('kubectl get nodes');
        sendEvent(nodes, 'stdout');
        
        cluster.status = 'running';
        await cluster.save();
        
        sendEvent('Cluster restored successfully!', 'success');
        res.end();
    } catch (error) {
        if (!res.headersSent) {
            res.status(500).json({ 
                message: 'Cluster restoration failed',
                error: error.message
            });
        }
    }
};

exports.initializeCluster = async (req, res) => {
    const sendEvent = (message, type = 'info') => {
        res.write(`data: ${JSON.stringify({message, type})}\n\n`);
    };

    let cluster; 

    try {
        const { clusterName, enableMonitoring } = req.query;
        
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();

        const nodeIP = await getNodeIP();
        sendEvent(`🌐 Detected node IP address: ${nodeIP}`);

        // Create cluster record
        cluster = new KubernetesCluster({ 
            clusterName, 
            status: 'initializing',
            nodeIP // Store the IP in the cluster record
        });
        await cluster.save();

        sendEvent('🚀 Starting Kubernetes cluster initialization...');
        sendEvent(`🔧 Cluster Name: ${clusterName}`);
        sendEvent(`📊 Monitoring: ${enableMonitoring ? 'Enabled' : 'Disabled'}`);

        // 1. Reset any existing cluster
        sendEvent('🔄 Resetting any existing cluster...');
        try {
            await execPromise('sudo kubeadm reset -f');
            sendEvent('✅ Cluster reset completed', 'success');
        } catch (error) {
            sendEvent(`⚠️ Warning: Reset encountered issues: ${error.message}`, 'warning');
        }

        // 2. Clean up Kubernetes directories with delay
        sendEvent('🧹 Cleaning up Kubernetes directories...');
        await new Promise(resolve => setTimeout(resolve, 1000)); 
        
        const cleanupCommands = [
            'sudo rm -rf /etc/cni/net.d',
            'sudo rm -rf $HOME/.kube',
            'sudo rm -rf /var/lib/etcd',
            'sudo rm -rf /var/lib/kubelet',
            'sudo rm -rf /etc/kubernetes',
            'sudo rm -rf /var/lib/cni/'
        ];

        for (const cmd of cleanupCommands) {
            try {
                await execPromise(cmd);
            } catch (error) {
                sendEvent(`⚠️ Could not remove ${cmd.split(' ')[3]}: ${error.message}`, 'warning');
            }
            await new Promise(resolve => setTimeout(resolve, 500)); 
        }
        sendEvent('✅ Directory cleanup completed', 'success');

        // 3. Stop and disable kubelet temporarily
        sendEvent('⏹️ Stopping kubelet service...');
        await execPromise('sudo systemctl stop kubelet');
        await execPromise('sudo systemctl disable kubelet');
        sendEvent('✅ Kubelet stopped and disabled', 'success');

        // 4. Disable swap with delay
        sendEvent('🔀 Disabling swap...');
        await new Promise(resolve => setTimeout(resolve, 1000));
        await execPromise('sudo swapoff -a');
        await execPromise('sudo sed -i \'/ swap / s/^/#/\' /etc/fstab');
        sendEvent('✅ Swap disabled successfully', 'success');

        // 5. Configure system settings with delay
        sendEvent('🔧 Configuring system kernel modules and network settings...');
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        try {
            await execPromise(`cat <<EOF | sudo tee /etc/modules-load.d/k8s.conf
br_netfilter
EOF`);

            await execPromise(`cat <<EOF | sudo tee /etc/sysctl.d/k8s.conf
net.bridge.bridge-nf-call-iptables  = 1
net.ipv4.ip_forward                 = 1
net.bridge.bridge-nf-call-ip6tables = 1
EOF`);

            await execPromise('sudo modprobe br_netfilter');
            await execPromise('sudo sysctl --system');
            
            sendEvent('✅ Kernel modules and network settings configured', 'success');
        } catch (error) {
            sendEvent(`❌ Failed to configure system settings: ${error.message}`, 'error');
            throw error;
        }
        sendEvent('🔧 Configuring containerd...');
        try {
            await execPromise('sudo mkdir -p /etc/containerd');
            await execPromise('containerd config default | sudo tee /etc/containerd/config.toml');
            await execPromise('sudo sed -i \'s/SystemdCgroup = false/SystemdCgroup = true/\' /etc/containerd/config.toml');
            await execPromise('sudo systemctl restart containerd');
            await execPromise('sudo systemctl enable containerd');
            sendEvent('✅ Containerd configured successfully', 'success');
        } catch (error) {
            sendEvent(`❌ Containerd configuration failed: ${error.message}`, 'error');
            throw error;
        }
        // 6. Initialize the cluster 
        sendEvent('⚙️ Initializing new Kubernetes cluster...');
const initCommand = `sudo kubeadm init --pod-network-cidr=192.168.0.0/16 --apiserver-advertise-address=${nodeIP}`;        
        const child = exec(initCommand);
        let initOutput = '';

        child.stdout.on('data', (data) => {
            initOutput += data;
            sendEvent(data.toString(), 'stdout');
        });

        child.stderr.on('data', (data) => {
            initOutput += data;
            sendEvent(data.toString(), 'stderr');
        });

        await new Promise((resolve, reject) => {
            child.on('close', (code) => {
                if (code === 0) {
                    resolve();
                } else {
                    reject(new Error(`Cluster initialization failed with code ${code}\n${initOutput}`));
                }
            });
        });

        sendEvent('🎉 Cluster initialized successfully! Configuring kubectl...', 'success');
        
        // 7. Configure kubectl with delays between steps
        sendEvent('⚙️ Configuring kubectl access...');
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        try {
            await execPromise('mkdir -p $HOME/.kube');
            await execPromise('sudo cp -i /etc/kubernetes/admin.conf $HOME/.kube/config');
            await execPromise('sudo chown $(id -u):$(id -g) $HOME/.kube/config');
            
            const nodeUser = process.env.USER || 'ubuntu';
            await execPromise(`sudo mkdir -p /home/${nodeUser}/.kube`);
            await execPromise(`sudo cp /etc/kubernetes/admin.conf /home/${nodeUser}/.kube/config`);
            await execPromise(`sudo chown ${nodeUser}:${nodeUser} /home/${nodeUser}/.kube/config`);
            
            sendEvent('✅ Kubectl configured successfully!', 'success');
            
            // 8. Wait for API server with timeout
            sendEvent('⏳ Waiting for API server to be ready...');
        let apiReady = false;
        let lastApiError = '';
        for (let i = 0; i < 30; i++) { 
            try {
                await execPromise('kubectl cluster-info');
                apiReady = true;
                break;
            } catch (e) {
                lastApiError = e.message;
               
                try {
                    const { stdout: apiLogs } = await execPromise('sudo journalctl -u kube-apiserver -n 10 --no-pager');
                    sendEvent(`API Server logs (attempt ${i+1}):\n${apiLogs}`, 'debug');
                } catch (logError) {
                    sendEvent(`⚠️ Could not get API server logs: ${logError.message}`, 'warning');
                }
                await new Promise(resolve => setTimeout(resolve, 10000)); 
            }
        }

        if (!apiReady) {
            throw new Error(`API server did not become ready after 30 attempts. Last error: ${lastApiError}`);
        }
            
            // 9. Start kubelet with delay
            sendEvent('🔌 Enabling and starting kubelet service...');
            await new Promise(resolve => setTimeout(resolve, 1000));
            await execPromise('sudo systemctl enable kubelet');
            await execPromise('sudo systemctl start kubelet');
            
            // 10. Install network plugin with retries and delays
            sendEvent('🌐 Installing Calico network plugin...');
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            try {
                await execPromise('kubectl apply -f https://raw.githubusercontent.com/projectcalico/calico/v3.27.0/manifests/calico.yaml');
                
                sendEvent('⏳ Waiting for Calico to initialize (30 seconds)...');
                await new Promise(resolve => setTimeout(resolve, 30000));
                
                sendEvent('🔁 Force restarting kubelet after CNI installation...');
                await execPromise('sudo systemctl restart kubelet');
                
                sendEvent('✅ Calico installed and kubelet restarted', 'success');
            } catch (error) {
                sendEvent(`❌ Calico installation failed: ${error.message}`, 'error');
                throw error;
            }

            // 11. Allow scheduling on control plane
            sendEvent('⚙️ Configuring node taints...');
        await new Promise(resolve => setTimeout(resolve, 15000)); 
        
        try {
            // Remove control plane taint
            await execPromise('kubectl taint nodes --all node-role.kubernetes.io/control-plane-');
            sendEvent('✅ Removed control plane taint', 'success');
            
            try {
                const { stdout: nodesJson } = await execPromise('kubectl get nodes -o json');
                const nodes = JSON.parse(nodesJson);
                
                for (const node of nodes.items) {
                    if (node.spec?.taints?.some(t => t.key === 'node.kubernetes.io/not-ready')) {
                        await execPromise(`kubectl taint nodes ${node.metadata.name} node.kubernetes.io/not-ready:NoSchedule-`);
                        sendEvent(`✅ Removed not-ready taint from ${node.metadata.name}`, 'success');
                    }
                }
            } catch (taintError) {
                sendEvent(`⚠️ Could not check/remove not-ready taint: ${taintError.message}`, 'warning');
            }
            
            // Verify node status
            const { stdout: nodeStatus } = await execPromise('kubectl get nodes');
            sendEvent(`Final node status:\n${nodeStatus}`, 'info');
        } catch (error) {
            sendEvent(`⚠️ Node taint configuration encountered issues: ${error.message}`, 'warning');
        }
            // 12. Verify network with delay
            sendEvent('🔍 Verifying network connectivity...');
            await new Promise(resolve => setTimeout(resolve, 10000));
            await execPromise('kubectl get pods --all-namespaces');
            
            // 13. Install monitoring if enabled
            if (enableMonitoring === 'true') {
                await installMonitoringStack(sendEvent);
            }
            
            // 14. Generate and store join token
            sendEvent('🔑 Generating persistent join token...');
            const { stdout: joinCommand } = await execPromise('kubeadm token create --print-join-command --ttl 0');
            const token = joinCommand.match(/--token (\S+)/)[1];
            const caHash = joinCommand.match(/--discovery-token-ca-cert-hash (\S+)/)[1];
        
            // Update cluster with join information
            cluster.joinCommand = joinCommand.trim();
            cluster.joinToken = token;
            cluster.caHash = caHash;
            cluster.tokenExpiration = new Date(Date.now() + 8760 * 60 * 60 * 1000); 
            cluster.status = 'running';
            await cluster.save();
        
            sendEvent('✅ Cluster initialized and join token stored', 'success');
        } catch (error) {
            sendEvent(`❌ Error in post-init configuration: ${error.message}`, 'error');
            throw error;
        }
    } catch (error) {
        sendEvent(`❌ Cluster initialization failed: ${error.message}`, 'error');
        
        // Update cluster status to failed
        if (cluster) {
            cluster.status = 'failed';
            cluster.error = error.message;
            await cluster.save();
        }
        
        res.end();
    }
};

async function installMonitoringStack(sendEvent) {
    try {
        sendEvent('📊 Starting monitoring stack installation...');

        // 1. Create monitoring namespace
        sendEvent('📁 Creating monitoring namespace...');
        await execPromise('kubectl create namespace monitoring --dry-run=client -o yaml | kubectl apply -f -');

        // 2. Install Prometheus with manual YAML approach
        sendEvent('🔧 Installing Prometheus...');

await execPromise(`cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: ConfigMap
metadata:
  name: prometheus-config
  namespace: monitoring
data:
  prometheus.yml: |
    global:
      scrape_interval: 15s
      evaluation_interval: 15s
    scrape_configs:
      - job_name: 'kubernetes-apiservers'
        kubernetes_sd_configs:
        - role: endpoints
        scheme: https
        tls_config:
          ca_file: /var/run/secrets/kubernetes.io/serviceaccount/ca.crt
        bearer_token_file: /var/run/secrets/kubernetes.io/serviceaccount/token
        relabel_configs:
        - source_labels: [__meta_kubernetes_namespace, __meta_kubernetes_service_name, __meta_kubernetes_endpoint_port_name]
          action: keep
          regex: default;kubernetes;https
      - job_name: 'kubernetes-nodes'
        scheme: https
        tls_config:
          insecure_skip_verify: true 
        kubernetes_sd_configs:
        - role: node
        relabel_configs:
        - source_labels: [__address__]
          regex: '(.*):10250'
          replacement: '${1}:10250'
          target_label: __address__
        - action: labelmap
          regex: __meta_kubernetes_node_label_(.+)
      - job_name: 'kubernetes-pods'
        kubernetes_sd_configs:
        - role: pod
        relabel_configs:
        - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_scrape]
          action: keep
          regex: true
        - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_path]
          action: replace
          target_label: __metrics_path__
          regex: (.+)
        - source_labels: [__address__, __meta_kubernetes_pod_annotation_prometheus_io_port]
          action: replace
          regex: ([^:]+)(?::\\d+)?;(\\d+)
          replacement: \$1:\$2
          target_label: __address__
        - action: labelmap
          regex: __meta_kubernetes_pod_label_(.+)
        - source_labels: [__meta_kubernetes_namespace]
          action: replace
          target_label: kubernetes_namespace
        - source_labels: [__meta_kubernetes_pod_name]
          action: replace
          target_label: kubernetes_pod_name
EOF`);
        // Prometheus RBAC
        await execPromise(`cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: ServiceAccount
metadata:
  name: prometheus
  namespace: monitoring
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: prometheus
rules:
- apiGroups: [""]
  resources:
  - nodes
  - nodes/proxy
  - services
  - endpoints
  - pods
  verbs: ["get", "list", "watch"]
- apiGroups: ["extensions", "networking.k8s.io"]
  resources:
  - ingresses
  verbs: ["get", "list", "watch"]
- nonResourceURLs: ["/metrics"]
  verbs: ["get"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: prometheus
subjects:
- kind: ServiceAccount
  name: prometheus
  namespace: monitoring
roleRef:
  kind: ClusterRole
  name: prometheus
  apiGroup: rbac.authorization.k8s.io
EOF`);

        // Prometheus Deployment
        await execPromise(`cat <<EOF | kubectl apply -f -
apiVersion: apps/v1
kind: Deployment
metadata:
  name: prometheus
  namespace: monitoring
spec:
  replicas: 1
  selector:
    matchLabels:
      app: prometheus
  template:
    metadata:
      labels:
        app: prometheus
    spec:
      serviceAccountName: prometheus
      containers:
      - name: prometheus
        image: prom/prometheus:v2.47.0
        args:
        - "--config.file=/etc/prometheus/prometheus.yml"
        - "--storage.tsdb.path=/prometheus"
        - '--web.listen-address=0.0.0.0:9090'
        ports:
        - containerPort: 9090
        volumeMounts:
        - name: prometheus-config
          mountPath: /etc/prometheus
        - name: prometheus-storage
          mountPath: /prometheus
      volumes:
      - name: prometheus-config
        configMap:
          name: prometheus-config
      - name: prometheus-storage
        emptyDir: {}
EOF`);

        // Prometheus Service
        await execPromise(`cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: Service
metadata:
  name: prometheus
  namespace: monitoring
spec:
  selector:
    app: prometheus
  ports:
  - port: 9090
    targetPort: 9090
    protocol: TCP
  type: ClusterIP
EOF`);

        // 3. Install Grafana 
        sendEvent('📈 Installing Grafana...');

        // Grafana Deployment 
        await execPromise(`cat <<EOF | kubectl apply -f -
apiVersion: apps/v1
kind: Deployment
metadata:
  name: grafana
  namespace: monitoring
spec:
  replicas: 1
  selector:
    matchLabels:
      app: grafana
  template:
    metadata:
      labels:
        app: grafana
    spec:
      containers:
      - name: grafana
        image: grafana/grafana:10.0.3
        ports:
        - containerPort: 3000
        env:
        - name: GF_SECURITY_ADMIN_PASSWORD
          value: "admin" # Change in production
        volumeMounts:
        - name: grafana-storage
          mountPath: /var/lib/grafana
        resources:
          requests:
            memory: "512Mi"
            cpu: "200m"
          limits:
            memory: "1Gi"
            cpu: "500m"
      volumes:
      - name: grafana-storage
        emptyDir: {}
EOF`);

        // Grafana Service
        await execPromise(`cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: Service
metadata:
  name: grafana
  namespace: monitoring
spec:
  type: NodePort
  selector:
    app: grafana
  ports:
  - port: 3000
    targetPort: 3000
    protocol: TCP
  type: ClusterIP
EOF`);

sendEvent('🚨 Installing AlertManager...');
        
        // AlertManager ConfigMap
        await execPromise(`cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: ConfigMap
metadata:
  name: alertmanager-config
  namespace: monitoring
data:
  config.yml: |
    global:
      resolve_timeout: 5m
      
    route:
      group_by: ['alertname', 'severity']
      group_wait: 30s
      group_interval: 5m
      repeat_interval: 12h
      receiver: 'webhook'
      routes:
      - match:
          severity: 'critical'
        receiver: 'webhook'
        continue: true
      - match:
          alertname: 'PredictedAnomaly'
        receiver: 'webhook'
        
    receivers:
    - name: 'webhook'
      webhook_configs:
      - url: 'http://predictor.monitoring.svc.cluster.local:8000/webhook'
        send_resolved: true
EOF`);

        // AlertManager Deployment
        await execPromise(`cat <<EOF | kubectl apply -f -
apiVersion: apps/v1
kind: Deployment
metadata:
  name: alertmanager
  namespace: monitoring
spec:
  replicas: 1
  selector:
    matchLabels:
      app: alertmanager
  template:
    metadata:
      labels:
        app: alertmanager
    spec:
      containers:
      - name: alertmanager
        image: prom/alertmanager:v0.27.0
        args:
        - "--config.file=/etc/alertmanager/config.yml"
        - "--storage.path=/alertmanager"
        - '--web.listen-address=0.0.0.0:9093'
        ports:
        - containerPort: 9093
        volumeMounts:
        - name: config-volume
          mountPath: /etc/alertmanager
        - name: storage-volume
          mountPath: /alertmanager
      volumes:
      - name: config-volume
        configMap:
          name: alertmanager-config
      - name: storage-volume
        emptyDir: {}
EOF`);

        // AlertManager Service
        await execPromise(`cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: Service
metadata:
  name: alertmanager
  namespace: monitoring
spec:
  type: NodePort  
  selector:
    app: alertmanager
  ports:
  - name: web
    port: 9093
    targetPort: 9093
    nodePort: 30903
EOF`);
      await execPromise(`cat <<EOF | kubectl apply -f -
apiVersion: apps/v1
kind: Deployment
metadata:
  name: kube-state-metrics
  namespace: kube-system
spec:
  replicas: 1
  selector:
    matchLabels:
      app: kube-state-metrics
  template:
    metadata:
      labels:
        app: kube-state-metrics
      annotations:
        prometheus.io/scrape: 'true'
        prometheus.io/port: '8080'
    spec:
      serviceAccountName: kube-state-metrics
      containers:
      - name: kube-state-metrics
        image: k8s.gcr.io/kube-state-metrics/kube-state-metrics:v2.9.2
        ports:
        - containerPort: 8080
        - containerPort: 8081  
---
apiVersion: v1
kind: Service
metadata:
  name: kube-state-metrics
  namespace: kube-system
  labels:
    app: kube-state-metrics
spec:
  ports:
  - name: http-metrics
    port: 8080
    targetPort: 8080
  selector:
    app: kube-state-metrics
---   
apiVersion: v1
kind: ServiceAccount
metadata:
  name: kube-state-metrics
  namespace: kube-system
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: kube-state-metrics
rules:
- apiGroups: [""]
  resources: ["nodes", "pods", "services", "configmaps", "secrets"]
  verbs: ["list", "watch"]
- apiGroups: ["apps"]
  resources: ["daemonsets", "deployments", "replicasets", "statefulsets"]
  verbs: ["list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: kube-state-metrics
subjects:
- kind: ServiceAccount
  name: kube-state-metrics
  namespace: kube-system
roleRef:
  kind: ClusterRole
  name: kube-state-metrics
  apiGroup: rbac.authorization.k8s.io
EOF`);
await execPromise(`cat <<'EOF' | kubectl apply -f -
apiVersion: v1
kind: ConfigMap
metadata:
  name: prometheus-config
  namespace: monitoring
data:
  prometheus.yml: |
    global:
      scrape_interval: 15s
      evaluation_interval: 15s
    alerting:
      alertmanagers:
      - static_configs:
        - targets:
          - alertmanager.monitoring.svc.cluster.local:9093
    rule_files:
      - /etc/prometheus/rules.yml
    scrape_configs:
      - job_name: 'kubernetes-apiservers'
        kubernetes_sd_configs:
        - role: endpoints
        scheme: https
        tls_config:
          ca_file: /var/run/secrets/kubernetes.io/serviceaccount/ca.crt
        bearer_token_file: /var/run/secrets/kubernetes.io/serviceaccount/token
        relabel_configs:
        - source_labels: [__meta_kubernetes_namespace, __meta_kubernetes_service_name, __meta_kubernetes_endpoint_port_name]
          action: keep
          regex: default;kubernetes;https

      - job_name: 'kubernetes-nodes'
        scheme: https
        tls_config:
          ca_file: /var/run/secrets/kubernetes.io/serviceaccount/ca.crt
          insecure_skip_verify: true
        bearer_token_file: /var/run/secrets/kubernetes.io/serviceaccount/token
        kubernetes_sd_configs:
        - role: node
        relabel_configs:
        - action: labelmap
          regex: __meta_kubernetes_node_label_(.+)
        - target_label: __address__
          replacement: kubernetes.default.svc:443
        - source_labels: [__meta_kubernetes_node_name]
          regex: (.+)
          target_label: __metrics_path__
          replacement: /api/v1/nodes/${1}/proxy/metrics

      - job_name: 'kubernetes-pods'
        kubernetes_sd_configs:
        - role: pod
        relabel_configs:
        - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_scrape]
          action: keep
          regex: true
        - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_path]
          action: replace
          target_label: __metrics_path__
          regex: (.+)
        - source_labels: [__address__, __meta_kubernetes_pod_annotation_prometheus_io_port]
          action: replace
          regex: ([^:]+)(?::\d+)?;(\d+)
          replacement: $1:$2
          target_label: __address__
        - action: labelmap
          regex: __meta_kubernetes_pod_label_(.+)
        - source_labels: [__meta_kubernetes_namespace]
          action: replace
          target_label: kubernetes_namespace
        - source_labels: [__meta_kubernetes_pod_name]
          action: replace
          target_label: kubernetes_pod_name

      - job_name: 'kube-state-metrics'
        static_configs:
        - targets: ['kube-state-metrics.kube-system.svc.cluster.local:8080']

      - job_name: 'node-exporter'
        static_configs:
        - targets: ['node-exporter.kube-system.svc.cluster.local:9100']

      - job_name: 'node'
        static_configs:
        - targets: ['node-exporter:9100']

      - job_name: 'pod-metrics'
        kubernetes_sd_configs:
        - role: pod
        relabel_configs:
        - source_labels: [__meta_kubernetes_pod_container_name]
          action: keep
          regex: '.+'
        - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_scrape]
          action: keep
          regex: true

      - job_name: 'pod-network'
        kubernetes_sd_configs:
        - role: pod
        metrics_path: /metrics
        relabel_configs:
        - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_scrape]
          action: keep
          regex: true
        - source_labels: [__meta_kubernetes_pod_container_port_number]
          action: keep
          regex: '8080|9090'

      - job_name: 'response-times'
        kubernetes_sd_configs:
        - role: pod
        metrics_path: /metrics
        relabel_configs:
        - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_scrape]
          action: keep
          regex: true
        - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_path]
          action: replace
          target_label: __metrics_path__
          regex: (.+)

      - job_name: 'predictor-metrics'
        static_configs:
        - targets: ['predictor.monitoring.svc.cluster.local:8000']

      - job_name: 'node-network'
        metrics_path: '/metrics'
        kubernetes_sd_configs:
        - role: pod
        relabel_configs:
        - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_scrape]
          action: keep
          regex: true
        - source_labels: [__address__, __meta_kubernetes_pod_annotation_prometheus_io_port]
          action: replace
          regex: ([^:]+)(?::\d+)?;(\d+)
          replacement: $1:$2
          target_label: __address__

      - job_name: 'pod-restarts'
        kubernetes_sd_configs:
        - role: pod
        metrics_path: '/metrics/cadvisor'
        relabel_configs:
        - source_labels: [__meta_kubernetes_pod_container_name]
          action: keep
          regex: '.+'
        - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_scrape]
          action: keep
          regex: true
EOF`);

        // Add some default alert rules
        await execPromise(`cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: ConfigMap
metadata:
  name: prometheus-rules
  namespace: monitoring
data:
  rules.yml: |
    groups:
    - name: node-alerts
      rules:
      - alert: HighNodeCPU
        expr: 100 - (avg by(instance) (irate(node_cpu_seconds_total{mode="idle"}[5m])) * 100) > 80
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High CPU usage on {{ $labels.instance }}"
          description: "CPU usage is {{ $value }}%"

      - alert: HighNodeMemory
        expr: (node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes) * 100 < 20
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High memory usage on {{ $labels.instance }}"
          description: "Only {{ $value }}% memory available"

      - alert: NodeDown
        expr: up == 0
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "Node {{ $labels.instance }} is down"
          description: "Node has been down for more than 1 minute"

    - name: anomaly-alerts
      rules:
      - alert: PredictedAnomaly
        expr: predict_anomaly > 0.7
        for: 2m
        labels:
          severity: warning
        annotations:
          summary: "Anomaly predicted with {{ $value }} confidence"
          description: "The predictive model has detected a potential anomaly in cluster behavior."
EOF`);

      await execPromise(`cat <<EOF | kubectl apply -f -
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: node-exporter
  namespace: kube-system
  labels:
    k8s-app: node-exporter
spec:
  selector:
    matchLabels:
      k8s-app: node-exporter
  template:
    metadata:
      labels:
        k8s-app: node-exporter
    spec:
      containers:
      - name: node-exporter
        image: prom/node-exporter:v1.6.1
        ports:
        - containerPort: 9100
      hostNetwork: true
      hostPID: true
      tolerations:
      - effect: NoSchedule
        operator: Exists
EOF`);
  sendEvent('🤖 Installing Predictor...');
        await execPromise(`cat <<EOF | kubectl apply -f -
apiVersion: apps/v1
kind: Deployment
metadata:
  name: predictor
  namespace: monitoring
spec:
  replicas: 1
  selector:
    matchLabels:
      app: predictor
  template:
    metadata:
      labels:
        app: predictor
      annotations:
        prometheus.io/scrape: 'true'
        prometheus.io/port: '8000'
    spec:
      containers:
      - name: predictor
        image: nada142/predictor:latest
        ports:
        - containerPort: 8000
        resources:
          requests:
            cpu: "200m"
            memory: "512Mi"
          limits:
            cpu: "500m"
            memory: "1Gi"
        livenessProbe:
          httpGet:
            path: /health
            port: 8000
          initialDelaySeconds: 30
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /health
            port: 8000
          initialDelaySeconds: 5
          periodSeconds: 5
---
apiVersion: v1
kind: Service
metadata:
  name: predictor
  namespace: monitoring
spec:
  selector:
    app: predictor
  ports:
    - protocol: TCP
      port: 8000
      targetPort: 8000
EOF`);


await execPromise('kubectl rollout restart deployment prometheus -n monitoring');
        
        // Wait for AlertManager
        await waitForPod('monitoring', 'app=alertmanager', sendEvent);

        sendEvent('✅ AlertManager installed successfully!', 'success');


        // 4. Wait for pods to be ready
        sendEvent('⏳ Waiting for components to start...');

        // Wait for Prometheus
        await waitForPod('monitoring', 'app=prometheus', sendEvent);

        // Wait for Grafana 
        await waitForPod('monitoring', 'app=grafana', sendEvent, 600);

        sendEvent('✅ Monitoring stack installed successfully!', 'success');

        // 4. Wait for pods to be ready
        sendEvent('⏳ Waiting for components to start...');

        // Wait for Prometheus
        await waitForPod('monitoring', 'app=prometheus', sendEvent);

        // Wait for Grafana 
        await waitForPod('monitoring', 'app=grafana', sendEvent, 600);

        sendEvent('✅ Monitoring stack installed successfully!', 'success');

         return {
            prometheusUrl: 'http://prometheus.monitoring.svc.cluster.local:9090',
            grafanaUrl: 'http://grafana.monitoring.svc.cluster.local:3000',
            alertmanagerUrl: 'http://alertmanager.monitoring.svc.cluster.local:9093',
            credentials: {
                username: 'admin',
                password: 'admin'
            }
        };
    } catch (error) {
        sendEvent(`❌ Error installing monitoring stack: ${error.message}`, 'error');

        try {
            const { stdout: pods } = await execPromise('kubectl get pods -n monitoring -o wide');
            sendEvent(`Pods status:\n${pods}`, 'debug');

            try {
                const { stdout: grafanaPod } = await execPromise(
                    `kubectl get pods -n monitoring -l app=grafana -o jsonpath='{.items[0].metadata.name}'`
                );
                if (grafanaPod) {
                    const { stdout: grafanaLogs } = await execPromise(
                        `kubectl logs -n monitoring ${grafanaPod} --tail=50`
                    );
                    sendEvent(`Grafana Pod Logs:\n${grafanaLogs}`, 'debug');
                }
            } catch (logError) {
                sendEvent(`⚠️ Could not get Grafana logs: ${logError.message}`, 'warning');
            }

            try {
                const { stdout: events } = await execPromise(
                    `kubectl get events -n monitoring --field-selector involvedObject.kind=Pod`
                );
                sendEvent(`Pod Events:\n${events}`, 'debug');
            } catch (eventError) {
                sendEvent(`⚠️ Could not get pod events: ${eventError.message}`, 'warning');
            }
        } catch (debugError) {
            sendEvent(`⚠️ Could not get debug info: ${debugError.message}`, 'warning');
        }

        throw error;
    }
}

async function waitForPod(namespace, selector, sendEvent, timeout = 300) {
    let ready = false;
    let attempts = 0;
    const maxAttempts = timeout / 5;

    while (!ready && attempts < maxAttempts) {
        attempts++;
        try {
            const { stdout: podList } = await execPromise(
                `kubectl get pods -n ${namespace} --selector=${selector} -o json`
            );
            const pods = JSON.parse(podList).items;

            if (pods.length === 0) {
                sendEvent(`⏳ No pods found for selector ${selector} (attempt ${attempts}/${maxAttempts})`, 'warning');
                await new Promise(resolve => setTimeout(resolve, 5000));
                continue;
            }

            const podName = pods[0].metadata.name;
            const phase = pods[0].status.phase;
            const containerReady = pods[0].status.containerStatuses?.[0]?.ready;

            if (phase === 'Running' && containerReady === true) {
                sendEvent(`✅ Pod ${podName} is ready`, 'success');
                ready = true;
            } else {
                sendEvent(
                    `⏳ Waiting for ${selector} (pod: ${podName}, phase: ${phase}, ready: ${containerReady}, attempt ${attempts}/${maxAttempts})`,
                    'info'
                );

                try {
                    const { stdout: podEvents } = await execPromise(
                        `kubectl describe pod -n ${namespace} ${podName}`
                    );
                    sendEvent(`Pod ${podName} description:\n${podEvents}`, 'debug');
                } catch (eventError) {
                    sendEvent(`⚠️ Could not describe pod ${podName}: ${eventError.message}`, 'warning');
                }

                await new Promise(resolve => setTimeout(resolve, 5000));
            }
        } catch (error) {
            sendEvent(`⚠️ Pod check error: ${error.message}`, 'warning');
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    }

    if (!ready) {
        throw new Error(`Timeout waiting for pod with selector ${selector} to be ready after ${maxAttempts} attempts`);
    }
}
// Check AlertManager status
exports.checkAlertManagerStatus = async (req, res) => {
    try {
        const { stdout } = await execPromise('kubectl get pods -n monitoring -l app=alertmanager -o json');
        const pods = JSON.parse(stdout).items;
        
        const alertManagerStatus = {
            running: pods.some(pod => pod.status.phase === 'Running'),
            ready: pods.some(pod => pod.status.containerStatuses?.[0]?.ready === true)
        };
        
        res.json(alertManagerStatus);
    } catch (error) {
        res.status(500).json({ 
            error: 'Failed to check AlertManager status',
            details: error.message 
        });
    }
};

exports.getActiveAlerts = async (req, res) => {
    let portForwardProcess = null;
    const port = 9093;
    const localAddress = '127.0.0.1'; 
    const maxRetries = 3;
    let lastError = null;

    try {
        const { stdout: podJson } = await execPromise(
            'kubectl get pods -n monitoring -l app=alertmanager -o json'
        );
        const pods = JSON.parse(podJson).items;

        if (!pods || pods.length === 0) {
            return res.status(404).json({ error: 'AlertManager pod not found' });
        }

        const podName = pods[0].metadata.name;
        
        const isReady = pods[0].status.containerStatuses?.[0]?.ready;
        if (!isReady) {
            return res.status(503).json({ error: 'AlertManager pod not ready' });
        }

        portForwardProcess = exec(
            `kubectl port-forward ${podName} -n monitoring ${port}:9093 --address ${localAddress}`,
            { timeout: 10000 }
        );

        portForwardProcess.stderr.on('data', (data) => {
            console.error('Port-forward stderr:', data.toString());
        });

        portForwardProcess.on('error', (err) => {
            console.error('Port-forward error:', err);
            if (!portForwardProcess.killed) {
                portForwardProcess.kill();
            }
        });

        portForwardProcess.on('exit', (code) => {
            if (code !== 0) {
                console.error(`Port-forward exited with code ${code}`);
            }
        });

        await waitForPort(port, localAddress, 5000);

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const response = await axios.get(`http://${localAddress}:${port}/api/v2/alerts`, {
                    timeout: 5000,
                    headers: {
                        'Connection': 'keep-alive'
                    }
                });

               
                if (portForwardProcess && !portForwardProcess.killed) {
                    portForwardProcess.kill();
                }
                return res.json(response.data);
            } catch (err) {
                lastError = err;
                console.warn(`Attempt ${attempt} failed:`, err.message);
                
                if (attempt < maxRetries) {
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            }
        }

        throw lastError || new Error('All retries failed');
    } catch (error) {
        if (portForwardProcess && !portForwardProcess.killed) {
            portForwardProcess.kill();
        }

        console.error('AlertManager error:', error);
        
        let statusCode = 500;
        if (error.message.includes('not found')) statusCode = 404;
        if (error.message.includes('not ready')) statusCode = 503;

        res.status(statusCode).json({
            error: 'Failed to get alerts',
            details: error.message,
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
};

async function waitForPort(port, host = '127.0.0.1', timeout = 5000) {
    const startTime = Date.now();
    
    while (Date.now() - startTime < timeout) {
        try {
            const socket = net.createConnection(port, host);
            await new Promise((resolve, reject) => {
                socket.on('connect', () => {
                    socket.end();
                    resolve();
                });
                socket.on('error', reject);
            });
            return; // Port is available
        } catch (err) {
            if (Date.now() - startTime >= timeout) {
                throw new Error(`Timeout waiting for port ${port} on ${host}`);
            }
            await new Promise(resolve => setTimeout(resolve, 200));
        }
    }
    
    throw new Error(`Port ${port} on ${host} not available after ${timeout}ms`);
}

exports.redirectToAlertManager = async (req, res) => {
    let portForwardProcess = null;
    const port = 9093;

    try {
        // Get the cluster to find the node IP
        const cluster = await KubernetesCluster.findOne().sort({createdAt: -1});
        const nodeIP = cluster?.nodeIP || '127.0.0.1';

        // Get AlertManager pod name
        const { stdout: podName } = await execPromise(
            'kubectl get pods -n monitoring -l app=alertmanager -o jsonpath="{.items[0].metadata.name}"'
        );

        if (!podName) {
            return res.status(404).send('AlertManager pod not found');
        }

        // Start port-forward
        portForwardProcess = exec(
            `kubectl port-forward ${podName} -n monitoring ${port}:9093 --address ${nodeIP}`,
            { timeout: 10000 }
        );

        // Redirect to the local port
        res.redirect(`http://${nodeIP}:${port}`);

        // Kill the port-forward after 5 minutes
        setTimeout(() => {
            if (portForwardProcess && !portForwardProcess.killed) {
                portForwardProcess.kill();
            }
        }, 5 * 60 * 1000);

    } catch (error) {
        if (portForwardProcess && !portForwardProcess.killed) {
            portForwardProcess.kill();
        }
        
        res.status(500).send(`
            <h2>Error accessing AlertManager</h2>
            <p>${error.message}</p>
            <p>Please ensure AlertManager is running in your cluster.</p>
        `);
    }
};
exports.checkAlertManagerHealth = async (req, res) => {
    try {
        try {
            const response = await axios.get('http://alertmanager.monitoring.svc.cluster.local:9093/-/healthy', {
                timeout: 3000
            });
            return res.json({ 
                healthy: true, 
                method: 'direct',
                status: response.data 
            });
        } catch (directError) {
            console.log('Direct access failed, trying port-forward');
        }

        let portForwardProcess = null;
        try {
            const { stdout: podName } = await execPromise(
                'kubectl get pods -n monitoring -l app=alertmanager -o jsonpath="{.items[0].metadata.name}"'
            );
            
            if (!podName) {
                return res.json({ healthy: false, error: 'No AlertManager pod found' });
            }

            const port = 9093;
            portForwardProcess = exec(`kubectl port-forward ${podName} -n monitoring ${port}:9093 --address 127.0.0.1 &`);
            
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            const response = await axios.get(`http://127.0.0.1:${port}/-/healthy`, {
                timeout: 3000
            });
            
            portForwardProcess.kill();
            return res.json({ 
                healthy: true, 
                method: 'port-forward',
                status: response.data 
            });
        } catch (error) {
            if (portForwardProcess) portForwardProcess.kill();
            return res.json({ 
                healthy: false, 
                error: error.message 
            });
        }
    } catch (error) {
        res.status(500).json({ 
            error: 'Failed to check AlertManager health',
            details: error.message 
        });
    }
};

exports.checkMonitoringStatus = async (req, res) => {
    try {
        const { stdout } = await execPromise('kubectl get pods -n monitoring -o json');
        const pods = JSON.parse(stdout).items;
        
        const monitoringStatus = {
            grafana: pods.some(pod => pod.metadata.name.includes('grafana') && pod.status.phase === 'Running'),
            prometheus: pods.some(pod => pod.metadata.name.includes('prometheus') && pod.status.phase === 'Running'),
            alertmanager: pods.some(pod => pod.metadata.name.includes('alertmanager') && pod.status.phase === 'Running')
        };
        
        res.json(monitoringStatus);
    } catch (error) {
        res.status(500).json({ 
            error: 'Failed to check monitoring status',
            details: error.message 
        });
    }
};



exports.getPrometheusAlerts = async (req, res) => {
    let portForwardProcess = null;
    let maxRetries = 3;
    let retryDelay = 2000; 
    
    try {
        // Get the cluster to find the node IP
        const cluster = await KubernetesCluster.findOne().sort({createdAt: -1});
        const nodeIP = cluster?.nodeIP || '127.0.0.1';

        const { stdout: pods } = await execPromise(
            'kubectl get pods -n monitoring -l app=prometheus -o json'
        );

        const podList = JSON.parse(pods).items;
        
        if (podList.length === 0) {
            return res.status(404).json({ error: 'No Prometheus pods found' });
        }

        const podName = podList[0].metadata.name;
        const port = 9090;
        
        portForwardProcess = exec(`kubectl port-forward ${podName} -n monitoring --address 0.0.0.0 ${port}:9090 &`);
        
        let attempts = 0;
        let lastError;
        
        while (attempts < maxRetries) {
            try {
                await new Promise((resolve, reject) => {
                    const socket = net.createConnection(port, '192.168.136.128', () => {
                        socket.end();
                        resolve();
                    });
                    
                    socket.on('error', (err) => {
                        reject(err);
                    });
                    
                    socket.setTimeout(2000, () => {
                        socket.destroy();
                        reject(new Error('Connection timeout'));
                    });
                });
                
                break;
            } catch (err) {
                lastError = err;
                attempts++;
                if (attempts < maxRetries) {
                    await new Promise(resolve => setTimeout(resolve, retryDelay));
                }
            }
        }
        
        if (attempts >= maxRetries) {
            throw lastError || new Error('Failed to establish port-forward after retries');
        }
        
        attempts = 0;
        lastError = null;
        let response;
        
        while (attempts < maxRetries) {
            try {
                response = await axios.get(`http://${nodeIP}:${port}/api/v1/alerts`, {
            timeout: 5000,
            httpAgent: new http.Agent({ keepAlive: false }),
            httpsAgent: new https.Agent({ keepAlive: false })
        });
                break;
            } catch (err) {
                lastError = err;
                attempts++;
                if (attempts < maxRetries) {
                    await new Promise(resolve => setTimeout(resolve, retryDelay));
                }
            }
        }
        
        if (attempts >= maxRetries) {
            throw lastError || new Error('Failed to get alerts after retries');
        }
        
        const formattedAlerts = response.data.data.alerts.map(alert => ({
            status: {
                state: alert.state === 'firing' ? 'active' : 'inactive'
            },
            labels: alert.labels,
            annotations: alert.annotations,
            startsAt: alert.activeAt,
        }));

        portForwardProcess.kill();
        return res.json(formattedAlerts);
        
    } catch (error) {
        if (portForwardProcess) {
            try {
                portForwardProcess.kill();
            } catch (killError) {
                console.error('Failed to kill port-forward:', killError);
            }
        }
        
        console.error('Prometheus alerts error:', error);
        
        if (error.code === 'ECONNRESET') {
            return res.status(503).json({ 
                error: 'Prometheus connection was reset',
                details: 'The connection to Prometheus was unexpectedly closed. Try again later.'
            });
        }
        
        res.status(500).json({ 
            error: 'Failed to get alerts from Prometheus',
            details: error.message,
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
};

// Check Prometheus status
exports.checkPrometheusStatus = async (req, res) => {
    try {
        const { stdout } = await execPromise('kubectl get pods -n monitoring -l app=prometheus -o json');
        const pods = JSON.parse(stdout).items;
        
        const prometheusStatus = {
            running: pods.some(pod => pod.status.phase === 'Running'),
            ready: pods.some(pod => pod.status.containerStatuses?.[0]?.ready === true)
        };
        
        res.json(prometheusStatus);
    } catch (error) {
        res.status(500).json({ 
            error: 'Failed to check Prometheus status',
            details: error.message 
        });
    }
};


exports.verifyServiceAccess = async (req, res) => {
    const { port, endpoint } = req.query;
    
    try {
        const net = require('net');
        const client = new net.Socket();
        
        let isAvailable = false;
        
        client.setTimeout(2000);
        client.on('error', () => {
            client.destroy();
            res.json({ available: false });
        });
        
        client.on('timeout', () => {
            client.destroy();
            res.json({ available: false });
        });
        
        client.connect(port, 'localhost', () => {
            client.destroy();
            res.json({ available: true });
        });
    } catch (error) {
        res.status(500).json({ 
            error: 'Verification failed',
            details: error.message 
        });
    }
};




exports.redirectToGrafana = async (req, res) => {
  try {
    // Get the cluster to find the node IP
    const cluster = await KubernetesCluster.findOne().sort({createdAt: -1});
    const nodeIP = cluster?.nodeIP || '127.0.0.1';
    
    const grafanaPortForward = exec(`kubectl port-forward svc/grafana -n monitoring --address 0.0.0.0 3000:3000 &`);
    res.redirect(`http://${nodeIP}:3000`);
    
    // Clean up after 5 minutes
    setTimeout(() => {
      grafanaPortForward.kill();
    }, 300000);
  } catch (error) {
    res.status(500).send(`
      <h2>Error accessing Grafana</h2>
      <p>${error.message}</p>
      <p>Check if Grafana pod is running in the monitoring namespace</p>
    `);
  }
};

exports.redirectToPrometheus = async (req, res) => {
    try {
        // Get the cluster to find the node IP
        const cluster = await KubernetesCluster.findOne().sort({createdAt: -1});
        const nodeIP = cluster?.nodeIP || '127.0.0.1';
        
        // Start port-forward
        const prometheusPortForward = exec(`kubectl port-forward svc/prometheus -n monitoring --address 0.0.0.0 9090:9090 &`);
        
        // Give it a second to establish
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        // Redirect to local port-forward
        res.redirect(`http://${nodeIP}:9090`);
        
        setTimeout(() => {
            prometheusPortForward.kill();
        }, 30000);
        
    } catch (error) {
        res.status(500).send(`
            <h2>Error accessing Prometheus</h2>
            <p>${error.message}</p>
            <p>Please ensure Prometheus is running in your cluster.</p>
        `);
    }
};



exports.debugMonitoring = async (req, res) => {
    try {
        const [grafana, prometheus, alertmanager] = await Promise.all([
            execPromise('kubectl get pods,svc -n monitoring -l app.kubernetes.io/name=grafana'),
            execPromise('kubectl get pods,svc -n monitoring -l app=prometheus'),
            execPromise('kubectl get pods,svc -n monitoring -l app=alertmanager')
        ]);
        
        res.send(`
            <h1>Monitoring Debug Info</h1>
            <h2>Grafana</h2>
            <pre>${grafana.stdout}</pre>
            <h2>Prometheus</h2>
            <pre>${prometheus.stdout}</pre>
            <h2>AlertManager</h2>
            <pre>${alertmanager.stdout}</pre>
        `);
    } catch (error) {
        res.status(500).send(`
            <h1>Debug Error</h1>
            <pre>${error.message}</pre>
        `);
    }
};



exports.cancelInitialization = async (req, res) => {
    try {
        await execPromise('pkill -f "kubeadm init"');
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

exports.listClusters = async (req, res) => {
    try {
      const clusters = await KubernetesCluster.find({});
      res.json(clusters);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  };
const vmPool = {
    available: [],    
    inUse: [],        
    maintenance: []   
  };
  
  exports.initializeVMPool = async () => {
    try {
      const client = new vSphere(vsphereConfig);
      const vms = await client.getAllVMs('/k8s-pool');
      
      for (const vm of vms) {
        if (vm.runtime.powerState === 'poweredOn') {
          const ip = await vm.getIP();
          vmPool.available.push({
            vmId: vm.id,
            name: vm.name,
            ip,
            lastChecked: new Date()
          });
        }
      }
      console.log(`VM pool initialized with ${vmPool.available.length} available nodes`);
    } catch (error) {
      console.error('Error initializing VM pool:', error);
    }
  };
  

exports.addNode = async (req, res) => {
    const sendEvent = (message, type = 'info') => {
        res.write(`data: ${JSON.stringify({ message, type })}\n\n`);
    };

    try {
        const { cpu = 1, memory = 2048 } = req.query; 

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();

        sendEvent(`🚀 Starting to add worker node using Docker`);
        sendEvent(`⚙️ Configuration: ${cpu} vCPU, ${memory}MB RAM`);

        // 1. Generate persistent join command
        sendEvent('🔑 Generating kubeadm join command...');
        const { stdout: joinCommand } = await execPromise(
            'kubeadm token create --ttl 8760h --print-join-command'
        );
        
        // 2. Create Docker container 
        sendEvent('🐳 Creating Docker container...');
        const containerName = `k8s-worker-${Date.now()}`;
        
        const dockerRunCommand = [
            'docker run -d',
            `--name ${containerName}`,
            `--cpus=${cpu}`,
            `--memory=${memory}m`,
            '--privileged',
            '--network=host',
            '--pid=host',
            '--cap-add=ALL',
            '-v /lib/modules:/lib/modules:rw',
            '-v /usr/src:/usr/src:ro',
            '-v /boot:/boot:ro',
            '-v /:/host',
            '-v /var/run/docker.sock:/var/run/docker.sock',
            '-v /var/run/containerd/containerd.sock:/var/run/containerd/containerd.sock',
            '-v /sys:/sys:rw',
            '-v /var/lib/docker:/var/lib/docker:rw',
            '-v /var/lib/kubelet:/var/lib/kubelet:shared',
            'ubuntu:22.04',
            'sleep infinity'
        ].join(' ');

        try {
            const { stdout: containerId } = await execPromise(dockerRunCommand);
            sendEvent(`✅ Container created: ${containerName}`, 'success');
        } catch (error) {
            sendEvent(`❌ Container creation failed: ${error.message}`, 'error');
            throw error;
        }

        // 3. Install Kubernetes inside container
        sendEvent('⚙️ Installing Kubernetes in container...');
        const installScript = `#!/bin/bash
set -ex

# Install essential packages first
apt-get update && apt-get install -y kmod linux-headers-$(uname -r) apt-transport-https curl gnupg

# Load required modules
modprobe configs
modprobe br_netfilter

# Add Kubernetes repo
mkdir -p /etc/apt/keyrings
curl -fsSL https://pkgs.k8s.io/core:/stable:/v1.30/deb/Release.key | gpg --dearmor -o /etc/apt/keyrings/kubernetes-apt-keyring.gpg
echo 'deb [signed-by=/etc/apt/keyrings/kubernetes-apt-keyring.gpg] https://pkgs.k8s.io/core:/stable:/v1.30/deb/ /' > /etc/apt/sources.list.d/kubernetes.list

# Install Kubernetes components
apt-get update
apt-get install -y kubelet=1.30.0-1.1 kubeadm=1.30.0-1.1 kubectl=1.30.0-1.1
apt-mark hold kubelet kubeadm kubectl

# Configure system
mkdir -p /etc/modules-load.d /etc/sysctl.d
echo "br_netfilter" > /etc/modules-load.d/k8s.conf
echo "net.ipv4.ip_forward = 1" > /etc/sysctl.d/k8s.conf
echo "net.bridge.bridge-nf-call-iptables = 1" >> /etc/sysctl.d/k8s.conf
sysctl --system

# Configure kubelet
mkdir -p /var/lib/kubelet
cat <<EOF > /var/lib/kubelet/config.yaml
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
podManifestPath: /host/etc/kubernetes/manifests
cniConfDir: /host/etc/cni/net.d
cniBinDir: /host/opt/cni/bin
volumePluginDir: /host/var/lib/kubelet/volumeplugins
EOF

# Start kubelet on a different port to avoid conflict
nohup kubelet --kubeconfig=/host/etc/kubernetes/kubelet.conf \\
              --bootstrap-kubeconfig=/host/etc/kubernetes/bootstrap-kubelet.conf \\
              --config=/var/lib/kubelet/config.yaml \\
              --container-runtime-endpoint=unix:///host/var/run/containerd/containerd.sock \\
              --node-ip=\$(hostname -I | awk '{print \\\$1}') \\
              --port=10251 > /var/log/kubelet.log 2>&1 &

# Join cluster with necessary ignores
${joinCommand} --ignore-preflight-errors=all,SystemVerification,Port-10250
`;

        try {
            // Copy and execute installation script
            fs.writeFileSync('/tmp/k8s-install.sh', installScript);
            await execPromise(`docker cp /tmp/k8s-install.sh ${containerName}:/install.sh`);
            await execPromise(`docker exec ${containerName} chmod +x /install.sh`);
            
            // Execute in background and stream logs
            const child = exec(`docker exec ${containerName} /bin/bash -x /install.sh`);
            
            child.stdout.on('data', (data) => {
                sendEvent(data.toString(), 'stdout');
            });
            
            child.stderr.on('data', (data) => {
                sendEvent(data.toString(), 'stderr');
            });
            
            await new Promise((resolve, reject) => {
                child.on('close', (code) => {
                    if (code === 0) {
                        sendEvent('🎉 Worker node successfully joined the cluster!', 'success');
                        
                        // Verify node joined successfully
                        sendEvent('🔍 Verifying node status...');
                        exec('kubectl get nodes', (error, stdout) => {
                            if (error) {
                                sendEvent(`❌ Error verifying node status: ${error.message}`, 'error');
                            } else {
                                sendEvent(`Current nodes:\n${stdout}`, 'info');
                            }
                            resolve();
                        });
                    } else {
                        exec(`docker exec ${containerName} cat /var/log/kubelet.log`, (err, logs) => {
                            if (!err) {
                                sendEvent(`Kubelet logs:\n${logs}`, 'error');
                            }
                            
                            reject(new Error(`Installation failed with code ${code}`));
                        });
                    }
                });
            });

        } catch (error) {
            const { stdout: containerLogs } = await execPromise(`docker logs ${containerName}`);
            sendEvent(`Container logs before failure:\n${containerLogs}`, 'error');
            throw error;
        }

    } catch (error) {
        sendEvent(`❌ Critical error: ${error.message}`, 'error');
        sendEvent('🔧 Recommended troubleshooting:', 'info');
        sendEvent('1. Check Docker logs: sudo journalctl -u docker', 'info');
        sendEvent('2. Check container: docker logs <container-name>', 'info');
        sendEvent('3. Verify networking: ping <control-plane-ip>', 'info');
        sendEvent('4. Check containerd: sudo systemctl status containerd', 'info');
    } finally {
        res.end();
    }
};

exports.getNodes = async (req, res) => {
    try {
        exec("kubectl get nodes -o json", (error, stdout, stderr) => {
            if (error) {
                console.error('Error getting nodes:', error);
                return res.status(500).json({ 
                    message: 'Error getting nodes', 
                    error: error.message,
                    stderr: stderr 
                });
            }
            
            try {
                const nodes = JSON.parse(stdout);
                res.json(nodes);
            } catch (parseError) {
                console.error('Error parsing nodes JSON:', parseError);
                res.status(500).json({ 
                    message: 'Error parsing nodes information', 
                    error: parseError.message,
                    output: stdout 
                });
            }
        });
    } catch (error) {
        console.error('Error getting nodes:', error);
        res.status(500).json({ message: 'Error getting nodes', error: error.message });
    }
};


exports.getNodeDetails = async (req, res) => {
    try {
        const { nodeName } = req.params;
        const { stdout } = await execPromise(`kubectl get node ${nodeName} -o json`);
        const node = JSON.parse(stdout);
        
        node.metrics = null;
        node.metricsError = null;
        
        try {
            const { stdout: metrics } = await execPromise(`kubectl top node ${nodeName} --no-headers`);
            const [name, cpu, memory] = metrics.trim().split(/\s+/);
            node.metrics = { cpu, memory };
        } catch (metricsError) {
            if (!metricsError.stderr || !metricsError.stderr.includes('Metrics API not available')) {
                node.metricsError = metricsError.message;
            }
            console.warn('Metrics not available:', metricsError.message);
        }
        
        res.json(node);
    } catch (error) {
        res.status(500).json({ 
            error: 'Failed to get node details',
            details: error.message 
        });
    }
};
exports.getClusterInfo = async (req, res) => {
    try {
        const clusterInfoPromise = new Promise((resolve, reject) => {
            exec("kubectl cluster-info", (error, stdout, stderr) => {
                if (error) reject({error, stderr});
                resolve(stdout);
            });
        });

        // Get component statuses
        const componentStatusPromise = new Promise((resolve, reject) => {
            exec("KUBECONFIG=/home/nada142/.kube/config kubectl get componentstatuses", (error, stdout, stderr) => {
                if (error) reject({error, stderr});
                resolve(stdout);
            });
        });

        // Get system pods
        const systemPodsPromise = new Promise((resolve, reject) => {
            exec("kubectl get pods -n kube-system", (error, stdout, stderr) => {
                if (error) reject({error, stderr});
                resolve(stdout);
            });
        });

        Promise.all([clusterInfoPromise, componentStatusPromise, systemPodsPromise])
            .then(([clusterInfo, componentStatus, systemPods]) => {
                res.json({
                    clusterInfo,
                    componentStatus,
                    systemPods
                });
            })
            .catch(error => {
                console.error('Error getting cluster info:', error);
                res.status(500).json({ 
                    message: 'Error getting cluster information', 
                    error: error.error.message,
                    stderr: error.stderr 
                });
            });
    } catch (error) {
        console.error('Error getting cluster info:', error);
        res.status(500).json({ message: 'Error getting cluster info', error: error.message });
    }
};


exports.generateJoinToken = async (req, res) => {
    try {
        const tokenCommand = 'kubeadm token create --ttl 24h --print-join-command';
        
        exec(tokenCommand, (error, stdout, stderr) => {
            if (error) {
                console.error('Error generating join token:', error);
                return res.status(500).json({ 
                    message: 'Error generating join token', 
                    error: error.message,
                    stderr: stderr 
                });
            }
            
            // Extract token and CA hash from the command
            const joinCommand = stdout.trim();
            const token = joinCommand.match(/--token (\S+)/)[1];
            const caHash = joinCommand.match(/--discovery-token-ca-cert-hash (\S+)/)[1];
            
            res.json({ 
                joinCommand,
                token,
                caHash,
                expiration: new Date(Date.now() + 24 * 60 * 60 * 1000) 
            });
        });
    } catch (error) {
        console.error('Error generating join token:', error);
        res.status(500).json({ message: 'Error generating join token', error: error.message });
    }
};


// Drain a node
exports.drainNode = async (req, res) => {
    const { nodeName, deleteLocalData, ignoreDaemonsets } = req.body;

    try {
        let drainCommand = `kubectl drain ${nodeName}`;
        
        if (deleteLocalData) {
            drainCommand += ' --delete-local-data';
        }
        
        if (ignoreDaemonsets) {
            drainCommand += ' --ignore-daemonsets';
        }
        
        drainCommand += ' --force';
        
        exec(drainCommand, (error, stdout, stderr) => {
            if (error) {
                console.error('Error draining node:', error);
                return res.status(500).json({ 
                    success: false,
                    error: error.message,
                    stderr: stderr 
                });
            }
            
            res.json({ 
                success: true,
                message: `Node ${nodeName} drained successfully`,
                output: stdout
            });
        });
    } catch (error) {
        console.error('Error draining node:', error);
        res.status(500).json({ 
            success: false,
            message: 'Error draining node', 
            error: error.message 
        });
    }
};

// Cordon a node (mark as unschedulable)
exports.cordonNode = async (req, res) => {
    const { nodeName } = req.body;

    try {
        exec(`kubectl cordon ${nodeName}`, (error, stdout, stderr) => {
            if (error) {
                console.error('Error cordoning node:', error);
                return res.status(500).json({ 
                    success: false,
                    error: error.message,
                    stderr: stderr 
                });
            }
            
            res.json({ 
                success: true,
                message: `Node ${nodeName} marked as unschedulable`,
                output: stdout
            });
        });
    } catch (error) {
        console.error('Error cordoning node:', error);
        res.status(500).json({ 
            success: false,
            message: 'Error cordoning node', 
            error: error.message 
        });
    }
};

// Uncordon a node (mark as schedulable)
exports.uncordonNode = async (req, res) => {
    const { nodeName } = req.body;

    try {
        exec(`kubectl uncordon ${nodeName}`, (error, stdout, stderr) => {
            if (error) {
                console.error('Error uncordoning node:', error);
                return res.status(500).json({ 
                    success: false,
                    error: error.message,
                    stderr: stderr 
                });
            }
            
            res.json({ 
                success: true,
                message: `Node ${nodeName} marked as schedulable`,
                output: stdout
            });
        });
    } catch (error) {
        console.error('Error uncordoning node:', error);
        res.status(500).json({ 
            success: false,
            message: 'Error uncordoning node', 
            error: error.message 
        });
    }
};

// Delete a node from the cluster
exports.deleteNode = async (req, res) => {
    const { nodeName } = req.params;
    try {
        await execPromise(`docker stop ${nodeName} && docker rm ${nodeName}`);
        res.json({ success: true, message: `Node ${nodeName} removed` });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
};

const jsyaml = require('js-yaml');

// Create a new deployment
exports.createDeployment = async (req, res) => {
    const {
        deploymentName,
        namespace,
        imageName,
        replicas,
        ports,
        envVars,
        cpuLimit,
        memoryLimit,
        cpuRequest,
        memoryRequest
    } = req.body;

    try {
        // Validate inputs
        if (!deploymentName || !namespace || !imageName) {
            return res.status(400).json({ 
                success: false,
                error: 'Deployment name, namespace, and image name are required' 
            });
        }

        // Prepare deployment YAML
       let deploymentYaml = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${deploymentName}
  namespace: ${namespace}
spec:
  replicas: ${replicas || 1}
  revisionHistoryLimit: 10
  selector:
    matchLabels:
      app: ${deploymentName}
  template:
    metadata:
      labels:
        app: ${deploymentName}
    spec:
      containers:
      - name: ${deploymentName}
        image: ${imageName}
`;

        // Add ports if specified
        if (ports && ports.length > 0) {
            deploymentYaml += `        ports:\n`;
            ports.forEach(port => {
                if (port.containerPort) {
                    deploymentYaml += `        - containerPort: ${port.containerPort}\n`;
                    if (port.servicePort) {
                        deploymentYaml += `          hostPort: ${port.servicePort}\n`;
                    }
                }
            });
        }

        // Add environment variables if specified
        if (envVars && envVars.length > 0) {
            deploymentYaml += `        env:\n`;
            envVars.forEach(env => {
                if (env.name) {
                    deploymentYaml += `        - name: ${env.name}\n`;
                    deploymentYaml += `          value: "${env.value || ''}"\n`;
                }
            });
        }

        // Add resource limits and requests if specified
        if (cpuLimit || memoryLimit || cpuRequest || memoryRequest) {
            deploymentYaml += `        resources:\n`;
            deploymentYaml += `          limits:\n`;
            if (cpuLimit) deploymentYaml += `            cpu: "${cpuLimit}"\n`;
            if (memoryLimit) deploymentYaml += `            memory: "${memoryLimit}"\n`;
            deploymentYaml += `          requests:\n`;
            if (cpuRequest) deploymentYaml += `            cpu: "${cpuRequest}"\n`;
            if (memoryRequest) deploymentYaml += `            memory: "${memoryRequest}"\n`;
        }

        // Create temporary file with the YAML
        const tempFile = `/tmp/deployment-${Date.now()}.yaml`;
        fs.writeFileSync(tempFile, deploymentYaml);

        // Apply the deployment
        exec(`kubectl apply -f ${tempFile}`, (error, stdout, stderr) => {
            // Clean up the temporary file
            fs.unlinkSync(tempFile);

            if (error) {
                console.error('Error creating deployment:', error);
                return res.status(500).json({ 
                    success: false,
                    error: error.message,
                    stderr: stderr 
                });
            }

            res.json({ 
                success: true,
                message: `Deployment ${deploymentName} created successfully`,
                output: stdout
            });
        });
    } catch (error) {
        console.error('Error creating deployment:', error);
        res.status(500).json({ 
            success: false,
            message: 'Error creating deployment', 
            error: error.message 
        });
    }
};
// Create deployment from YAML
exports.createDeploymentFromYaml = async (req, res) => {
    const { yaml } = req.body;

    try {
        if (!yaml) {
            return res.status(400).json({ 
                success: false,
                error: 'YAML content is required' 
            });
        }

        // Validate YAML syntax
        try {
            const parsed = jsyaml.load(yaml);
            if (!parsed) {
                throw new Error('YAML content is empty');
            }
            
            if (parsed.kind !== 'Deployment') {
                throw new Error('YAML must define a Deployment resource');
            }
            
            if (!parsed.metadata || !parsed.metadata.name) {
                throw new Error('Deployment must have a name');
            }
        } catch (error) {
            return res.status(400).json({ 
                success: false,
                error: `Invalid YAML: ${error.message}`
            });
        }

        // Create temporary file with the YAML
        const tempFile = `/tmp/deployment-${Date.now()}.yaml`;
        fs.writeFileSync(tempFile, yaml);

        // Apply the deployment
        exec(`kubectl apply -f ${tempFile}`, (error, stdout, stderr) => {
            // Clean up the temporary file
            fs.unlinkSync(tempFile);

            if (error) {
                console.error('Error creating deployment:', error);
                return res.status(500).json({ 
                    success: false,
                    error: error.message,
                    stderr: stderr 
                });
            }

            res.json({ 
                success: true,
                message: 'Deployment created successfully from YAML',
                output: stdout
            });
        });
    } catch (error) {
        console.error('Error creating deployment from YAML:', error);
        res.status(500).json({ 
            success: false,
            message: 'Error creating deployment from YAML', 
            error: error.message 
        });
    }
};

// List all deployments
exports.listDeployments = async (req, res) => {
    const { namespace } = req.query;

    try {
        let command = 'kubectl get deployments --all-namespaces -o json';
        if (namespace) {
            command = `kubectl get deployments -n ${namespace} -o json`;
        }

        exec(command, (error, stdout, stderr) => {
            if (error) {
                console.error('Error listing deployments:', error);
                return res.status(500).json({ 
                    success: false,
                    error: error.message,
                    stderr: stderr 
                });
            }

            try {
                const deployments = JSON.parse(stdout);
                res.json(deployments);
            } catch (parseError) {
                console.error('Error parsing deployments JSON:', parseError);
                res.status(500).json({ 
                    success: false,
                    message: 'Error parsing deployments information', 
                    error: parseError.message,
                    output: stdout 
                });
            }
        });
    } catch (error) {
        console.error('Error listing deployments:', error);
        res.status(500).json({ 
            success: false,
            message: 'Error listing deployments', 
            error: error.message 
        });
    }
};

// Get deployment YAML
exports.getDeploymentYaml = async (req, res) => {
    const { name, namespace } = req.query;

    try {
        if (!name || !namespace) {
            return res.status(400).json({ 
                success: false,
                error: 'Deployment name and namespace are required' 
            });
        }

        exec(`kubectl get deployment ${name} -n ${namespace} -o yaml`, (error, stdout, stderr) => {
            if (error) {
                console.error('Error getting deployment YAML:', error);
                return res.status(500).json({ 
                    success: false,
                    error: error.message,
                    stderr: stderr 
                });
            }

            res.json({ 
                success: true,
                yaml: stdout
            });
        });
    } catch (error) {
        console.error('Error getting deployment YAML:', error);
        res.status(500).json({ 
            success: false,
            message: 'Error getting deployment YAML', 
            error: error.message 
        });
    }
};

// Scale a deployment
exports.scaleDeployment = async (req, res) => {
    const { deploymentName, namespace, replicaCount } = req.body;

    try {
        if (!deploymentName || !namespace || replicaCount === undefined) {
            return res.status(400).json({ 
                success: false,
                error: 'Deployment name, namespace, and replica count are required' 
            });
        }

        exec(`kubectl scale deployment ${deploymentName} -n ${namespace} --replicas=${replicaCount}`, (error, stdout, stderr) => {
            if (error) {
                console.error('Error scaling deployment:', error);
                return res.status(500).json({ 
                    success: false,
                    error: error.message,
                    stderr: stderr 
                });
            }

            res.json({ 
                success: true,
                message: `Deployment ${deploymentName} scaled to ${replicaCount} replicas`,
                output: stdout
            });
        });
    } catch (error) {
        console.error('Error scaling deployment:', error);
        res.status(500).json({ 
            success: false,
            message: 'Error scaling deployment', 
            error: error.message 
        });
    }
};

// Delete a deployment
exports.deleteDeployment = async (req, res) => {
    const { deploymentName, namespace } = req.body;

    try {
        if (!deploymentName || !namespace) {
            return res.status(400).json({ 
                success: false,
                error: 'Deployment name and namespace are required' 
            });
        }

        exec(`kubectl delete deployment ${deploymentName} -n ${namespace}`, (error, stdout, stderr) => {
            if (error) {
                console.error('Error deleting deployment:', error);
                return res.status(500).json({ 
                    success: false,
                    error: error.message,
                    stderr: stderr 
                });
            }

            res.json({ 
                success: true,
                message: `Deployment ${deploymentName} deleted`,
                output: stdout
            });
        });
    } catch (error) {
        console.error('Error deleting deployment:', error);
        res.status(500).json({ 
            success: false,
            message: 'Error deleting deployment', 
            error: error.message 
        });
    }
};

// List all namespaces
exports.listNamespaces = async (req, res) => {
    console.log('listNamespaces called'); 

    try {
        exec('kubectl get namespaces -o json', (error, stdout, stderr) => {
            if (error) {
                console.error('Error listing namespaces:', error);
                return res.status(500).json({ 
                    success: false,
                    error: error.message,
                    stderr: stderr 
                });
            }

            try {
                const namespaces = JSON.parse(stdout);
                res.json(namespaces);
            } catch (parseError) {
                console.error('Error parsing namespaces JSON:', parseError);
                res.status(500).json({ 
                    success: false,
                    message: 'Error parsing namespaces information', 
                    error: parseError.message,
                    output: stdout 
                });
            }
        });
    } catch (error) {
        console.error('Error listing namespaces:', error);
        res.status(500).json({ 
            success: false,
            message: 'Error listing namespaces', 
            error: error.message 
        });
    }
};


// Create a new service
exports.createService = async (req, res) => {
    const {
        serviceName,
        namespace,
        serviceType,
        externalName,
        selectors,
        ports
    } = req.body;

    try {
        // Validate inputs
        if (!serviceName || !namespace || !serviceType) {
            return res.status(400).json({ 
                success: false,
                error: 'Service name, namespace, and type are required' 
            });
        }

        if (serviceType === 'ExternalName' && !externalName) {
            return res.status(400).json({ 
                success: false,
                error: 'External name is required for ExternalName service type' 
            });
        }

        if (serviceType !== 'ExternalName' && (!selectors || Object.keys(selectors).length === 0)) {
            return res.status(400).json({ 
                success: false,
                error: 'Selector labels are required for non-ExternalName services' 
            });
        }

        if (serviceType !== 'ExternalName' && (!ports || ports.length === 0)) {
            return res.status(400).json({ 
                success: false,
                error: 'At least one port mapping is required for non-ExternalName services' 
            });
        }

        // Prepare service YAML
        let serviceYaml = `apiVersion: v1
kind: Service
metadata:
  name: ${serviceName}
  namespace: ${namespace}
spec:
  type: ${serviceType}
`;

        if (serviceType === 'ExternalName') {
            serviceYaml += `  externalName: ${externalName}\n`;
        } else {
            // Add selectors
            serviceYaml += `  selector:\n`;
            for (const [key, value] of Object.entries(selectors)) {
                serviceYaml += `    ${key}: ${value}\n`;
            }

            // Add ports with names
            serviceYaml += `  ports:\n`;
            ports.forEach((port, index) => {
                serviceYaml += `  - name: ${port.name || `port-${index}`}\n`;
                serviceYaml += `    port: ${port.port}\n`;
                serviceYaml += `    targetPort: ${port.targetPort}\n`;
                if (port.protocol && port.protocol !== 'TCP') {
                    serviceYaml += `    protocol: ${port.protocol}\n`;
                }
            });
        }

        // Create temporary file with the YAML
        const tempFile = `/tmp/service-${Date.now()}.yaml`;
        fs.writeFileSync(tempFile, serviceYaml);

        // Apply the service
        exec(`kubectl apply -f ${tempFile}`, (error, stdout, stderr) => {
            // Clean up the temporary file
            fs.unlinkSync(tempFile);

            if (error) {
                console.error('Error creating service:', error);
                return res.status(500).json({ 
                    success: false,
                    error: error.message,
                    stderr: stderr 
                });
            }

            res.json({ 
                success: true,
                message: `Service ${serviceName} created successfully`,
                output: stdout
            });
        });
    } catch (error) {
        console.error('Error creating service:', error);
        res.status(500).json({ 
            success: false,
            message: 'Error creating service', 
            error: error.message 
        });
    }
};

// List all services
exports.listServices = async (req, res) => {
    const { namespace } = req.query;

    try {
        let command = 'kubectl get services --all-namespaces -o json';
        if (namespace) {
            command = `kubectl get services -n ${namespace} -o json`;
        }

        exec(command, (error, stdout, stderr) => {
            if (error) {
                console.error('Error listing services:', error);
                return res.status(500).json({ 
                    success: false,
                    error: error.message,
                    stderr: stderr 
                });
            }

            try {
                const services = JSON.parse(stdout);
                res.json(services);
            } catch (parseError) {
                console.error('Error parsing services JSON:', parseError);
                res.status(500).json({ 
                    success: false,
                    message: 'Error parsing services information', 
                    error: parseError.message,
                    output: stdout 
                });
            }
        });
    } catch (error) {
        console.error('Error listing services:', error);
        res.status(500).json({ 
            success: false,
            message: 'Error listing services', 
            error: error.message 
        });
    }
};

// Get service YAML
exports.getServiceYaml = async (req, res) => {
    const { name, namespace } = req.query;

    try {
        if (!name || !namespace) {
            return res.status(400).json({ 
                success: false,
                error: 'Service name and namespace are required' 
            });
        }

        exec(`kubectl get service ${name} -n ${namespace} -o yaml`, (error, stdout, stderr) => {
            if (error) {
                console.error('Error getting service YAML:', error);
                return res.status(500).json({ 
                    success: false,
                    error: error.message,
                    stderr: stderr 
                });
            }

            res.json({ 
                success: true,
                yaml: stdout
            });
        });
    } catch (error) {
        console.error('Error getting service YAML:', error);
        res.status(500).json({ 
            success: false,
            message: 'Error getting service YAML', 
            error: error.message 
        });
    }
};

// Delete a service
exports.deleteService = async (req, res) => {
    const { serviceName, namespace } = req.body;

    try {
        if (!serviceName || !namespace) {
            return res.status(400).json({ 
                success: false,
                error: 'Service name and namespace are required' 
            });
        }

        exec(`kubectl delete service ${serviceName} -n ${namespace}`, (error, stdout, stderr) => {
            if (error) {
                console.error('Error deleting service:', error);
                return res.status(500).json({ 
                    success: false,
                    error: error.message,
                    stderr: stderr 
                });
            }

            res.json({ 
                success: true,
                message: `Service ${serviceName} deleted`,
                output: stdout
            });
        });
    } catch (error) {
        console.error('Error deleting service:', error);
        res.status(500).json({ 
            success: false,
            message: 'Error deleting service', 
            error: error.message 
        });
    }
};

exports.listPods = async (req, res) => {
    const { namespace, limit } = req.query;

    try {
        let command = 'kubectl get pods --all-namespaces --chunk-size=50 -o json';
        if (namespace) {
            command = `kubectl get pods -n ${namespace} --chunk-size=50 -o json`;
        }
        if (limit) {
            command += ` --limit=${limit}`;
        }

        const { spawn } = require('child_process');
        const child = spawn('kubectl', [
            'get', 'pods',
            ...(namespace ? ['-n', namespace] : ['--all-namespaces']),
            '--chunk-size=50',
            '-o', 'json'
        ]);

        let stdout = '';
        let stderr = '';

        child.stdout.on('data', (data) => {
            stdout += data.toString();
        });

        child.stderr.on('data', (data) => {
            stderr += data.toString();
        });

        child.on('close', (code) => {
            if (code !== 0) {
                console.error('Error listing pods:', stderr);
                return res.status(500).json({ 
                    success: false,
                    error: `Command failed with code ${code}`,
                    stderr: stderr 
                });
            }

            try {
                const pods = JSON.parse(stdout);
                res.json(pods);
            } catch (parseError) {
                console.error('Error parsing pods JSON:', parseError);
                res.status(500).json({ 
                    success: false,
                    message: 'Error parsing pods information', 
                    error: parseError.message,
                    output: stdout 
                });
            }
        });

    } catch (error) {
        console.error('Error listing pods:', error);
        res.status(500).json({ 
            success: false,
            message: 'Error listing pods', 
            error: error.message 
        });
    }
};

// Get pod containers
exports.getPodContainers = async (req, res) => {
    const { name, namespace } = req.query;

    try {
        if (!name || !namespace) {
            return res.status(400).json({ 
                success: false,
                error: 'Pod name and namespace are required' 
            });
        }

        exec(`kubectl get pod ${name} -n ${namespace} -o json`, (error, stdout, stderr) => {
            if (error) {
                console.error('Error getting pod containers:', error);
                return res.status(500).json({ 
                    success: false,
                    error: error.message,
                    stderr: stderr 
                });
            }

            try {
                const pod = JSON.parse(stdout);
                const containers = pod.spec.containers.map(c => c.name);
                res.json({ 
                    success: true,
                    containers 
                });
            } catch (parseError) {
                console.error('Error parsing pod JSON:', parseError);
                res.status(500).json({ 
                    success: false,
                    message: 'Error parsing pod information', 
                    error: parseError.message,
                    output: stdout 
                });
            }
        });
    } catch (error) {
        console.error('Error getting pod containers:', error);
        res.status(500).json({ 
            success: false,
            message: 'Error getting pod containers', 
            error: error.message 
        });
    }
};

// Get pod logs
exports.getPodLogs = async (req, res) => {
    const { name, namespace, container, tailLines } = req.query;

    try {
        if (!name || !namespace || !container) {
            return res.status(400).json({ 
                success: false,
                error: 'Pod name, namespace, and container are required' 
            });
        }

        let command = `kubectl logs ${name} -n ${namespace} -c ${container}`;
        if (tailLines) {
            command += ` --tail=${tailLines}`;
        }

        exec(command, (error, stdout, stderr) => {
            if (error) {
                console.error('Error getting pod logs:', error);
                return res.status(500).json({ 
                    success: false,
                    error: error.message,
                    stderr: stderr 
                });
            }

            res.json({ 
                success: true,
                logs: stdout 
            });
        });
    } catch (error) {
        console.error('Error getting pod logs:', error);
        res.status(500).json({ 
            success: false,
            message: 'Error getting pod logs', 
            error: error.message 
        });
    }
};

// Get pod YAML
exports.getPodYaml = async (req, res) => {
    const { name, namespace } = req.query;

    try {
        if (!name || !namespace) {
            return res.status(400).json({ 
                success: false,
                error: 'Pod name and namespace are required' 
            });
        }

        exec(`kubectl get pod ${name} -n ${namespace} -o yaml`, (error, stdout, stderr) => {
            if (error) {
                console.error('Error getting pod YAML:', error);
                return res.status(500).json({ 
                    success: false,
                    error: error.message,
                    stderr: stderr 
                });
            }

            res.json({ 
                success: true,
                yaml: stdout 
            });
        });
    } catch (error) {
        console.error('Error getting pod YAML:', error);
        res.status(500).json({ 
            success: false,
            message: 'Error getting pod YAML', 
            error: error.message 
        });
    }
};

// Delete a pod
exports.deletePod = async (req, res) => {
    const { podName, namespace } = req.body;

    try {
        if (!podName || !namespace) {
            return res.status(400).json({ 
                success: false,
                error: 'Pod name and namespace are required' 
            });
        }

        exec(`kubectl delete pod ${podName} -n ${namespace}`, (error, stdout, stderr) => {
            if (error) {
                console.error('Error deleting pod:', error);
                return res.status(500).json({ 
                    success: false,
                    error: error.message,
                    stderr: stderr 
                });
            }

            res.json({ 
                success: true,
                message: `Pod ${podName} deleted`,
                output: stdout 
            });
        });
    } catch (error) {
        console.error('Error deleting pod:', error);
        res.status(500).json({ 
            success: false,
            message: 'Error deleting pod', 
            error: error.message 
        });
    }
};

// Restart a pod 
exports.restartPod = async (req, res) => {
    const { podName, namespace } = req.body;

    try {
        if (!podName || !namespace) {
            return res.status(400).json({ 
                success: false,
                error: 'Pod name and namespace are required' 
            });
        }

        exec(`kubectl delete pod ${podName} -n ${namespace}`, (error, stdout, stderr) => {
            if (error) {
                console.error('Error restarting pod:', error);
                return res.status(500).json({ 
                    success: false,
                    error: error.message,
                    stderr: stderr 
                });
            }

            res.json({ 
                success: true,
                message: `Pod ${podName} restarted`,
                output: stdout 
            });
        });
    } catch (error) {
        console.error('Error restarting pod:', error);
        res.status(500).json({ 
            success: false,
            message: 'Error restarting pod', 
            error: error.message 
        });
    }
};
// List all PVCs
exports.listPVCs = async (req, res) => {
    const { namespace } = req.query;

    try {
        let command = 'kubectl get pvc --all-namespaces -o json';
        if (namespace) {
            command = `kubectl get pvc -n ${namespace} -o json`;
        }

        exec(command, (error, stdout, stderr) => {
            if (error) {
                console.error('Error listing PVCs:', error);
                return res.status(500).json({ 
                    success: false,
                    error: error.message,
                    stderr: stderr 
                });
            }

            try {
                const pvcs = JSON.parse(stdout);
                res.json(pvcs);
            } catch (parseError) {
                console.error('Error parsing PVCs JSON:', parseError);
                res.status(500).json({ 
                    success: false,
                    message: 'Error parsing PVCs information', 
                    error: parseError.message,
                    output: stdout 
                });
            }
        });
    } catch (error) {
        console.error('Error listing PVCs:', error);
        res.status(500).json({ 
            success: false,
            message: 'Error listing PVCs', 
            error: error.message 
        });
    }
};

// Get PVC YAML
exports.getPVCYaml = async (req, res) => {
    const { name, namespace } = req.query;

    try {
        if (!name || !namespace) {
            return res.status(400).json({ 
                success: false,
                error: 'PVC name and namespace are required' 
            });
        }

        exec(`kubectl get pvc ${name} -n ${namespace} -o yaml`, (error, stdout, stderr) => {
            if (error) {
                console.error('Error getting PVC YAML:', error);
                return res.status(500).json({ 
                    success: false,
                    error: error.message,
                    stderr: stderr 
                });
            }

            res.json({ 
                success: true,
                yaml: stdout 
            });
        });
    } catch (error) {
        console.error('Error getting PVC YAML:', error);
        res.status(500).json({ 
            success: false,
            message: 'Error getting PVC YAML', 
            error: error.message 
        });
    }
};

// Create a new PVC
exports.createPVC = async (req, res) => {
    const {
        pvcName,
        namespace,
        accessMode,
        storageClass,
        storageSize,
        deploymentData,
        mountPath
    } = req.body;

    try {
        // Validate inputs
        if (!pvcName || !namespace || !accessMode || !storageSize) {
            return res.status(400).json({ 
                success: false,
                error: 'PVC name, namespace, access mode, and storage size are required' 
            });
        }

        // Prepare PVC YAML
        let pvcYaml = `apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: ${pvcName}
  namespace: ${namespace}
spec:
  accessModes:
    - ${accessMode}
  resources:
    requests:
      storage: ${storageSize}Gi
`;

        if (storageClass) {
            pvcYaml += `  storageClassName: ${storageClass}\n`;
        }

        // Create temporary file with the YAML
        const tempFile = `/tmp/pvc-${Date.now()}.yaml`;
        fs.writeFileSync(tempFile, pvcYaml);

        // Apply the PVC
        exec(`kubectl apply -f ${tempFile}`, (error, stdout, stderr) => {
            // Clean up the temporary file
            fs.unlinkSync(tempFile);

            if (error) {
                console.error('Error creating PVC:', error);
                return res.status(500).json({ 
                    success: false,
                    error: error.message,
                    stderr: stderr 
                });
            }

            // If we need to mount to a deployment
            if (deploymentData && mountPath) {
                mountPVCToDeployment(pvcName, namespace, deploymentData, mountPath)
                    .then(() => {
                        res.json({ 
                            success: true,
                            message: `PVC ${pvcName} created and mounted to deployment ${deploymentData.metadata.name}`,
                            output: stdout
                        });
                    })
                    .catch(mountError => {
                        console.error('Error mounting PVC:', mountError);
                        res.status(500).json({ 
                            success: false,
                            message: 'PVC created but mounting failed',
                            error: mountError.message,
                            output: stdout
                        });
                    });
            } else {
                res.json({ 
                    success: true,
                    message: `PVC ${pvcName} created successfully`,
                    output: stdout
                });
            }
        });
    } catch (error) {
        console.error('Error creating PVC:', error);
        res.status(500).json({ 
            success: false,
            message: 'Error creating PVC', 
            error: error.message 
        });
    }
};

async function mountPVCToDeployment(pvcName, namespace, deploymentData, mountPath) {
    return new Promise((resolve, reject) => {
        // Get the current deployment
        exec(`kubectl get deployment ${deploymentData.metadata.name} -n ${deploymentData.metadata.namespace} -o json`, (error, stdout, stderr) => {
            if (error) {
                return reject(new Error(`Error getting deployment: ${error.message}`));
            }

            try {
                const deployment = JSON.parse(stdout);
                
                // Add volume to deployment
                if (!deployment.spec.template.spec.volumes) {
                    deployment.spec.template.spec.volumes = [];
                }
                
                deployment.spec.template.spec.volumes.push({
                    name: pvcName,
                    persistentVolumeClaim: {
                        claimName: pvcName
                    }
                });
                
                // Add volume mount to all containers
                deployment.spec.template.spec.containers.forEach(container => {
                    if (!container.volumeMounts) {
                        container.volumeMounts = [];
                    }
                    
                    container.volumeMounts.push({
                        name: pvcName,
                        mountPath: mountPath
                    });
                });
                
                // Create temporary file with the updated deployment
                const tempFile = `/tmp/deployment-${Date.now()}.yaml`;
                fs.writeFileSync(tempFile, JSON.stringify(deployment));
                
                // Apply the updated deployment
                exec(`kubectl apply -f ${tempFile}`, (applyError, applyStdout, applyStderr) => {
                    // Clean up the temporary file
                    fs.unlinkSync(tempFile);
                    
                    if (applyError) {
                        return reject(new Error(`Error updating deployment: ${applyError.message}`));
                    }
                    
                    resolve(applyStdout);
                });
            } catch (parseError) {
                reject(new Error(`Error parsing deployment JSON: ${parseError.message}`));
            }
        });
    });
}

// Delete a PVC
exports.deletePVC = async (req, res) => {
    const { pvcName, namespace } = req.body;

    try {
        if (!pvcName || !namespace) {
            return res.status(400).json({ 
                success: false,
                error: 'PVC name and namespace are required' 
            });
        }

        exec(`kubectl delete pvc ${pvcName} -n ${namespace}`, (error, stdout, stderr) => {
            if (error) {
                console.error('Error deleting PVC:', error);
                return res.status(500).json({ 
                    success: false,
                    error: error.message,
                    stderr: stderr 
                });
            }

            res.json({ 
                success: true,
                message: `PVC ${pvcName} deleted`,
                output: stdout 
            });
        });
    } catch (error) {
        console.error('Error deleting PVC:', error);
        res.status(500).json({ 
            success: false,
            message: 'Error deleting PVC', 
            error: error.message 
        });
    }
};

exports.listStorageClasses = async (req, res) => {
  try {
    const { stdout } = await execPromise('kubectl get storageclass -o json');
    const data = JSON.parse(stdout);
    
    data.items = data.items.map(sc => ({
      ...sc,
      status: sc.metadata.annotations?.['storageclass.kubernetes.io/is-default-class'] === 'true' ? 'Default' : 'Available'
    }));
    
    res.json(data);
  } catch (error) {
    res.status(500).json({ 
      error: 'Failed to get storage classes',
      details: error.message 
    });
  }
};

exports.createStorageClass = async (req, res) => {
  const { name, provisioner = 'kubernetes.io/no-provisioner', parameters = {}, isDefault = false } = req.body;

  const scYaml = `apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: ${name}
  annotations:
    storageclass.kubernetes.io/is-default-class: "${isDefault}"
provisioner: ${provisioner}
${Object.keys(parameters).length > 0 ? 'parameters:\n' + Object.entries(parameters).map(([k,v]) => `  ${k}: ${v}`).join('\n') : ''}
volumeBindingMode: WaitForFirstConsumer`;

  try {
    await execPromise(`echo '${scYaml}' | kubectl apply -f -`);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ 
      error: 'Failed to create storage class',
      details: error.message 
    });
  }
};

exports.setDefaultStorageClass = async (req, res) => {
  const { name } = req.body;
  
  try {
    await execPromise(`kubectl get storageclass -o name | xargs -n1 kubectl patch -p '{"metadata": {"annotations":{"storageclass.kubernetes.io/is-default-class":"false"}}}'`);
    
    await execPromise(`kubectl patch storageclass ${name} -p '{"metadata": {"annotations":{"storageclass.kubernetes.io/is-default-class":"true"}}}'`);
    
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ 
      error: 'Failed to set default storage class',
      details: error.message 
    });
  }
};

exports.deleteStorageClass = async (req, res) => {
  const { name } = req.params;
  
  try {
    // Check if any PVCs are using this storage class
    const { stdout } = await execPromise(`kubectl get pvc --all-namespaces -o json`);
    const pvcs = JSON.parse(stdout);
    
    const inUse = pvcs.items.some(pvc => pvc.spec.storageClassName === name);
    if (inUse) {
      return res.status(400).json({ 
        error: 'Cannot delete storage class - PVCs are using it' 
      });
    }
    
    await execPromise(`kubectl delete storageclass ${name}`);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ 
      error: 'Failed to delete storage class',
      details: error.message 
    });
  }
};

// Create a namespace
exports.createNamespace = async (req, res) => {
    const { namespaceName, labels } = req.body;

    try {
        // Validate inputs
        if (!namespaceName) {
            return res.status(400).json({ 
                success: false,
                error: 'Namespace name is required' 
            });
        }

        // Prepare namespace YAML
        let namespaceYaml = `apiVersion: v1
kind: Namespace
metadata:
  name: ${namespaceName}
`;

        if (labels && Object.keys(labels).length > 0) {
            namespaceYaml += `  labels:\n`;
            for (const [key, value] of Object.entries(labels)) {
                namespaceYaml += `    ${key}: ${value}\n`;
            }
        }

        // Create temporary file with the YAML
        const tempFile = `/tmp/namespace-${Date.now()}.yaml`;
        fs.writeFileSync(tempFile, namespaceYaml);

        // Apply the namespace
        exec(`kubectl apply -f ${tempFile}`, (error, stdout, stderr) => {
            // Clean up the temporary file
            fs.unlinkSync(tempFile);

            if (error) {
                console.error('Error creating namespace:', error);
                return res.status(500).json({ 
                    success: false,
                    error: error.message,
                    stderr: stderr 
                });
            }

            res.json({ 
                success: true,
                message: `Namespace ${namespaceName} created successfully`,
                output: stdout
            });
        });
    } catch (error) {
        console.error('Error creating namespace:', error);
        res.status(500).json({ 
            success: false,
            message: 'Error creating namespace', 
            error: error.message 
        });
    }
};

// Get namespace YAML
exports.getNamespaceYaml = async (req, res) => {
    const { name } = req.query;

    try {
        if (!name) {
            return res.status(400).json({ 
                success: false,
                error: 'Namespace name is required' 
            });
        }

        exec(`kubectl get namespace ${name} -o yaml`, (error, stdout, stderr) => {
            if (error) {
                console.error('Error getting namespace YAML:', error);
                return res.status(500).json({ 
                    success: false,
                    error: error.message,
                    stderr: stderr 
                });
            }

            res.json({ 
                success: true,
                yaml: stdout 
            });
        });
    } catch (error) {
        console.error('Error getting namespace YAML:', error);
        res.status(500).json({ 
            success: false,
            message: 'Error getting namespace YAML', 
            error: error.message 
        });
    }
};

// Delete a namespace
exports.deleteNamespace = async (req, res) => {
    const { namespaceName } = req.body;

    try {
        if (!namespaceName) {
            return res.status(400).json({ 
                success: false,
                error: 'Namespace name is required' 
            });
        }

        // Prevent deletion of system namespaces
        if (namespaceName === 'default' || namespaceName === 'kube-system') {
            return res.status(403).json({ 
                success: false,
                error: 'Cannot delete system namespaces' 
            });
        }

        exec(`kubectl delete namespace ${namespaceName}`, (error, stdout, stderr) => {
            if (error) {
                console.error('Error deleting namespace:', error);
                return res.status(500).json({ 
                    success: false,
                    error: error.message,
                    stderr: stderr 
                });
            }

            res.json({ 
                success: true,
                message: `Namespace ${namespaceName} deleted`,
                output: stdout 
            });
        });
    } catch (error) {
        console.error('Error deleting namespace:', error);
        res.status(500).json({ 
            success: false,
            message: 'Error deleting namespace', 
            error: error.message 
        });
    }
};


// List all PVs
exports.listPVs = async (req, res) => {
    const { status } = req.query;

    try {
        let command = 'kubectl get pv -o json';
        if (status) {
            command = `kubectl get pv --field-selector=status.phase=${status} -o json`;
        }

        exec(command, (error, stdout, stderr) => {
            if (error) {
                console.error('Error listing PVs:', error);
                return res.status(500).json({ 
                    success: false,
                    error: error.message,
                    stderr: stderr 
                });
            }

            try {
                const pvs = JSON.parse(stdout);
                res.json(pvs);
            } catch (parseError) {
                console.error('Error parsing PVs JSON:', parseError);
                res.status(500).json({ 
                    success: false,
                    message: 'Error parsing PVs information', 
                    error: parseError.message,
                    output: stdout 
                });
            }
        });
    } catch (error) {
        console.error('Error listing PVs:', error);
        res.status(500).json({ 
            success: false,
            message: 'Error listing PVs', 
            error: error.message 
        });
    }
};

// Get PV YAML
exports.getPVYaml = async (req, res) => {
    const { name } = req.query;

    try {
        if (!name) {
            return res.status(400).json({ 
                success: false,
                error: 'PV name is required' 
            });
        }

        exec(`kubectl get pv ${name} -o yaml`, (error, stdout, stderr) => {
            if (error) {
                console.error('Error getting PV YAML:', error);
                return res.status(500).json({ 
                    success: false,
                    error: error.message,
                    stderr: stderr 
                });
            }

            res.json({ 
                success: true,
                yaml: stdout 
            });
        });
    } catch (error) {
        console.error('Error getting PV YAML:', error);
        res.status(500).json({ 
            success: false,
            message: 'Error getting PV YAML', 
            error: error.message 
        });
    }
};

// Create a new PV
exports.createPV = async (req, res) => {
    const {
        pvName,
        capacity,
        accessMode,
        storageClass,
        reclaimPolicy,
        path
    } = req.body;

    try {
        // Validate inputs
        if (!pvName || !capacity || !accessMode || !reclaimPolicy || !path) {
            return res.status(400).json({ 
                success: false,
                error: 'PV name, capacity, access mode, reclaim policy, and path are required' 
            });
        }

        // Prepare PV YAML
        let pvYaml = `apiVersion: v1
kind: PersistentVolume
metadata:
  name: ${pvName}
spec:
  capacity:
    storage: ${capacity}Gi
  accessModes:
    - ${accessMode}
  persistentVolumeReclaimPolicy: ${reclaimPolicy}
  hostPath:
    path: ${path}
`;

        if (storageClass) {
            pvYaml += `  storageClassName: ${storageClass}\n`;
        }

        // Create temporary file with the YAML
        const tempFile = `/tmp/pv-${Date.now()}.yaml`;
        fs.writeFileSync(tempFile, pvYaml);

        // Apply the PV
        exec(`kubectl apply -f ${tempFile}`, (error, stdout, stderr) => {
            // Clean up the temporary file
            fs.unlinkSync(tempFile);

            if (error) {
                console.error('Error creating PV:', error);
                return res.status(500).json({ 
                    success: false,
                    error: error.message,
                    stderr: stderr 
                });
            }

            res.json({ 
                success: true,
                message: `PV ${pvName} created successfully`,
                output: stdout
            });
        });
    } catch (error) {
        console.error('Error creating PV:', error);
        res.status(500).json({ 
            success: false,
            message: 'Error creating PV', 
            error: error.message 
        });
    }
};

// Delete a PV
exports.deletePV = async (req, res) => {
  const { pvName } = req.body;
  
  try {
    if (!pvName) {
      return res.status(400).json({ error: 'PV name is required' });
    }
    
    const { stdout: pvInfo } = await execPromise(`kubectl get pv ${pvName} -o json`);
    const pv = JSON.parse(pvInfo);
    
    if (pv.status.phase === 'Bound') {
      return res.status(400).json({ 
        error: 'Cannot delete bound PV. Delete the PVC first.' 
      });
    }
    
    await execPromise(`kubectl delete pv ${pvName} --force --grace-period=0`);
    
    res.json({ 
      success: true,
      message: `PV ${pvName} deleted successfully`
    });
  } catch (error) {
    console.error('Error deleting PV:', error);
    res.status(500).json({ 
      error: 'Failed to delete PV',
      details: error.message 
    });
  }
};

// List all ConfigMaps
exports.listConfigMaps = async (req, res) => {
    const { namespace } = req.query;

    try {
        let command = 'kubectl get configmaps --all-namespaces -o json';
        if (namespace) {
            command = `kubectl get configmaps -n ${namespace} -o json`;
        }

        exec(command, (error, stdout, stderr) => {
            if (error) {
                console.error('Error listing ConfigMaps:', error);
                return res.status(500).json({ 
                    success: false,
                    error: error.message,
                    stderr: stderr 
                });
            }

            try {
                const configMaps = JSON.parse(stdout);
                res.json(configMaps);
            } catch (parseError) {
                console.error('Error parsing ConfigMaps JSON:', parseError);
                res.status(500).json({ 
                    success: false,
                    message: 'Error parsing ConfigMaps information', 
                    error: parseError.message,
                    output: stdout 
                });
            }
        });
    } catch (error) {
        console.error('Error listing ConfigMaps:', error);
        res.status(500).json({ 
            success: false,
            message: 'Error listing ConfigMaps', 
            error: error.message 
        });
    }
};

// Get ConfigMap YAML
exports.getConfigMapYaml = async (req, res) => {
    const { name, namespace } = req.query;

    try {
        if (!name || !namespace) {
            return res.status(400).json({ 
                success: false,
                error: 'ConfigMap name and namespace are required' 
            });
        }

        exec(`kubectl get configmap ${name} -n ${namespace} -o yaml`, (error, stdout, stderr) => {
            if (error) {
                console.error('Error getting ConfigMap YAML:', error);
                return res.status(500).json({ 
                    success: false,
                    error: error.message,
                    stderr: stderr 
                });
            }

            res.json({ 
                success: true,
                yaml: stdout 
            });
        });
    } catch (error) {
        console.error('Error getting ConfigMap YAML:', error);
        res.status(500).json({ 
            success: false,
            message: 'Error getting ConfigMap YAML', 
            error: error.message 
        });
    }
};

// Get ConfigMap data
exports.getConfigMapData = async (req, res) => {
    const { name, namespace } = req.query;

    try {
        if (!name || !namespace) {
            return res.status(400).json({ 
                success: false,
                error: 'ConfigMap name and namespace are required' 
            });
        }

        exec(`kubectl get configmap ${name} -n ${namespace} -o json`, (error, stdout, stderr) => {
            if (error) {
                console.error('Error getting ConfigMap data:', error);
                return res.status(500).json({ 
                    success: false,
                    error: error.message,
                    stderr: stderr 
                });
            }

            try {
                const configMap = JSON.parse(stdout);
                res.json({ 
                    success: true,
                    data: configMap.data || {} 
                });
            } catch (parseError) {
                console.error('Error parsing ConfigMap JSON:', parseError);
                res.status(500).json({ 
                    success: false,
                    message: 'Error parsing ConfigMap information', 
                    error: parseError.message,
                    output: stdout 
                });
            }
        });
    } catch (error) {
        console.error('Error getting ConfigMap data:', error);
        res.status(500).json({ 
            success: false,
            message: 'Error getting ConfigMap data', 
            error: error.message 
        });
    }
};

// Create a new ConfigMap
exports.createConfigMap = async (req, res) => {
  try {
    let { name, namespace, type, data } = req.body;

    // Handle file uploads
    if (req.file) {
      // Process uploaded file
      const fileContent = req.file.buffer.toString('utf8');
      data = { [req.file.originalname]: fileContent };
    } else if (req.files?.envfile) {
      // Process env file
      const envContent = req.files.envfile[0].buffer.toString('utf8');
      data = {};
      envContent.split('\n').forEach(line => {
        const [key, value] = line.split('=');
        if (key && value) data[key.trim()] = value.trim();
      });
    }

    if (!name || !namespace || !type) {
      return res.status(400).json({ 
        success: false,
        error: 'ConfigMap name, namespace, and type are required' 
      });
    }

    // Create the ConfigMap
    const configMapYaml = `apiVersion: v1
kind: ConfigMap
metadata:
  name: ${name}
  namespace: ${namespace}
data:
${Object.entries(data).map(([k, v]) => `  ${k}: ${v}`).join('\n')}
`;

    await execPromise(`echo '${configMapYaml}' | kubectl apply -f -`);

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
};

// Delete a ConfigMap
exports.deleteConfigMap = async (req, res) => {
    const { name, namespace } = req.body;

    try {
        if (!name || !namespace) {
            return res.status(400).json({ 
                success: false,
                error: 'ConfigMap name and namespace are required' 
            });
        }

        exec(`kubectl delete configmap ${name} -n ${namespace}`, (error, stdout, stderr) => {
            if (error) {
                console.error('Error deleting ConfigMap:', error);
                return res.status(500).json({ 
                    success: false,
                    error: error.message,
                    stderr: stderr 
                });
            }

            res.json({ 
                success: true,
                message: `ConfigMap ${name} deleted`,
                output: stdout 
            });
        });
    } catch (error) {
        console.error('Error deleting ConfigMap:', error);
        res.status(500).json({ 
            success: false,
            message: 'Error deleting ConfigMap', 
            error: error.message 
        });
    }
};

// List all Secrets
exports.listSecrets = async (req, res) => {
    const { namespace } = req.query;

    try {
        let command = 'kubectl get secrets --all-namespaces -o json';
        if (namespace) {
            command = `kubectl get secrets -n ${namespace} -o json`;
        }

        exec(command, (error, stdout, stderr) => {
            if (error) {
                console.error('Error listing Secrets:', error);
                return res.status(500).json({ 
                    success: false,
                    error: error.message,
                    stderr: stderr 
                });
            }

            try {
                const secrets = JSON.parse(stdout);
                res.json(secrets);
            } catch (parseError) {
                console.error('Error parsing Secrets JSON:', parseError);
                res.status(500).json({ 
                    success: false,
                    message: 'Error parsing Secrets information', 
                    error: parseError.message,
                    output: stdout 
                });
            }
        });
    } catch (error) {
        console.error('Error listing Secrets:', error);
        res.status(500).json({ 
            success: false,
            message: 'Error listing Secrets', 
            error: error.message 
        });
    }
};

// Get Secret YAML
exports.getSecretYaml = async (req, res) => {
    const { name, namespace } = req.query;

    try {
        if (!name || !namespace) {
            return res.status(400).json({ 
                success: false,
                error: 'Secret name and namespace are required' 
            });
        }

        exec(`kubectl get secret ${name} -n ${namespace} -o yaml`, (error, stdout, stderr) => {
            if (error) {
                console.error('Error getting Secret YAML:', error);
                return res.status(500).json({ 
                    success: false,
                    error: error.message,
                    stderr: stderr 
                });
            }

            res.json({ 
                success: true,
                yaml: stdout 
            });
        });
    } catch (error) {
        console.error('Error getting Secret YAML:', error);
        res.status(500).json({ 
            success: false,
            message: 'Error getting Secret YAML', 
            error: error.message 
        });
    }
};

// Get Secret data
exports.getSecretData = async (req, res) => {
    const { name, namespace } = req.query;

    try {
        if (!name || !namespace) {
            return res.status(400).json({ 
                success: false,
                error: 'Secret name and namespace are required' 
            });
        }

        exec(`kubectl get secret ${name} -n ${namespace} -o json`, (error, stdout, stderr) => {
            if (error) {
                console.error('Error getting Secret data:', error);
                return res.status(500).json({ 
                    success: false,
                    error: error.message,
                    stderr: stderr 
                });
            }

            try {
                const secret = JSON.parse(stdout);
                res.json({ 
                    success: true,
                    data: secret.data || {} 
                });
            } catch (parseError) {
                console.error('Error parsing Secret JSON:', parseError);
                res.status(500).json({ 
                    success: false,
                    message: 'Error parsing Secret information', 
                    error: parseError.message,
                    output: stdout 
                });
            }
        });
    } catch (error) {
        console.error('Error getting Secret data:', error);
        res.status(500).json({ 
            success: false,
            message: 'Error getting Secret data', 
            error: error.message 
        });
    }
};

// Create a new Secret
exports.createSecret = async (req, res) => {
  try {
    const { name, namespace, type, data } = req.body;

    if (!name || !namespace || !type) {
      return res.status(400).json({ 
        success: false,
        error: 'Secret name, namespace, and type are required' 
      });
    }

    // Create the Secret
    const secretYaml = `apiVersion: v1
kind: Secret
metadata:
  name: ${name}
  namespace: ${namespace}
type: ${type}
data:
${Object.entries(data).map(([k, v]) => `  ${k}: ${v}`).join('\n')}
`;

    await execPromise(`echo '${secretYaml}' | kubectl apply -f -`);

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
};

// Delete a Secret
exports.deleteSecret = async (req, res) => {
    const { name, namespace } = req.body;

    try {
        if (!name || !namespace) {
            return res.status(400).json({ 
                success: false,
                error: 'Secret name and namespace are required' 
            });
        }

        exec(`kubectl delete secret ${name} -n ${namespace}`, (error, stdout, stderr) => {
            if (error) {
                console.error('Error deleting Secret:', error);
                return res.status(500).json({ 
                    success: false,
                    error: error.message,
                    stderr: stderr 
                });
            }

            res.json({ 
                success: true,
                message: `Secret ${name} deleted`,
                output: stdout 
            });
        });
    } catch (error) {
        console.error('Error deleting Secret:', error);
        res.status(500).json({ 
            success: false,
            message: 'Error deleting Secret', 
            error: error.message 
        });
    }
};



// List all StatefulSets
exports.listStatefulSets = async (req, res) => {
    const { namespace } = req.query;

    try {
        let command = 'kubectl get statefulsets --all-namespaces -o json';
        if (namespace) {
            command = `kubectl get statefulsets -n ${namespace} -o json`;
        }

        exec(command, (error, stdout, stderr) => {
            if (error) {
                console.error('Error listing StatefulSets:', error);
                return res.status(500).json({ 
                    success: false,
                    error: error.message,
                    stderr: stderr 
                });
            }

            try {
                const statefulSets = JSON.parse(stdout);
                res.json(statefulSets);
            } catch (parseError) {
                console.error('Error parsing StatefulSets JSON:', parseError);
                res.status(500).json({ 
                    success: false,
                    message: 'Error parsing StatefulSets information', 
                    error: parseError.message,
                    output: stdout 
                });
            }
        });
    } catch (error) {
        console.error('Error listing StatefulSets:', error);
        res.status(500).json({ 
            success: false,
            message: 'Error listing StatefulSets', 
            error: error.message 
        });
    }
};

// Get StatefulSet YAML
exports.getStatefulSetYaml = async (req, res) => {
    const { name, namespace } = req.query;

    try {
        if (!name || !namespace) {
            return res.status(400).json({ 
                success: false,
                error: 'StatefulSet name and namespace are required' 
            });
        }

        exec(`kubectl get statefulset ${name} -n ${namespace} -o yaml`, (error, stdout, stderr) => {
            if (error) {
                console.error('Error getting StatefulSet YAML:', error);
                return res.status(500).json({ 
                    success: false,
                    error: error.message,
                    stderr: stderr 
                });
            }

            res.json({ 
                success: true,
                yaml: stdout 
            });
        });
    } catch (error) {
        console.error('Error getting StatefulSet YAML:', error);
        res.status(500).json({ 
            success: false,
            message: 'Error getting StatefulSet YAML', 
            error: error.message 
        });
    }
};

// Get StatefulSet Pods
exports.getStatefulSetPods = async (req, res) => {
    const { name, namespace } = req.query;

    try {
        if (!name || !namespace) {
            return res.status(400).json({ 
                success: false,
                error: 'StatefulSet name and namespace are required' 
            });
        }

        exec(`kubectl get pods -n ${namespace} -l app=${name} -o json`, (error, stdout, stderr) => {
            if (error) {
                console.error('Error getting StatefulSet Pods:', error);
                return res.status(500).json({ 
                    success: false,
                    error: error.message,
                    stderr: stderr 
                });
            }

            try {
                const pods = JSON.parse(stdout);
                res.json(pods);
            } catch (parseError) {
                console.error('Error parsing Pods JSON:', parseError);
                res.status(500).json({ 
                    success: false,
                    message: 'Error parsing Pods information', 
                    error: parseError.message,
                    output: stdout 
                });
            }
        });
    } catch (error) {
        console.error('Error getting StatefulSet Pods:', error);
        res.status(500).json({ 
            success: false,
            message: 'Error getting StatefulSet Pods', 
            error: error.message 
        });
    }
};


exports.getStatefulSetPodLogs = async (req, res) => {
    const { podName, namespace, container, tailLines } = req.query;

    try {
        if (!podName || !namespace) {
            return res.status(400).json({ 
                success: false,
                error: 'Pod name and namespace are required' 
            });
        }

        if (!container) {
            const { stdout } = await execPromise(`kubectl get pod ${podName} -n ${namespace} -o json`);
            const pod = JSON.parse(stdout);
            
            if (!pod.spec.containers || pod.spec.containers.length === 0) {
                return res.status(400).json({
                    success: false,
                    error: 'No containers found in pod'
                });
            }
            
            return res.json({
                success: true,
                containers: pod.spec.containers.map(c => c.name)
            });
        }

        // Build logs command
        let command = `kubectl logs ${podName} -n ${namespace} -c ${container}`;
        if (tailLines) {
            command += ` --tail=${tailLines}`;
        }

        const { stdout } = await execPromise(command);
        
        res.json({ 
            success: true,
            logs: stdout 
        });
    } catch (error) {
        res.status(500).json({ 
            success: false,
            message: 'Error getting pod logs', 
            error: error.message,
            stderr: error.stderr 
        });
    }
};
// Create a new StatefulSet
exports.createStatefulSet = async (req, res) => {
    const {
        name,
        namespace,
        replicas,
        serviceName,
        container,
        volumeClaims
    } = req.body;

    try {
        // Validate inputs
        if (!name || !namespace || !replicas || !serviceName || !container || !container.name || !container.image || !container.port) {
            return res.status(400).json({ 
                success: false,
                error: 'StatefulSet name, namespace, replicas, serviceName, and container details are required' 
            });
        }

        // Prepare StatefulSet YAML
        let statefulSetYaml = `apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: ${name}
  namespace: ${namespace}
spec:
  serviceName: "${serviceName}"
  replicas: ${replicas}
  selector:
    matchLabels:
      app: ${name}
  template:
    metadata:
      labels:
        app: ${name}
    spec:
      containers:
      - name: ${container.name}
        image: ${container.image}
        ports:
        - containerPort: ${container.port}
`;

        // Add environment variables if specified
        if (container.envVars && Object.keys(container.envVars).length > 0) {
            statefulSetYaml += `        env:\n`;
            for (const [key, value] of Object.entries(container.envVars)) {
                statefulSetYaml += `        - name: ${key}\n          value: "${value}"\n`;
            }
        }

        // Add volume mounts if specified
        if (volumeClaims && volumeClaims.length > 0) {
            statefulSetYaml += `        volumeMounts:\n`;
            volumeClaims.forEach(claim => {
                statefulSetYaml += `        - name: ${claim.name}\n          mountPath: ${claim.mountPath}\n`;
            });
        }

        // Add volume claim templates if specified
        if (volumeClaims && volumeClaims.length > 0) {
            statefulSetYaml += `  volumeClaimTemplates:\n`;
            volumeClaims.forEach(claim => {
                statefulSetYaml += `  - metadata:
      name: ${claim.name}
    spec:
      accessModes: [ "ReadWriteOnce" ]
      resources:
        requests:
          storage: ${claim.size}Gi\n`;
            });
        }

        // Create temporary file with the YAML
        const tempFile = `/tmp/statefulset-${Date.now()}.yaml`;
        fs.writeFileSync(tempFile, statefulSetYaml);

        // Apply the StatefulSet
        exec(`kubectl apply -f ${tempFile}`, (error, stdout, stderr) => {
            // Clean up the temporary file
            fs.unlinkSync(tempFile);

            if (error) {
                console.error('Error creating StatefulSet:', error);
                return res.status(500).json({ 
                    success: false,
                    error: error.message,
                    stderr: stderr 
                });
            }

            res.json({ 
                success: true,
                message: `StatefulSet ${name} created successfully`,
                output: stdout
            });
        });
    } catch (error) {
        console.error('Error creating StatefulSet:', error);
        res.status(500).json({ 
            success: false,
            message: 'Error creating StatefulSet', 
            error: error.message 
        });
    }
};

// Scale a StatefulSet
exports.scaleStatefulSet = async (req, res) => {
    const { name, namespace, replicas } = req.body;

    try {
        if (!name || !namespace || replicas === undefined) {
            return res.status(400).json({ 
                success: false,
                error: 'StatefulSet name, namespace, and replicas are required' 
            });
        }

        exec(`kubectl scale statefulset ${name} -n ${namespace} --replicas=${replicas}`, (error, stdout, stderr) => {
            if (error) {
                console.error('Error scaling StatefulSet:', error);
                return res.status(500).json({ 
                    success: false,
                    error: error.message,
                    stderr: stderr 
                });
            }

            res.json({ 
                success: true,
                message: `StatefulSet ${name} scaled to ${replicas} replicas`,
                output: stdout
            });
        });
    } catch (error) {
        console.error('Error scaling StatefulSet:', error);
        res.status(500).json({ 
            success: false,
            message: 'Error scaling StatefulSet', 
            error: error.message 
        });
    }
};

// Delete a StatefulSet
exports.deleteStatefulSet = async (req, res) => {
    const { name, namespace } = req.body;

    try {
        if (!name || !namespace) {
            return res.status(400).json({ 
                success: false,
                error: 'StatefulSet name and namespace are required' 
            });
        }

        exec(`kubectl delete statefulset ${name} -n ${namespace}`, (error, stdout, stderr) => {
            if (error) {
                console.error('Error deleting StatefulSet:', error);
                return res.status(500).json({ 
                    success: false,
                    error: error.message,
                    stderr: stderr 
                });
            }

            res.json({ 
                success: true,
                message: `StatefulSet ${name} deleted`,
                output: stdout
            });
        });
    } catch (error) {
        console.error('Error deleting StatefulSet:', error);
        res.status(500).json({ 
            success: false,
            message: 'Error deleting StatefulSet', 
            error: error.message 
        });
    }
};



exports.listIngresses = async (req, res) => {
    const { namespace } = req.query;

    try {
        let command = 'kubectl get ingresses --all-namespaces -o json';
        if (namespace) {
            command = `kubectl get ingresses -n ${namespace} -o json`;
        }

        exec(command, (error, stdout, stderr) => {
            if (error) {
                console.error('Error listing ingresses:', error);
                return res.status(500).json({ 
                    success: false,
                    error: error.message,
                    stderr: stderr 
                });
            }

            try {
                const ingresses = JSON.parse(stdout);
                res.json(ingresses);
            } catch (parseError) {
                console.error('Error parsing ingresses JSON:', parseError);
                res.status(500).json({ 
                    success: false,
                    message: 'Error parsing ingresses information', 
                    error: parseError.message,
                    output: stdout 
                });
            }
        });
    } catch (error) {
        console.error('Error listing ingresses:', error);
        res.status(500).json({ 
            success: false,
            message: 'Error listing ingresses', 
            error: error.message 
        });
    }
};

// Get ingress YAML
exports.getIngressYaml = async (req, res) => {
    const { name, namespace } = req.query;

    try {
        if (!name || !namespace) {
            return res.status(400).json({ 
                success: false,
                error: 'Ingress name and namespace are required' 
            });
        }

        exec(`kubectl get ingress ${name} -n ${namespace} -o yaml`, (error, stdout, stderr) => {
            if (error) {
                console.error('Error getting ingress YAML:', error);
                return res.status(500).json({ 
                    success: false,
                    error: error.message,
                    stderr: stderr 
                });
            }

            res.json({ 
                success: true,
                yaml: stdout 
            });
        });
    } catch (error) {
        console.error('Error getting ingress YAML:', error);
        res.status(500).json({ 
            success: false,
            message: 'Error getting ingress YAML', 
            error: error.message 
        });
    }
};

// Create a new ingress
exports.createIngress = async (req, res) => {
    const {
        ingressName,
        namespace,
        ingressClassName,
        rules,
        tls
    } = req.body;

    try {
        // Validate inputs
        if (!ingressName || !namespace || !rules || rules.length === 0) {
            return res.status(400).json({ 
                success: false,
                error: 'Ingress name, namespace, and at least one rule are required' 
            });
        }

        // Prepare ingress YAML
        let ingressYaml = `apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: ${ingressName}
  namespace: ${namespace}
spec:
`;

        if (ingressClassName) {
            ingressYaml += `  ingressClassName: ${ingressClassName}\n`;
        }

        // Add rules
        ingressYaml += `  rules:\n`;
        rules.forEach(rule => {
            ingressYaml += `  - host: ${rule.host}\n`;
            ingressYaml += `    http:\n`;
            ingressYaml += `      paths:\n`;
            
            rule.paths.forEach(path => {
                ingressYaml += `      - path: ${path.path}\n`;
                ingressYaml += `        pathType: ${path.pathType || 'Prefix'}\n`;
                ingressYaml += `        backend:\n`;
                ingressYaml += `          service:\n`;
                ingressYaml += `            name: ${path.serviceName}\n`;
                ingressYaml += `            port:\n`;
                ingressYaml += `              number: ${path.servicePort}\n`;
            });
        });

        // Add TLS if specified
        if (tls && tls.length > 0) {
            ingressYaml += `  tls:\n`;
            tls.forEach(tlsConfig => {
                ingressYaml += `  - hosts:\n`;
                tlsConfig.hosts.forEach(host => {
                    ingressYaml += `    - ${host}\n`;
                });
                ingressYaml += `    secretName: ${tlsConfig.secretName}\n`;
            });
        }

        // Create temporary file with the YAML
        const tempFile = `/tmp/ingress-${Date.now()}.yaml`;
        fs.writeFileSync(tempFile, ingressYaml);

        // Apply the ingress
        exec(`kubectl apply -f ${tempFile}`, (error, stdout, stderr) => {
            // Clean up the temporary file
            fs.unlinkSync(tempFile);

            if (error) {
                console.error('Error creating ingress:', error);
                return res.status(500).json({ 
                    success: false,
                    error: error.message,
                    stderr: stderr 
                });
            }

            res.json({ 
                success: true,
                message: `Ingress ${ingressName} created successfully`,
                output: stdout
            });
        });
    } catch (error) {
        console.error('Error creating ingress:', error);
        res.status(500).json({ 
            success: false,
            message: 'Error creating ingress', 
            error: error.message 
        });
    }
};

// Delete an ingress
exports.deleteIngress = async (req, res) => {
    const { ingressName, namespace } = req.body;

    try {
        if (!ingressName || !namespace) {
            return res.status(400).json({ 
                success: false,
                error: 'Ingress name and namespace are required' 
            });
        }

        exec(`kubectl delete ingress ${ingressName} -n ${namespace}`, (error, stdout, stderr) => {
            if (error) {
                console.error('Error deleting ingress:', error);
                return res.status(500).json({ 
                    success: false,
                    error: error.message,
                    stderr: stderr 
                });
            }

            res.json({ 
                success: true,
                message: `Ingress ${ingressName} deleted`,
                output: stdout 
            });
        });
    } catch (error) {
        console.error('Error deleting ingress:', error);
        res.status(500).json({ 
            success: false,
            message: 'Error deleting ingress', 
            error: error.message 
        });
    }
};


exports.getDeploymentHistory = async (req, res) => {
    try {
        const { name, namespace } = req.query;

        if (!name || !namespace) {
            return res.status(400).json({ 
                success: false,
                error: 'Deployment name and namespace are required' 
            });
        }

        const { stdout: historyStdout } = await execPromise(
            `kubectl rollout history deployment/${name} -n ${namespace}`
        );

        // Parse the basic history to get revision numbers
        const revisions = [];
        const lines = historyStdout.split('\n');
        
        // Skip the header line
        for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    
    const parts = line.split(/\s+/).filter(Boolean); 
    if (parts.length >= 2) {
        const revision = parseInt(parts[0]);
        if (!isNaN(revision)) { 
            revisions.push({
                revision: revision,
                changeCause: parts[1] || 'No change cause',
            });
        }
    }
}

        const history = [];
        for (const rev of revisions) {
            try {
                const { stdout: details } = await execPromise(
                    `kubectl rollout history deployment/${name} -n ${namespace} --revision=${rev.revision}`
                );

                let image = 'Unknown';
                const imageMatch = details.match(/Image:\s+(\S+)/);
                if (imageMatch) {
                    image = imageMatch[1];
                }

                let date = 'Unknown';
                const dateMatch = details.match(/CreationTimestamp:\s+(.*)/);
                if (dateMatch) {
                    date = new Date(dateMatch[1]).toLocaleString();
                }

                history.push({
                    revision: rev.revision,
                    changeCause: rev.changeCause,
                    image: image,
                    date: date,
                    details: details
                });
            } catch (error) {
                console.error(`Error getting details for revision ${rev.revision}:`, error);
                history.push({
                    revision: rev.revision,
                    changeCause: rev.changeCause,
                    image: 'Error loading',
                    date: 'Error loading',
                    details: 'Error loading details'
                });
            }
        }

        history.sort((a, b) => b.revision - a.revision);

        res.json({ 
            success: true,
            history
        });
    } catch (error) {
        console.error('Error getting deployment history:', error);
        res.status(500).json({ 
            success: false,
            message: 'Error getting deployment history', 
            error: error.message,
            stderr: error.stderr || ''
        });
    }
};

// Get details for a specific revision
exports.getRevisionDetails = async (req, res) => {
    try {
        const { name, namespace, revision } = req.query;

        if (!name || !namespace || !revision) {
            return res.status(400).json({ 
                success: false,
                error: 'Deployment name, namespace and revision are required' 
            });
        }

        // Get the specific revision details
        const { stdout } = await execPromise(
            `kubectl rollout history deployment/${name} -n ${namespace} --revision=${revision}`
        );

        // Extract the image information from the revision details
        let image = 'Unknown';
        const imageMatch = stdout.match(/Image:\s+(\S+)/);
        if (imageMatch) {
            image = imageMatch[1];
        }

        res.json({ 
            success: true,
            revision: parseInt(revision),
            image,
            details: stdout
        });
    } catch (error) {
        res.status(500).json({ 
            success: false,
            message: 'Error getting revision details', 
            error: error.message,
            stderr: error.stderr || ''
        });
    }
};

exports.rollbackDeployment = async (req, res) => {
    const { deploymentName, namespace, revision } = req.body;

    try {
        if (!deploymentName || !namespace || revision === undefined) {
            return res.status(400).json({ 
                success: false,
                error: 'Deployment name, namespace, and revision are required' 
            });
        }

        const revisionNumber = parseInt(revision);
        if (isNaN(revisionNumber)) {
            return res.status(400).json({ 
                success: false,
                error: 'Invalid revision number' 
            });
        }

        // Execute the rollback
          const { stdout } = await execPromise(
            `kubectl rollout undo deployment/${deploymentName} -n ${namespace} --to-revision=${revision}`
        );

        res.json({ 
            success: true,
            message: `Rollback of ${deploymentName} to revision ${revision} initiated`,
            output: stdout
        });

        setTimeout(async () => {
            try {
                await execPromise(
                    `kubectl rollout status deployment/${deploymentName} -n ${namespace} --timeout=120s`
                );
            } catch (statusError) {
                console.error('Rollback status check failed:', statusError);
            }
        }, 1000);

    } catch (error) {
        console.error('Rollback failed:', error);
        res.status(500).json({ 
            success: false,
            message: 'Error initiating rollback', 
            error: error.message,
            stderr: error.stderr || ''
        });
    }
};

exports.updateDeployment = async (req, res) => {
    const {
        deploymentName,
        namespace,
        imageName,
        replicas,
        changeCause
    } = req.body;

    try {
        if (!deploymentName || !namespace || !imageName || !replicas) {
            return res.status(400).json({ 
                success: false,
                error: 'Deployment name, namespace, image name and replicas are required' 
            });
        }

        let command = `kubectl set image deployment/${deploymentName} ${deploymentName}=${imageName} -n ${namespace} --record`;
        
        if (changeCause) {
            command += ` --record=true`;
        }

        const { stdout } = await execPromise(command);

        if (replicas) {
            await execPromise(`kubectl scale deployment ${deploymentName} -n ${namespace} --replicas=${replicas}`);
        }

        if (changeCause) {
            await execPromise(
                `kubectl annotate deployment/${deploymentName} -n ${namespace} kubernetes.io/change-cause="${changeCause}" --overwrite`
            );
        }

        res.json({ 
            success: true,
            message: `Deployment ${deploymentName} updated successfully`,
            output: stdout
        });
    } catch (error) {
        res.status(500).json({ 
            success: false,
            message: 'Error updating deployment', 
            error: error.message,
            stderr: error.stderr || ''
        });
    }
};






exports.handleAlertWebhook = async (req, res) => {
  try {
    const alerts = req.body.alerts || [];
    
    // Process standard alerts
    const standardAlerts = alerts.filter(alert => 
      alert.labels?.alertname !== 'PredictedAnomaly'
    );
    
    const anomalyAlerts = alerts.filter(alert => 
      alert.labels?.alertname === 'PredictedAnomaly'
    );
    
    if (anomalyAlerts.length > 0) {
      // Store in database or cache
      console.log('Received predicted anomaly alerts:', anomalyAlerts);
      
      if (req.app.get('io')) {
        req.app.get('io').emit('anomaly_alert', {
          type: 'predicted_anomalies',
          data: anomalyAlerts,
          timestamp: new Date().toISOString()
        });
      }
    }
    
    
    res.status(200).send('OK');
  } catch (error) {
    console.error('Error handling alert webhook:', error);
    res.status(500).send('Error processing alerts');
  }
};
















