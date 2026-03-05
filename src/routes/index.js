const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth');

const v1Routes = require('./v1');
const completionsRoutes = require('./completions');
const responsesRoutes = require('./responses');
const messagesRoutes = require('./messages');
const cursorRoutes = require('./cursor');

// Authenticated API routes
router.use('/v1', authMiddleware, v1Routes);
router.use('/v1', authMiddleware, completionsRoutes);
router.use('/v1/responses', authMiddleware, responsesRoutes);
router.use('/v1/messages', authMiddleware, messagesRoutes);

// Cursor specific routes (login etc, may not need auth)
router.use('/cursor', cursorRoutes);

module.exports = router;
