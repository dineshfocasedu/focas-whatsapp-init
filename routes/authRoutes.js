const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const validate = require('../middleware/validate');
const { mockLoginSchema } = require('../zodSchemas/userSchema');

router.post('/mock-login',validate(mockLoginSchema), authController.mockLogin); // For testing purposes
// Google OAuth2 routes
router.get('/google', authController.googleAuthRedirect);
router.get('/google/callback', authController.googleAuthCallback);

module.exports = router;