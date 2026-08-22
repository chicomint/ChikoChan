'use strict';

// Always use the built-in local database, even when .env contains MongoDB settings.
process.env.STORAGE = 'json';
process.env.DATA_DIR = './data';
process.env.TRUST_PROXY = '0';

require('../server');
