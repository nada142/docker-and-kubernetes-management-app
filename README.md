# 🚀 Docker & Kubernetes Management Web Application

## 🧩 Overview

This is a full-featured Node.js web application designed to simplify the management of Docker and Kubernetes environments. It provides a clean and interactive web interface for building Docker images, managing containers, and deploying Kubernetes workloads — all from your browser.

---

## 🌟 Features

### Docker Management
- 🔧 **Dockerfile Generator**: Create and edit Dockerfiles using a built-in editor with AI enhancements.
- 🏗️ **Image Builder**: Build and list Docker images.
- ☁️ **Image Pusher**: Push images to Docker Hub.
- 📦 **Container Manager**: Create, start, stop, restart, and delete containers.
- 💻 **Web Terminal**: Connect to running containers via an in-browser terminal.

### Kubernetes Integration
- ⚙️ Deploy and manage Kubernetes resources (pods, services, volumes, secrets, etc.)
- 📊 monitoring with Prometheus and Grafana
- 🧠 AI-driven anomaly detection based on live cluster metrics

### AI Assistance
- 🤖 **LLM Integration**: Locally hosted Mistral model provides intelligent suggestions and explanations for Docker and Kubernetes tasks.

---

## ⚙️ Prerequisites

Make sure the following software is installed on your system:

| Tool         | Version             |
|--------------|---------------------|
| **Ubuntu**   | 22.04 (or later)    |
| **Node.js**  | v18.20.8            |
| **npm**      | 10.8.2              |
| **Docker**   | 28.1.1              |
| **MongoDB**  | 6.0.22              |



---

## 📦 Installation

1. **Clone the repository:**

```bash
git clone https://github.com/nada142/docker-and-kubernetes-management-app.git
cd docker-and-kubernetes-management-app
```
2. **Install Node.js dependencies (package.json):**
```bash
npm install
```
3. **Running the application:**
```bash
npm run dev 
```

 ☸️ Kubernetes Cluster Setup

### Cluster Initialization
When you click **"Initialize Cluster"**, the application automatically:
1. Installs required Kubernetes components using `kubeadm`
2. Sets up a Calico CNI network plugin
3. (Optional) Deploys Prometheus+Grafana monitoring stack

### Version Management
| Component       | Version Installed | Notes                          |
|-----------------|-------------------|--------------------------------|
| **kubectl**     | v1.28             | Auto-installed with `kubeadm`  |
| **kubeadm**     | v1.28             | Installed during initialization|
| **kubelet**     | v1.28             | Managed by systemd             |
| **containerd**  | v1.6              | Configured automatically       |

CI/CD Configuration
### GitLab Integration
Go to CI/CD page

Click "Connect Account"

fill the form

Manage pipelines directly in the UI

## 🧠 AI Integration (Optional)

This application includes integration with a locally hosted [Mistral]large language model (LLM) using the `ollama` runtime.

### 🔌 Model Configuration

The app sends prompts to a local instance of the Mistral model 

⚙️ Requirements
To enable this feature:

Install Ollama on your local machine.

Pull the model:
```bash
ollama pull mistral:7b-instruct-q2_K
```
### Usage
Web Interface
 - Open a browser and navigate to http://localhost:5000. You can perform the following actions:

Usage
Docker Management
Dockerfiles: Create/edit in the built-in editor.

Images: Build/push from the "Images" page.

Containers: Manage (run/start/stop/connect to terminal/delete) via UI.
Volumes: Manage via the "volume" page.
Docker compose: Manage via the "Docker compose" page.
Docker Swarm: initialize and Manage via the "docker swarm" page.


Kubernetes Management
Deploy workloads via forms or YAML upload.

View real-time metrics (if monitoring enabled).



