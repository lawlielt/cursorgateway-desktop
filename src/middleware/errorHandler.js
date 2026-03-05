class ApiError extends Error {
  constructor(statusCode, message, details = null, errorType = null) {
    super(message);
    this.statusCode = statusCode;
    this.details = details;
    this.errorType = errorType;
  }
}

function getErrorType(statusCode) {
  if (statusCode === 401) return 'authentication_error';
  if (statusCode === 400) return 'invalid_request_error';
  if (statusCode === 408) return 'timeout_error';
  if (statusCode >= 400 && statusCode < 500) return 'client_error';
  return 'server_error';
}

function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  const statusCode = err.statusCode || 500;
  const errorType = err.errorType || getErrorType(statusCode);

  console.error(`[Error] ${statusCode} ${errorType}: ${err.message}`);

  // Anthropic Messages API uses a different error format
  const isAnthropicPath = req.path.includes('/messages');
  if (isAnthropicPath) {
    return res.status(statusCode).json({
      type: 'error',
      error: {
        type: errorType,
        message: err.message || 'Internal server error',
        ...(err.details && { details: err.details }),
      },
    });
  }

  // OpenAI-style error format
  res.status(statusCode).json({
    error: {
      message: err.message || 'Internal server error',
      type: errorType,
      param: null,
      code: null,
      ...(err.details && { details: err.details }),
    },
  });
}

module.exports = { errorHandler, ApiError };
