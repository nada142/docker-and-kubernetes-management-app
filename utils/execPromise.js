const util = require('util');
const exec = util.promisify(require('child_process').exec);

async function execPromise(command, maxBuffer = 1024 * 1024 * 10) { // 10MB buffer
  try {
    const { stdout, stderr } = await exec(command, { maxBuffer });
    if (stderr) console.warn('Command stderr:', stderr);
    return { stdout };
  } catch (error) {
    console.error('Command failed:', error);
    throw error;
  }
}