// routes/kubernetesRoutes.js
const express = require('express');
const router = express.Router();
const kubernetesController = require('../controllers/kubernetesController');
const util = require('util');
const exec = util.promisify(require('child_process').exec);
const axios = require('axios');
const http = require('http');
const net = require('net');


// Cluster Management
router.get('/kubernetes/cluster/state', kubernetesController.checkClusterState);
router.get('/kubernetes/cluster/:clusterName/restore-from-db', kubernetesController.restoreFromDB);
router.get('/kubernetes/clusters', kubernetesController.listClusters);
router.post('/kubernetes/cluster/cancel-init', kubernetesController.cancelInitialization);
router.get('/kubernetes/cluster/restore', kubernetesController.restoreCluster);
router
  .route('/kubernetes/cluster/initialize')
  .get(kubernetesController.initializeCluster)
  .post(kubernetesController.initializeCluster);
router.get('/kubernetes/cluster/add-node', kubernetesController.addNode);

// Cluster Information
router.get('/kubernetes/cluster/nodes', kubernetesController.getNodes);
router.get('/kubernetes/cluster/info', kubernetesController.getClusterInfo);

// Node Operations
router.post('/kubernetes/cluster/drain-node', kubernetesController.drainNode);
router.post('/kubernetes/cluster/cordon-node', kubernetesController.cordonNode);
router.post('/kubernetes/cluster/uncordon-node', kubernetesController.uncordonNode);
router.post('/kubernetes/cluster/delete-node', kubernetesController.deleteNode);
router.get('/kubernetes/cluster/nodes/:nodeName', kubernetesController.getNodeDetails);
// Deployments
router.post('/kubernetes/deployments/create', kubernetesController.createDeployment);
router.get('/kubernetes/deployments', kubernetesController.listDeployments);
router.get('/kubernetes/deployments/yaml', kubernetesController.getDeploymentYaml);
router.post('/kubernetes/deployments/scale', kubernetesController.scaleDeployment);
router.post('/kubernetes/deployments/delete', kubernetesController.deleteDeployment);
router.post('/kubernetes/deployments/create-from-yaml', kubernetesController.createDeploymentFromYaml);
// Namespaces
router.get('/kubernetes/namespaces', kubernetesController.listNamespaces);
router.post('/kubernetes/namespaces/create', kubernetesController.createNamespace);
router.get('/kubernetes/namespaces/yaml', kubernetesController.getNamespaceYaml);
router.post('/kubernetes/namespaces/delete', kubernetesController.deleteNamespace);

// Services
router.post('/kubernetes/services/create', kubernetesController.createService);
router.get('/kubernetes/services', kubernetesController.listServices);
router.get('/kubernetes/services/yaml', kubernetesController.getServiceYaml);
router.post('/kubernetes/services/delete', kubernetesController.deleteService);

// Pods
router.get('/kubernetes/pods', kubernetesController.listPods);
router.get('/kubernetes/pods/containers', kubernetesController.getPodContainers);
router.get('/kubernetes/pods/logs', kubernetesController.getPodLogs);
router.get('/kubernetes/pods/yaml', kubernetesController.getPodYaml);
router.post('/kubernetes/pods/delete', kubernetesController.deletePod);
router.post('/kubernetes/pods/restart', kubernetesController.restartPod);

// Persistent Volume Claims (PVCs)
router.get('/kubernetes/pvcs', kubernetesController.listPVCs);
router.get('/kubernetes/pvcs/yaml', kubernetesController.getPVCYaml);
router.post('/kubernetes/pvcs/create', kubernetesController.createPVC);
router.post('/kubernetes/pvcs/delete', kubernetesController.deletePVC);

// Storage Classes

router.get('/kubernetes/storage-classes', kubernetesController.listStorageClasses);
router.post('/kubernetes/storage-classes/create', kubernetesController.createStorageClass);
router.post('/kubernetes/storage-classes/set-default', kubernetesController.setDefaultStorageClass);
router.delete('/kubernetes/storage-classes/:name', kubernetesController.deleteStorageClass);
// Persistent Volumes (PVs)
router.get('/kubernetes/pvs', kubernetesController.listPVs);
router.get('/kubernetes/pvs/yaml', kubernetesController.getPVYaml);
router.post('/kubernetes/pvs/create', kubernetesController.createPV);
router.post('/kubernetes/pvs/delete', kubernetesController.deletePV);

// ConfigMaps
router.get('/kubernetes/configmaps', kubernetesController.listConfigMaps);
router.get('/kubernetes/configmaps/yaml', kubernetesController.getConfigMapYaml);
router.get('/kubernetes/configmaps/data', kubernetesController.getConfigMapData);
router.post('/kubernetes/configmaps/create', kubernetesController.createConfigMap);
router.post('/kubernetes/configmaps/delete', kubernetesController.deleteConfigMap);

// Secrets
router.get('/kubernetes/secrets', kubernetesController.listSecrets);
router.get('/kubernetes/secrets/yaml', kubernetesController.getSecretYaml);
router.get('/kubernetes/secrets/data', kubernetesController.getSecretData);
router.post('/kubernetes/secrets/create', kubernetesController.createSecret);
router.post('/kubernetes/secrets/delete', kubernetesController.deleteSecret);

// StatefulSets
router.get('/kubernetes/statefulsets', kubernetesController.listStatefulSets);
router.get('/kubernetes/statefulsets/yaml', kubernetesController.getStatefulSetYaml);
router.get('/kubernetes/statefulsets/pods', kubernetesController.getStatefulSetPods);
router.get('/kubernetes/statefulsets/podlogs', kubernetesController.getStatefulSetPodLogs);

router.post('/kubernetes/statefulsets/create', kubernetesController.createStatefulSet);
router.post('/kubernetes/statefulsets/scale', kubernetesController.scaleStatefulSet);
router.post('/kubernetes/statefulsets/delete', kubernetesController.deleteStatefulSet);



// Monitoring routes
router.get('/kubernetes/monitoring/status', kubernetesController.checkMonitoringStatus);
router.get('/kubernetes/monitoring/grafana', kubernetesController.redirectToGrafana);
router.get('/kubernetes/monitoring/prometheus', kubernetesController.redirectToPrometheus);
router.get('/kubernetes/monitoring/alertmanager/alerts', kubernetesController.getActiveAlerts);
router.get('/kubernetes/monitoring/alertmanager', kubernetesController.redirectToAlertManager);
router.get('/kubernetes/monitoring/alertmanager/status', kubernetesController.checkAlertManagerStatus);
router.get('/kubernetes/ingresses', kubernetesController.listIngresses);
router.get('/kubernetes/ingresses/yaml', kubernetesController.getIngressYaml);
router.post('/kubernetes/ingresses/create', kubernetesController.createIngress);
router.post('/kubernetes/ingresses/delete', kubernetesController.deleteIngress);


router.get('/kubernetes/deployments/history', kubernetesController.getDeploymentHistory);
router.post('/kubernetes/deployments/rollback', kubernetesController.rollbackDeployment);
router.get('/kubernetes/deployments/revision', kubernetesController.getRevisionDetails);
router.post('/kubernetes/deployments/update', kubernetesController.updateDeployment);
router.get('/kubernetes/monitoring/alertmanager/health', kubernetesController.checkAlertManagerHealth);

router.post('/kubernetes/monitoring/alerts', kubernetesController.handleAlertWebhook);
router.get('/kubernetes/monitoring/prometheus/alerts', kubernetesController.getPrometheusAlerts);
router.get('/kubernetes/monitoring/prometheus/status', kubernetesController.checkPrometheusStatus);

const anomalyController = require('../controllers/anomalyController');

// Anomaly Prediction Routes
router.get('/kubernetes/anomaly/predictions', anomalyController.getPredictions);
router.get('/kubernetes/anomaly/latest', anomalyController.getLatestPrediction);
router.post('/kubernetes/anomaly/monitoring/start', anomalyController.startMonitoring);
router.post('/kubernetes/anomaly/monitoring/stop', anomalyController.stopMonitoring);
module.exports = router;