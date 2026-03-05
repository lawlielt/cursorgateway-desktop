const express = require('express');
const morgan = require('morgan');
const fs = require('fs');
const path = require('path');
const app = express();

const config = require('./config/config');
const routes = require('./routes');
const { hasToken, TOKEN_FILE } = require('./utils/tokenManager');
const { errorHandler } = require('./middleware/errorHandler');

// Tee all console output to a fixed log file
const LOG_FILE = process.env.CURSOR_GATEWAY_LOG_FILE || path.join(process.cwd(), 'server.log');
const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });

function teeWrite(orig, stream) {
  return function (...args) {
    const line = args.join(' ');
    orig.apply(process[stream === 'stderr' ? 'stderr' : 'stdout'], args);
    logStream.write(line + '\n');
  };
}
console.log = teeWrite(console.log, 'stdout');
console.error = teeWrite(console.error, 'stderr');
console.warn = teeWrite(console.warn, 'stderr');

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

app.use(morgan(process.env.MORGAN_FORMAT ?? 'tiny'));

app.use("/", routes);

// Unified error handling (must be registered after routes)
app.use(errorHandler);

app.listen(config.port, () => {
    console.log(`The server listens port: ${config.port}`);
    console.log(`Server URL: http://localhost:${config.port}`);
    
    if (hasToken()) {
        console.log(`[Auth] Using saved token from: ${TOKEN_FILE}`);
        console.log(`[Auth] Requests without Authorization header will use the saved token.`);
    } else {
        console.log(`[Auth] No saved token found. Run 'npm run login' to save your token.`);
        console.log(`[Auth] Or provide token via Authorization header in each request.`);
    }
});
