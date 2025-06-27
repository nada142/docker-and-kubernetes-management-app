const axios = require('axios');

const chatWithGPT = async (req, res) => {
    try {
        const { message } = req.body;
        const response = await axios.post('http://localhost:11434/api/generate', {
            model: 'mistral:7b-instruct-q2_K', 
            prompt: `You are a helpful assistant for Docker and Kubernetes. Answer the following question shortly but clearly:\n\n${message}`,
            stream: false
        });
        res.json({ response: response.data.response });
    } catch (error) {
        console.error('Error in chatbot:', error);
        res.status(500).json({ error: 'Error in chatbot' });
    }
};

module.exports = { chatWithGPT };