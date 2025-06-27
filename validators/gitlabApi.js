const axios = require('axios');

const gitlabApi = {
  // Make a generic GitLab API request
  request: async (method, url, token, data = null) => {
    try {
      const response = await axios({
        method,
        url,
        headers: {
          'PRIVATE-TOKEN': token,
          'Content-Type': 'application/json'
        },
        data,
        timeout: 10000
      });
      return response.data;
    } catch (error) {
      throw error;
    }
  },

  // Check if a file exists in the repository
  fileExists: async (url, projectPath, filePath, token, branch = 'main') => {
    try {
      await axios.get(
        `${url}/api/v4/projects/${projectPath}/repository/files/${encodeURIComponent(filePath)}?ref=${branch}`,
        {
          headers: { 'PRIVATE-TOKEN': token },
          timeout: 5000
        }
      );
      return true;
    } catch (error) {
      if (error.response?.status === 404) {
        return false;
      }
      throw error;
    }
  }
};

module.exports = gitlabApi;