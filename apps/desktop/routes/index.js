/**
 * Recorder Routes
 */

var express = require('express');
var router = express.Router();
const RecordingController = require('../controllers/recording.controller');

/**
 * 🔍 ROUTER-LEVEL HIT LOGGER
 * This proves the request reached THIS router file
 */
router.use((req, res, next) => {
  // Only log API requests, don't spam for static assets if any
  if (req.originalUrl.startsWith('/api')) {
    console.log('✓ [REC ROUTER HIT]', {
      method: req.method,
      originalUrl: req.originalUrl,
      baseUrl: req.baseUrl,
      path: req.path,
      hasAuthHeader: !!req.headers.authorization,
      pid: process.pid
    });
  }
  next();
});

// ==========================================
// API Routes
// ==========================================

/* GET config - expose environment variables to frontend */
router.get(
  '/api/config', 
  (req, res, next) => {
    console.log('➡️ [REC ROUTE] GET /api/config');
    next();
  },
  RecordingController.getConfig
);

/* GET current actions */
router.get(
  '/api/record/actions',
  (req, res, next) => {
    console.log('➡️ [REC ROUTE] GET /api/record/actions');
    next();
  },
  RecordingController.getActions
);

/* POST start recording */
router.post(
  '/api/record/start',
  (req, res, next) => {
    console.log('➡️ [REC ROUTE] POST /api/record/start', {
      mode: req.body?.mode,
      url: req.body?.url
    });
    next();
  },
  RecordingController.startRecording
);

/* POST stop recording */
router.post(
  '/api/record/stop',
  (req, res, next) => {
    console.log('➡️ [REC ROUTE] POST /api/record/stop');
    next();
  },
  RecordingController.stopRecording
);

/* POST save recording */
router.post(
  '/api/record/save',
  (req, res, next) => {
    console.log('➡️ [REC ROUTE] POST /api/record/save', {
      filename: req.body?.filename
    });
    next();
  },
  RecordingController.saveRecording
);

/* POST save custom recording */
router.post(
  '/api/record/save-custom',
  (req, res, next) => {
    console.log('➡️ [REC ROUTE] POST /api/record/save-custom', {
      filename: req.body?.filename,
      actionsCount: Array.isArray(req.body?.actions) ? req.body.actions.length : 0
    });
    next();
  },
  RecordingController.saveCustomRecording
);

/* ALL proxy to external API */
router.all(
  '/api/proxy/*',
  (req, res, next) => {
    console.log('➡️ [REC ROUTE] ALL /api/proxy/*', {
      path: req.path
    });
    next();
  },
  RecordingController.proxyRequest
);

// ==========================================
// View Routes
// ==========================================

/* GET login page. */
router.get('/login', function(req, res, next) {
  res.render('login');
});

/* GET home page. */
router.get('/', function(req, res, next) {
  res.render('index', { title: 'Playwright Recorder' });
});

module.exports = router;
