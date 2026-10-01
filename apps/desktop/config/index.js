require('dotenv').config();

const config = {
  env: process.env.NODE_ENV || 'development',
  port: process.env.PORT || 3000,

  logging: {
    level: process.env.LOG_LEVEL || 'info'
  },

  playwright: {
    headless: process.env.PLAYWRIGHT_HEADLESS === 'true',
    slowMo: parseInt(process.env.PLAYWRIGHT_SLOW_MO) || 500,
    timeout: parseInt(process.env.PLAYWRIGHT_TIMEOUT) || 30000
  },

  recordings: {
    maxSize: parseInt(process.env.MAX_RECORDING_SIZE) || 10000,
    dir: process.env.RECORDINGS_DIR || './recordings',
    tempDir: process.env.TEMP_DIR || './temp'
  },

  security: {
    rateLimitWindowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 900000,
    rateLimitMaxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100
  },

  isDevelopment: function() {
    return this.env === 'development';
  },

  isProduction: function() {
    return this.env === 'production';
  }
};

module.exports = config;
