# Docker Management Web Application

## Overview
This project is a Node.js web application designed to provide a user-friendly interface for managing Docker environments. The application allows users to generate Dockerfiles, build Docker images, push images to Docker Hub, and manage Docker containers through a simple web interface.

## Features
- **Dockerfile Generator**: Create and edit Dockerfiles with an intuitive interface.
- **Image Builder**: Build Docker images from Dockerfiles and store them.
- **Image Pusher**: Push Docker images to Docker Hub.
- **Container Manager**: Add, stop, restart, and delete Docker containers.
- **Web Terminal**: Connect to and interact with running Docker containers through a web-based terminal.

## Prerequisites
Before setting up the project, ensure you have the following installed on your machine:

### Required Software
- **Node.js**: v16.16.0
- **NPM** (Node Package Manager): v8.11.0
- **Docker**: v27.1.1 or higher (Note: Docker Desktop is not required; use WSL2 with Docker for Windows if running on Windows)
- **WSL2** (Windows Subsystem for Linux): Required if running on Windows without Docker Desktop
- **MongoDB**: v7.0.12 or higher

### Docker Configuration
- Docker should be configured to run under WSL2 if using Windows. Make sure that Docker is installed and running properly within the WSL2 environment.
- Ensure that the Docker daemon is accessible via `/var/run/docker.sock`.

### Install the required Node.js dependencies using NPM:

├── bcrypt@5.1.1
├── bcryptjs@2.4.3
├── connect-mongo@5.1.0
├── cookie-parser@1.4.6
├── dockerode@4.0.2
├── ejs@3.1.10
├── express-ejs-layouts@2.5.1
├── express-session@1.18.0
├── express-ws@5.0.2
├── express@4.19.2
├── jsonwebtoken@9.0.2
├── method-override@3.0.0
├── mongoose@8.5.2
├── node-pty@1.0.0
├── nodemon@3.1.4
├── socket.io-client@4.7.5
├── socket.io@4.7.5
├── ws@8.18.0
├── xterm-addon-fit@0.8.0
└── xterm@5.3.0



### Usage
Web Interface
 - Open a browser and navigate to http://localhost:5000. You can perform the following actions:

 - Generate Dockerfiles: Navigate to the Dockerfile section, create a new Dockerfile, and save it.
 - Build Docker Images: Use the Dockerfile to build an image. The image will be stored in your Docker environment and listed in the web interface.
  - Manage Images:View dockerfile and delete Docker images.
 - Push Docker Images: Push images to Docker Hub by providing your credentials and repository details.
 - Manage Containers: Start, stop, restart, and delete Docker containers. You can also connect to a container’s terminal directly through the interface.
"# docker_node" 
"# docker_node" 
