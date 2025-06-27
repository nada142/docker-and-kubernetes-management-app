const axios = require('axios');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const net = require('net');
const logger = require('../config/logger');

// Store for anomaly predictions
const anomalyStore = {
    predictions: [],
    lastUpdated: null
};

// Configuration
const PREDICTOR_SERVICE = 'http://predictor.monitoring.svc.cluster.local:8000';
const LOCAL_PREDICTOR = 'http://localhost:8000';
const PREDICTION_WINDOW = 15; 
const SCRAPE_INTERVAL = 60000; // 1 minute 

class AnomalyPredictor {
    constructor() {
        this.metricsBuffer = [];
        this.lastPredictionTime = null;
    }

    async checkPredictorHealth() {
        try {
            const response = await axios.get(`${PREDICTOR_SERVICE}/health`, { timeout: 3000 });
            return response.data.status === 'healthy';
        } catch (error) {
            logger.warn(`Predictor health check failed: ${error.message}`);
            return false;
        }
    }

    async getClusterMetrics() {
        try {
            // Get node metrics
            const { stdout: nodes } = await execPromise(
                'kubectl get nodes -o json'
            );
            const nodeList = JSON.parse(nodes).items;

            // Get pod metrics
            const { stdout: pods } = await execPromise(
                'kubectl top pods --all-namespaces --no-headers'
            );
            
            // Get node metrics (CPU, memory)
            const { stdout: nodeMetrics } = await execPromise(
                'kubectl top nodes --no-headers'
            );

            // Process node metrics
            const processedNodes = nodeList.map(node => {
                const metrics = nodeMetrics.split('\n').find(m => m.includes(node.metadata.name));
                const [_, cpu, memory] = metrics ? metrics.split(/\s+/) : [null, '0%', '0%'];
                
                return {
                    name: node.metadata.name,
                    cpu: parseFloat(cpu) || 0,
                    memory: parseFloat(memory) || 0,
                    status: node.status.conditions.find(c => c.type === 'Ready').status,
                    timestamp: new Date().toISOString()
                };
            });

            // Process pod metrics
            const processedPods = pods.split('\n').filter(Boolean).map(line => {
                const [namespace, name, cpu, memory] = line.trim().split(/\s+/);
                return {
                    namespace,
                    name,
                    cpu: parseFloat(cpu) || 0,
                    memory: parseFloat(memory) || 0,
                    timestamp: new Date().toISOString()
                };
            });

            return {
                nodes: processedNodes,
                pods: processedPods,
                timestamp: new Date().toISOString()
            };
        } catch (error) {
            logger.error(`Failed to get cluster metrics: ${error.message}`);
            throw error;
        }
    }

    async predictAnomalies() {
        try {
            // 1. Get current metrics
            const metrics = await this.getClusterMetrics();
            
            // 2. Add to buffer (FIFO)
            this.metricsBuffer.push(metrics);
            if (this.metricsBuffer.length > PREDICTION_WINDOW) {
                this.metricsBuffer.shift();
            }
            
            // 3. Only predict when we have enough data
            if (this.metricsBuffer.length < PREDICTION_WINDOW) {
                logger.info(`Not enough data for prediction (${this.metricsBuffer.length}/${PREDICTION_WINDOW})`);
                return null;
            }
            
            // 4. Format data for the predictor
            const predictionData = {
                sequence: this.metricsBuffer.map(metric => ({
                    CPU_Usage: metric.nodes.reduce((sum, node) => sum + node.cpu, 0) / metric.nodes.length,
                    Memory_Usage: metric.nodes.reduce((sum, node) => sum + node.memory, 0) / metric.nodes.length,
                    Disk_Usage: 0, 
                    Network_Traffic: 0, 
                    Pod_Restarts: 0, 
                    Response_Time: 0, 
                    Timestamp: metric.timestamp,
                    Node: "cluster-aggregate",
                    Pod: "cluster-aggregate"
                }))
            };
            
            // 5. Call the predictor service
            let predictorUrl = PREDICTOR_SERVICE;
            try {
                // First try cluster-local service
                await axios.get(`${PREDICTOR_SERVICE}/health`, { timeout: 1000 });
            } catch (e) {
                // Fall back to localhost if running outside cluster
                predictorUrl = LOCAL_PREDICTOR;
            }
            
            const response = await axios.post(`${predictorUrl}/predict`, predictionData);
            
            // 6. Store and return prediction
            const prediction = {
                ...response.data,
                metrics: predictionData.sequence.slice(-1)[0] 
            };
            
            anomalyStore.predictions.unshift(prediction);
            if (anomalyStore.predictions.length > 100) {
                anomalyStore.predictions.pop();
            }
            anomalyStore.lastUpdated = new Date().toISOString();
            
            return prediction;
        } catch (error) {
            logger.error(`Prediction failed: ${error.message}`);
            throw error;
        }
    }

    async startMonitoring() {
        logger.info('Starting anomaly monitoring service');
        
        // Initial health check
        const isHealthy = await this.checkPredictorHealth();
        if (!isHealthy) {
            logger.warn('Predictor service is not healthy - predictions will fail');
        }
        
        // Start periodic prediction
        this.monitorInterval = setInterval(async () => {
            try {
                await this.predictAnomalies();
            } catch (error) {
                logger.error(`Monitoring cycle failed: ${error.message}`);
            }
        }, SCRAPE_INTERVAL);
    }

    stopMonitoring() {
        if (this.monitorInterval) {
            clearInterval(this.monitorInterval);
            logger.info('Stopped anomaly monitoring service');
        }
    }
}

// Initialize the predictor
const predictor = new AnomalyPredictor();

// Controller methods
exports.getPredictions = async (req, res) => {
    try {
        res.json({
            predictions: anomalyStore.predictions,
            lastUpdated: anomalyStore.lastUpdated
        });
    } catch (error) {
        res.status(500).json({
            error: 'Failed to get predictions',
            details: error.message
        });
    }
};

exports.startMonitoring = async (req, res) => {
    try {
        await predictor.startMonitoring();
        res.json({ status: 'monitoring started' });
    } catch (error) {
        res.status(500).json({
            error: 'Failed to start monitoring',
            details: error.message
        });
    }
};

exports.stopMonitoring = async (req, res) => {
    try {
        predictor.stopMonitoring();
        res.json({ status: 'monitoring stopped' });
    } catch (error) {
        res.status(500).json({
            error: 'Failed to stop monitoring',
            details: error.message
        });
    }
};

exports.getLatestPrediction = async (req, res) => {
    try {
        if (anomalyStore.predictions.length === 0) {
            return res.status(404).json({ message: 'No predictions available' });
        }
        res.json(anomalyStore.predictions[0]);
    } catch (error) {
        res.status(500).json({
            error: 'Failed to get latest prediction',
            details: error.message
        });
    }
};