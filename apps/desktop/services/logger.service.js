/**
 * Logger Service
 * Standardized logging utility mimicking human-written logs
 */

class LoggerService {
  static logSuccess(details) {
    console.log(`[SUCCESS] ${details.action || 'ACTION'}: ${details.message}`);
    if (details.metadata) {
      console.log(`[METADATA] ${JSON.stringify(details.metadata)}`);
    }
    console.log(`[TIME] Execution time: ${details.executionTime || 0}ms\n`);
  }

  static logFailure(details) {
    console.error(`[ERROR] ${details.action || 'ACTION'} FAILED: ${details.errorMessage}`);
    console.error(`[DETAILS] Status Code: ${details.statusCode}`);
    console.error(`[TIME] Execution time: ${details.executionTime || 0}ms\n`);
  }

  static logStep(stepNumber, description) {
    console.log(`Step ${stepNumber}: ${description}...`);
  }
}

module.exports = LoggerService;
