require('dotenv').config();
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;

const app = express();
const PORT = process.env.PORT || 4000;

app.use(express.json());
app.use(session({ secret: process.env.SESSION_SECRET || 'dev', resave: false, saveUninitialized: false }));
app.use(passport.initialize());
app.use(passport.session());

// Minimal user serialization
passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID || 'CLIENT_ID',
  clientSecret: process.env.GOOGLE_CLIENT_SECRET || 'CLIENT_SECRET',
  callbackURL: process.env.GOOGLE_CALLBACK_URL || '/auth/google/callback'
}, (accessToken, refreshToken, profile, cb) => {
  // In production: link profile to local user and persist
  return cb(null, { id: profile.id, displayName: profile.displayName, emails: profile.emails });
}));

app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));

app.get('/auth/google/callback', passport.authenticate('google', { failureRedirect: '/auth/fail' }), (req, res) => {
  res.redirect('/');
});

app.get('/auth/fail', (req, res) => res.status(401).send('Auth failed'));

function ensureAuth(req, res, next) {
  if (req.isAuthenticated && req.isAuthenticated()) return next();
  return res.status(401).json({ error: 'unauthenticated' });
}

// Protected example API
app.get('/api/sites', ensureAuth, (req, res) => {
  res.json([{ id: 'site-1', name: 'example', runtime: 'node' }]);
});

app.get('/', (req, res) => res.send('Panel backend running. Visit /auth/google to start OAuth.'));

app.listen(PORT, () => console.log(`Panel backend listening on ${PORT}`));
