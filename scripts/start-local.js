'use strict';

// A connection override keeps the local development shortcut independent of MongoDB.
process.env.DATABASE_URL = 'json:./data';
require('../server');
