// Load environment variables — check multiple locations for Electron packaged app
const _path = require('path');
const _fs = require('fs');
const _envCandidates = [
  _path.join(__dirname, '.env'),                          // dev / npm start
  process.resourcesPath && _path.join(process.resourcesPath, '.env'),  // Electron extraResources
  process.env.PORTABLE_EXECUTABLE_DIR && _path.join(process.env.PORTABLE_EXECUTABLE_DIR, '.env') // portable
].filter(Boolean);
const _envPath = _envCandidates.find(p => _fs.existsSync(p));
if (_envPath) {
  require('dotenv').config({ path: _envPath });
  console.log(`[dotenv] Loaded from: ${_envPath}`);
} else {
  require('dotenv').config();
  console.log('[dotenv] No .env found, using process env');
}

var createError = require('http-errors');
var express = require('express');
var path = require('path');
var cookieParser = require('cookie-parser');
var logger = require('morgan');

var indexRouter = require('./routes/index');

var app = express();

// view engine setup
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'jade');

app.use(logger('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

app.use('/', indexRouter);

// catch 404 and forward to error handler
app.use(function(req, res, next) {
  next(createError(404));
});

// error handler
app.use(function(err, req, res, next) {
  // set locals, only providing error in development
  res.locals.message = err.message;
  res.locals.error = req.app.get('env') === 'development' ? err : {};

  // render the error page
  res.status(err.status || 500);
  res.render('error');
});

module.exports = app;
