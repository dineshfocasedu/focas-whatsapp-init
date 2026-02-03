const { OAuth2Client } = require('google-auth-library');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { v4: uuidv4 } = require('uuid');

const PORT = process.env.PORT || 5000;
const client = new OAuth2Client(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    `http://localhost:${PORT}/api/auth/google/callback`
);
const JWT_SECRET = process.env.JWT_SECRET;

// Mock login for testing purposes
exports.mockLogin = async (req, res) => {
  const { email, name } = req.validatedData; 

  if (!email || !name) {
    return res.status(400).json({ message: 'Email and name are required' });
  }

  try {
    let user = await User.findOne({ email });

    if (!user) {
      user = new User({
        userId: uuidv4(),
        email,
        name,
        createdAt: new Date(),
      });
      await user.save();
    }

    // Create JWT token
    const token = jwt.sign(
      { userId: user.userId, email: user.email },
      JWT_SECRET,
      { expiresIn: '20d' }
    );

    res.status(200).json({ 
      token, 
      user: { 
        userId: user.userId, 
        name: user.name, 
        email: user.email 
      } 
    });
  } catch (error) {
    res.status(500).json({ message: 'Login failed', error: error.message });
  }
};

// Redirects user to Google for authentication
exports.googleAuthRedirect = (req, res) => {
  try {
      const authorizeUrl = client.generateAuthUrl({
          access_type: 'offline',
          scope: [
              'https://www.googleapis.com/auth/userinfo.profile',
              'https://www.googleapis.com/auth/userinfo.email'
          ],
          prompt: 'consent'
      });
      console.log('Trying google signin')
      res.redirect(authorizeUrl);
  } catch (error) {
      console.error('Error generating auth URL:', error);
      res.status(500).send('Error initiating Google OAuth');
  }
};

// Handles the Google OAuth callback and returns JWT
exports.googleAuthCallback = async (req, res) => {
  const { code } = req.query;

  if (!code) {
      return res.status(400).send('Authorization code not provided');
  }

  try {
      // Exchange authorization code for tokens
      console.log('Trying google signin callback')

      const { tokens } = await client.getToken(code);
      client.setCredentials(tokens);

      // Get user info
      const ticket = await client.verifyIdToken({
          idToken: tokens.id_token,
          audience: process.env.GOOGLE_CLIENT_ID
      });

      const payload = ticket.getPayload();

      // Find or create user in DB
      let user = await User.findOne({ email: payload.email });
      if (!user) {
          user = new User({
              userId: uuidv4(),
              email: payload.email,
              name: payload.name,
              picture: payload.picture,
              password: '', // No password for Google users
              createdAt: new Date(),
          });
          await user.save();
      }

      // Create JWT token
      const token = jwt.sign(
          { userId: user.userId, email: user.email },
          JWT_SECRET,
          { expiresIn: '1d' }
      );

      // You can either:
      // 1. Redirect to frontend with token in query param (e.g., /dashboard?token=...)
      // 2. Respond with JSON (for SPA/mobile apps)
      // Here, we'll send JSON:
      res.status(200).json({
          token,
          user: {
              userId: user.userId,
              name: user.name,
              email: user.email,
              picture: user.picture
          }
      });
  } catch (error) {
      console.error('Error during Google OAuth callback:', error);
      res.status(500).send('Authentication failed');
  }
};