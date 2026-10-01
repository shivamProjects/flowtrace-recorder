/**
 * Recording Controller
 * Handles Playwright recording operations
 */

const CodegenRecorder = require('../codegen-recorder');
const ApiResponse = require('../utils/responses');
const LoggerService = require('../services/logger.service');

const API_BASE_URL = process.env.API_BASE_URL || 'http://nitro:3050';

// Create a single recorder instance
const recorder = new CodegenRecorder();

class RecordingController {
  
  /**
   * Get Configuration
   * GET /api/config
   */
  static async getConfig(req, res) {
    const startTime = Date.now();
    LoggerService.logStep(1, 'Retrieving configuration');
    
    const config = {
      apiBaseUrl: API_BASE_URL
    };

    LoggerService.logSuccess({
      action: 'GET_CONFIG',
      message: 'Configuration retrieved successfully',
      executionTime: Date.now() - startTime
    });

    return ApiResponse.success(res, config, 'Configuration retrieved successfully');
  }

  /**
   * Proxy API Requests
   * ALL /api/proxy/*
   */
  static async proxyRequest(req, res) {
    const startTime = Date.now();
    const extPath = req.path.replace(/^\/api\/proxy/, '');
    const qs = new URLSearchParams(req.query).toString();
    const url = `${API_BASE_URL}${extPath}${qs ? '?' + qs : ''}`;

    LoggerService.logStep(1, `Proxying request to ${url}`);

    const headers = {};
    if (req.headers.authorization) headers['Authorization'] = req.headers.authorization;
    if (req.method !== 'GET' && req.method !== 'HEAD') headers['Content-Type'] = 'application/json';

    try {
      LoggerService.logStep(2, `Executing ${req.method} request`);
      
      const response = await fetch(url, {
        method: req.method,
        headers,
        ...(req.method !== 'GET' && req.method !== 'HEAD' ? { body: JSON.stringify(req.body) } : {})
      });
      
      let data;
      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        data = await response.json();
      } else {
        const text = await response.text();
        data = { message: text };
      }

      LoggerService.logSuccess({
        action: 'PROXY_REQUEST',
        message: `Proxied request successfully to ${url} (status: ${response.status})`,
        executionTime: Date.now() - startTime
      });

      return res.status(response.status).json(data);
    } catch (error) {
      LoggerService.logFailure({
        action: 'PROXY_REQUEST',
        errorMessage: error.message,
        statusCode: 502,
        executionTime: Date.now() - startTime
      });
      return ApiResponse.error(res, `Failed to connect to backend server (${error.message})`, 502);
    }
  }

  /**
   * Start Recording
   * POST /api/record/start
   */
  static async startRecording(req, res) {
    const startTime = Date.now();
    try {
      const { url, mode } = req.body;

      LoggerService.logStep(1, 'Validating start recording payload');
      if (mode === 'instant' && !url) {
        return ApiResponse.validationError(res, 'URL is required for Record Navigation Path mode');
      }

      LoggerService.logStep(2, `Starting recorder for URL: ${url || 'N/A'}, mode: ${mode}`);
      const result = await recorder.startRecording(url || '', mode || 'instant');

      if (!result.success) {
        throw new Error(result.error || 'Failed to start recording');
      }

      LoggerService.logSuccess({
        action: 'START_RECORDING',
        message: 'Recording started successfully',
        executionTime: Date.now() - startTime
      });

      return ApiResponse.success(res, result, 'Recording started');
    } catch (error) {
      LoggerService.logFailure({
        action: 'START_RECORDING',
        errorMessage: error.message,
        statusCode: 500,
        executionTime: Date.now() - startTime
      });
      return ApiResponse.error(res, error.message, 500);
    }
  }

  /**
   * Stop Recording
   * POST /api/record/stop
   */
  static async stopRecording(req, res) {
    const startTime = Date.now();
    try {
      LoggerService.logStep(1, 'Stopping recorder process');
      const result = await recorder.stopRecording();

      if (!result.success) {
        throw new Error(result.error || 'Failed to stop recording');
      }

      LoggerService.logSuccess({
        action: 'STOP_RECORDING',
        message: 'Recording stopped successfully',
        executionTime: Date.now() - startTime
      });

      return ApiResponse.success(res, result, 'Recording stopped');
    } catch (error) {
      LoggerService.logFailure({
        action: 'STOP_RECORDING',
        errorMessage: error.message,
        statusCode: 500,
        executionTime: Date.now() - startTime
      });
      return ApiResponse.error(res, error.message, 500);
    }
  }

  /**
   * Save Recording
   * POST /api/record/save
   */
  static async saveRecording(req, res) {
    const startTime = Date.now();
    try {
      const { filename, description, token } = req.body;

      LoggerService.logStep(1, 'Validating save recording payload');
      if (!filename) return ApiResponse.validationError(res, 'Filename is required');
      if (!token) return ApiResponse.validationError(res, 'Authentication token is required');

      LoggerService.logStep(2, 'Stopping recording (if active)');
      const stopResult = await recorder.stopRecording();

      if (!stopResult.success && stopResult.error !== 'Not recording') {
        return ApiResponse.validationError(res, stopResult.error);
      }

      // If we weren't recording and there are no actions provided in the stop result, we can't save.
      // Assuming stopResult.actions always exists when success is true or it's handled internally.
      const actions = stopResult.actions || [];

      LoggerService.logStep(3, `Saving recording locally as backup: ${filename}`);
      const localResult = await recorder.saveRecording(filename, actions);

      LoggerService.logStep(4, 'Formatting payload for external API');
      const stepsWithoutTimestamp = actions.map(action => {
        const { timestamp, ...rest } = action;
        return rest;
      });

      const apiPayload = {
        title: filename,
        description: description || `Recorded on ${new Date().toLocaleString()}`,
        status: "draft",
        steps: stepsWithoutTimestamp,
        metadata: {
          createdFrom: "chrome_extension",
          userEnteredName: filename,
          generatedAt: new Date().toISOString()
        },
        track_id: 1,
        module_id: 2,
        customer_id: 3,
        instance_id: 4,
        instance_user_id: 5,
        nav_id: 6
      };

      LoggerService.logStep(5, 'Transmitting recording to external API');
      const _fetch = typeof fetch === 'undefined' ? require('node-fetch') : fetch;
      const apiResponse = await _fetch(`${API_BASE_URL}/api/extension/recordings`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(apiPayload)
      });

      const apiData = await apiResponse.json();

      if (!apiResponse.ok) {
        throw new Error(apiData.message || 'Failed to save recording to API');
      }

      LoggerService.logSuccess({
        action: 'SAVE_RECORDING',
        message: 'Recording saved locally and sent to external API successfully',
        metadata: { filename, localPath: localResult.filepath },
        executionTime: Date.now() - startTime
      });

      return ApiResponse.success(res, {
        localPath: localResult.filepath,
        apiResponse: apiData
      }, 'Recording saved successfully');
    } catch (error) {
      LoggerService.logFailure({
        action: 'SAVE_RECORDING',
        errorMessage: error.message,
        statusCode: 500,
        executionTime: Date.now() - startTime
      });
      return ApiResponse.error(res, error.message, 500);
    }
  }

  /**
   * Save Custom Recording (with modified actions)
   * POST /api/record/save-custom
   */
  static async saveCustomRecording(req, res) {
    const startTime = Date.now();
    try {
      const { filename, actions, description, token } = req.body;

      LoggerService.logStep(1, 'Validating save custom recording payload');
      if (!filename || !actions) return ApiResponse.validationError(res, 'Filename and actions are required');
      if (!token) return ApiResponse.validationError(res, 'Authentication token is required');

      LoggerService.logStep(2, `Saving custom recording locally: ${filename}`);
      const localResult = await recorder.saveRecording(filename, actions);

      LoggerService.logStep(3, 'Formatting payload for external API');
      const stepsWithoutTimestamp = actions.map(action => {
        const { timestamp, ...rest } = action;
        return rest;
      });

      const apiPayload = {
        title: filename,
        description: description || `Recorded on ${new Date().toLocaleString()}`,
        status: "draft",
        steps: stepsWithoutTimestamp,
        metadata: {
          createdFrom: "chrome_extension",
          userEnteredName: filename,
          generatedAt: new Date().toISOString()
        },
        track_id: 1,
        module_id: 2,
        customer_id: 3,
        instance_id: 4,
        instance_user_id: 5,
        nav_id: 6
      };

      LoggerService.logStep(4, 'Transmitting custom recording to external API');
      const _fetch = typeof fetch === 'undefined' ? require('node-fetch') : fetch;
      const apiResponse = await _fetch(`${API_BASE_URL}/api/extension/recordings`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(apiPayload)
      });

      const apiData = await apiResponse.json();

      if (!apiResponse.ok) {
        throw new Error(apiData.message || 'Failed to save custom recording to API');
      }

      LoggerService.logSuccess({
        action: 'SAVE_CUSTOM_RECORDING',
        message: 'Custom recording saved and sent successfully',
        metadata: { filename, localPath: localResult.filepath },
        executionTime: Date.now() - startTime
      });

      return ApiResponse.success(res, {
        localPath: localResult.filepath,
        apiResponse: apiData
      }, 'Custom recording saved successfully');
    } catch (error) {
      LoggerService.logFailure({
        action: 'SAVE_CUSTOM_RECORDING',
        errorMessage: error.message,
        statusCode: 500,
        executionTime: Date.now() - startTime
      });
      return ApiResponse.error(res, error.message, 500);
    }
  }

  /**
   * Get Current Actions
   * GET /api/record/actions
   */
  static async getActions(req, res) {
    const startTime = Date.now();
    try {
      LoggerService.logStep(1, 'Retrieving recording status');
      const status = recorder.getStatus();

      if (!status.isRecording && status.outputFile) {
        LoggerService.logStep(2, 'Processing recorded actions from output file');
        const result = await recorder.processRecording();
        if (result.success) {
          LoggerService.logSuccess({
            action: 'GET_ACTIONS',
            message: `Retrieved ${result.actions.length} actions`,
            executionTime: Date.now() - startTime
          });
          return ApiResponse.success(res, { actions: result.actions, count: result.actions.length, status }, 'Actions retrieved successfully');
        }
      }

      LoggerService.logSuccess({
        action: 'GET_ACTIONS',
        message: 'Retrieved actions (empty or ongoing)',
        executionTime: Date.now() - startTime
      });
      return ApiResponse.success(res, { actions: [], count: 0, status }, 'Actions retrieved successfully');
    } catch (error) {
      LoggerService.logFailure({
        action: 'GET_ACTIONS',
        errorMessage: error.message,
        statusCode: 500,
        executionTime: Date.now() - startTime
      });
      return ApiResponse.error(res, error.message, 500);
    }
  }
}

module.exports = RecordingController;
