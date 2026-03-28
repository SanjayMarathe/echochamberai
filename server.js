import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import { TwitterApi } from 'twitter-api-v2';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();

const {
  X_CLIENT_ID,
  X_CLIENT_SECRET,
  CALLBACK_URL = 'http://localhost:3000/callback',
  SESSION_SECRET = 'change-me-in-production',
  PORT = 3000,
} = process.env;

app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
}));

app.use(express.static(__dirname));

// Landing page
app.get('/', (req, res) => {
  res.sendFile(join(__dirname, 'index.html'));
});

// Dashboard — guarded: redirect to / if not authenticated
app.get('/dashboard', (req, res) => {
  if (!req.session.user) return res.redirect('/');
  res.sendFile(join(__dirname, 'dashboard.html'));
});

// Step 1: Start OAuth flow
app.get('/auth/twitter', (req, res) => {
  const client = new TwitterApi({ clientId: X_CLIENT_ID });
  const { url, codeVerifier, state } = client.generateOAuth2AuthLink(CALLBACK_URL, {
    scope: ['users.read', 'tweet.read'],
  });
  req.session.codeVerifier = codeVerifier;
  req.session.oauthState = state;
  res.redirect(url);
});

// Step 2: Handle callback from X
app.get('/callback', async (req, res) => {
  const { code, state } = req.query;
  const { codeVerifier, oauthState } = req.session;

  if (!codeVerifier || !state || state !== oauthState || !code) {
    return res.status(400).send('Invalid OAuth state. Please try again.');
  }

  try {
    const client = new TwitterApi({ clientId: X_CLIENT_ID, clientSecret: X_CLIENT_SECRET });
    const { client: userClient } = await client.loginWithOAuth2({
      code,
      codeVerifier,
      redirectUri: CALLBACK_URL,
    });

    const { data: user } = await userClient.v2.me();
    req.session.user = { id: user.id, name: user.name, username: user.username };
    delete req.session.codeVerifier;
    delete req.session.oauthState;
    res.redirect('/dashboard');
  } catch (err) {
    console.error(err);
    res.status(403).send('Authentication failed. Please try again.');
  }
});

// API: return current user from session
app.get('/api/me', (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Not authenticated' });
  res.json(req.session.user);
});

// Logout
app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

app.listen(PORT, () => {
  console.log(`EchoChamberAI running at http://localhost:${PORT}`);
});
