require('dotenv').config();
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const bcrypt = require('bcryptjs');

const app = express();
const PORT = process.env.PORT || 4000;

const DEFAULT_ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const DEFAULT_ADMIN_DISPLAY_NAME = process.env.ADMIN_DISPLAY_NAME || 'Administrator';
const DEFAULT_ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
const DEFAULT_ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || null;
const DEFAULT_ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'adminpass';

const adminUser = {
  id: 'admin-default',
  username: DEFAULT_ADMIN_USERNAME,
  displayName: DEFAULT_ADMIN_DISPLAY_NAME,
  email: DEFAULT_ADMIN_EMAIL,
  passwordHash: DEFAULT_ADMIN_PASSWORD_HASH || bcrypt.hashSync(DEFAULT_ADMIN_PASSWORD, 10)
};

function verifyLocalAdmin(username, password, done) {
  if (username !== adminUser.username) {
    return done(null, false, { message: 'Incorrect username.' });
  }

  if (!bcrypt.compareSync(password, adminUser.passwordHash)) {
    return done(null, false, { message: 'Incorrect password.' });
  }

  return done(null, { id: adminUser.id, username: adminUser.username, displayName: adminUser.displayName, email: adminUser.email });
}

app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(session({ secret: process.env.SESSION_SECRET || 'dev', resave: false, saveUninitialized: false }));
app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

passport.use(new LocalStrategy(verifyLocalAdmin));

passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID || 'CLIENT_ID',
  clientSecret: process.env.GOOGLE_CLIENT_SECRET || 'CLIENT_SECRET',
  callbackURL: process.env.GOOGLE_CALLBACK_URL || '/auth/google/callback'
}, (accessToken, refreshToken, profile, cb) => {
  return cb(null, { id: profile.id, username: profile.displayName, displayName: profile.displayName, email: profile.emails && profile.emails[0] && profile.emails[0].value });
}));

app.post('/auth/local', passport.authenticate('local'), (req, res) => {
  res.json({ ok: true, user: req.user });
});

app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));

app.get('/auth/google/callback', passport.authenticate('google', { failureRedirect: '/auth/fail' }), (req, res) => {
  res.redirect('/');
});

app.get('/auth/logout', (req, res) => {
  req.logout(err => {
    if (err) return res.status(500).json({ error: 'logout_failed' });
    res.json({ ok: true });
  });
});

app.get('/auth/fail', (req, res) => res.status(401).send('Auth failed'));

function ensureAuth(req, res, next) {
  if (req.isAuthenticated && req.isAuthenticated()) return next();
  return res.status(401).json({ error: 'unauthenticated' });
}

app.get('/api/sites', ensureAuth, (req, res) => {
  res.json([{ id: 'site-1', name: 'example', runtime: 'node' }]);
});

app.get('/api/user', ensureAuth, (req, res) => {
  res.json({ user: req.user });
});

app.get('/', (req, res) => res.send('Panel backend running. Use /auth/google or POST /auth/local to authenticate.'));

app.listen(PORT, () => console.log(`Panel backend listening on ${PORT}`));
