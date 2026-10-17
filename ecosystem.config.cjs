// PM2: the dashboard's API and background worker (see DEPLOY.md).
//   pm2 start ecosystem.config.cjs     pm2 restart kpi-api kpi-worker
// NODE_BIN: Node 22 binary when the server's default `node` is older (e.g. ~/.nvm/versions/node/v22.x/bin/node).
const node = process.env.NODE_BIN || 'node';

module.exports = {
  apps: [
    {
      name: 'kpi-api',
      cwd: `${__dirname}/server`,
      script: 'dist/index.js',
      interpreter: node,
      env: { NODE_ENV: 'production', RUN_WORKER: 'false' },
      max_memory_restart: '700M',
    },
    {
      name: 'kpi-worker',
      cwd: `${__dirname}/server`,
      script: 'dist/worker.js',
      interpreter: node,
      env: { NODE_ENV: 'production' },
      max_memory_restart: '500M',
    },
  ],
};
