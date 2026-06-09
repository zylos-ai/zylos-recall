const path = require('path');
const os = require('os');

module.exports = {
  apps: [{
    name: 'zylos-recall',
    script: 'src/index.js',
    cwd: path.join(os.homedir(), 'zylos/.claude/skills/recall'),
    env: {
      NODE_ENV: 'production',
      UV_THREADPOOL_SIZE: '2',
      OMP_NUM_THREADS: '1',
      ORT_NUM_THREADS: '1'
    },
    // Restart on failure
    autorestart: true,
    max_restarts: 10,
    restart_delay: 5000,
    // Logs managed by PM2
    error_file: path.join(os.homedir(), 'zylos/components/recall/logs/error.log'),
    out_file: path.join(os.homedir(), 'zylos/components/recall/logs/out.log'),
    log_date_format: 'YYYY-MM-DD HH:mm:ss'
  }]
};
