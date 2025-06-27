const express = require("express");
const axios = require("axios");
const router = express.Router();

router.post("/suggest", async (req, res) => {
    try {
        if (!req.body || !req.body.userInput) {
            return res.status(400).json({ error: "No userInput provided" });
        }

        const { userInput } = req.body;

        const response = await axios.post("http://localhost:11434/api/generate", {
            model: "mistral",
            prompt: `Improve this Dockerfile:\n${userInput}`,
            stream: false
        });

        res.json({ suggestion: response.data.response });
    } catch (error) {
        console.error("AI error:", error);
        res.status(500).json({ error: "AI suggestion failed" });
    }
});

module.exports = router;
