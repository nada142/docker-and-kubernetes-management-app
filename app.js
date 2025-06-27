const session = require('express-session');
const MongoStore = require('connect-mongo');
const bodyParser = require('body-parser');
const mongoose = require('mongoose');
const express = require('express');
const path = require('path');
const mainRoutes = require('./routes/main');
const connectDB = require('./config/db_config');
const activityRoutes = require('./routes/activityRoutes');
const Docker = require('dockerode');
const http = require('http');
const WebSocket = require('ws');
const { spawn } = require('child_process');
const { exec } = require('child_process');
require('dotenv').config();
// Import models
const User = require('./models/User');
const Dockerfile = require('./models/dockerfilee');
const Image = require('./models/Image');
const Container = require('./models/Container');
const Volume = require('./models/Volume');
const Service = require('./models/Service');
const dockerRegistry = require('./models/dockerRegistry');
const dockerSwarm = require('./models/SwarmStack');
const KubernetesCluster = require('./models/KubernetesCluster');
const CICDIntegration = require('./models/CICDIntegration');
const Pipeline = require('./models/Pipeline');
const CICD_EVENT_TYPES = {
  PIPELINE_STATUS: 'pipeline_status',
  PIPELINE_LOG: 'pipeline_log',
  JOB_STATUS: 'job_status',
  STEP_UPDATE: 'step_update',
  STAGE_UPDATE: 'stage_update'
};
const chatRoutes = require('./routes/chatRoutes');
const updateUserActivity = require('./middleware/updateActivity');

const app = express();

app.use(session({
  secret: 'Nada1234*', 
  resave: false,
  saveUninitialized: false, 
  store: MongoStore.create({
      mongoUrl: 'mongodb://localhost:27017/node_app',
      collectionName: 'sessions',
      ttl: 14 * 24 * 60 * 60 
  }),
  cookie: {
      maxAge: 1000 * 60 * 60 * 24, // 1 day
      secure: process.env.NODE_ENV === 'production', 
      httpOnly: true 
  }
}));



// Body parser middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Set view engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
const checkAndRestoreClusters = async () => {
  try {
      const clusters = await KubernetesCluster.find({ status: 'running' });
      
      for (const cluster of clusters) {
          try {
              await cluster.restoreState();
              console.log(`Restored cluster ${cluster.clusterName}`);
          } catch (error) {
              console.error(`Error restoring cluster ${cluster.clusterName}:`, error);
              cluster.status = 'stopped';
              await cluster.save();
          }
      }
  } catch (error) {
      console.error('Error in cluster restoration:', error);
  }
};

// Connect to the database
connectDB();
checkAndRestoreClusters();

// Docker connection
const docker = new Docker({ socketPath: '/var/run/docker.sock' });
docker.ping((err, data) => {
  if (err) {
      console.error('Error connecting to Docker:', err);
  } else {
      console.log('Docker is connected:', data);
  }
});

// Check Docker connection
async function checkDocker() {
  try {
      const containers = await docker.listContainers();
      console.log('Docker is running. Containers:', containers);
  } catch (error) {
      console.error('Error connecting to Docker:', error.message);
  }
}
checkDocker();


// Middleware to update user activity
app.use(updateUserActivity);
const anomalyPredictor = require('./controllers/anomalyController').predictor;
const logger = require('./config/logger');

// Wait for Kubernetes to be ready, then start monitoring
const checkClusterAndStartMonitoring = async () => {
    try {
        const { stdout } = await execPromise('kubectl cluster-info');
        logger.info('Kubernetes cluster is ready, starting anomaly monitoring');
        await anomalyPredictor.startMonitoring();
    } catch (error) {
        logger.warn('Failed to start anomaly monitoring, will retry in 30 seconds');
        setTimeout(checkClusterAndStartMonitoring, 30000);
    }
};

checkClusterAndStartMonitoring();
// Routes
app.use(activityRoutes);
app.use('/', mainRoutes);
app.use('', require('./routes/userRoutes'));
app.use('', require('./routes/dockerfileRoutes'));
app.use('', require('./routes/imagesRoutes'));
app.use('', require('./routes/containerRoutes'));
app.use('', require('./routes/volumeRoutes'));
app.use('', require('./routes/composeRoutes'));
app.use('', require('./routes/dockerRegistryRoutes'));
app.use('', require('./routes/swarmRoutes'));
app.use('', require('./routes/kubernetesRoutes'));
app.use('/api', require('./routes/cicdRoutes'));

app.use("/api/ai", require("./routes/ai"));

app.use('/api', chatRoutes);

const statsRouter = require('./routes/stats');
app.use(statsRouter);

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Create HTTP server
const server = http.createServer(app);

// Route to fetch Docker volumes
app.get('/volumes', async (req, res) => {
  try {
      const volumes = await docker.listVolumes();
      res.json(volumes);
  } catch (error) {
      console.error('Error fetching volumes:', error);
      res.status(500).json({ error: 'Failed to fetch volumes' });
  }
});

// WebSocket server using the same HTTP server
const pty = require('node-pty');
const wss = new WebSocket.Server({ server });
const url = require('url');
const pipelineSubscriptions = new Map();

wss.on('connection', (ws, req) => {
  const queryParams = new URL(req.url, `http://${req.headers.host}`).searchParams;
  const containerId = queryParams.get('containerId');
  const pipelineId = queryParams.get('pipelineId');

  // Handle container terminals
  if (containerId) {
    const shell = pty.spawn('docker', ['exec', '-it', containerId, '/bin/bash'], {
      name: 'xterm-color',
      cols: 80,
      rows: 24,
      cwd: process.env.HOME,
      env: process.env,
    });

    shell.on('data', (data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    });

    ws.on('message', (message) => {
      try {
        const msg = JSON.parse(message);
        if (msg.type === 'resize') {
          shell.resize(msg.cols, msg.rows);
        } else {
          shell.write(message);
        }
      } catch (e) {
        shell.write(message);
      }
    });

    ws.on('close', () => shell.kill());
    return;
  }

  // Handle CI/CD pipeline updates
  if (pipelineId) {
    if (!pipelineSubscriptions.has(pipelineId)) {
      pipelineSubscriptions.set(pipelineId, new Set());
    }
    pipelineSubscriptions.get(pipelineId).add(ws);

    ws.on('message', (message) => {
      try {
        const msg = JSON.parse(message);
      } catch (e) {
        ws.send(JSON.stringify({
          type: 'error',
          message: 'Invalid message format',
          details: e.message
        }));
      }
    });

    ws.on('close', () => {
      pipelineSubscriptions.get(pipelineId)?.delete(ws);
    });
  } else {
    ws.close(1008, 'Must specify either containerId or pipelineId');
  }
});
const broadcastEvent = (event) => {
  wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify(event));
      }
  });
};
// Enhanced broadcast function for CI/CD events
function broadcastCICDEvent(pipelineId, event) {
    if (pipelineSubscriptions.has(pipelineId)) {
        try {
            const eventMessage = JSON.stringify({
                ...event,
                pipelineId,
                timestamp: new Date().toISOString()
            });

            pipelineSubscriptions.get(pipelineId).forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(eventMessage);
                }
            });
        } catch (e) {
            console.error('Error broadcasting event:', e);
        }
    }
}


module.exports = { 
  broadcastEvent,
  broadcastCICDEvent,
  CICD_EVENT_TYPES
};
console.log('WebSocket server running on ws://localhost:5000');

// 404 handler
app.use((req, res, next) => {
  res.status(404).json({ error: "Route not found" });
});

// Start server
const port = process.env.PORT || 5000;
server.listen(port, '0.0.0.0', () => {
  console.log(`Server is running on port ${port}`);
});
