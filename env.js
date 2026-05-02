const path = require('path');
const dotenv = require('dotenv');

// Always load Backend_ai/.env regardless of the current working directory.
dotenv.config({
  path: path.resolve(__dirname, '.env'),
  quiet: true,
});
