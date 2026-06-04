const express = require('express');
const { checkRegistrationFields } = require('../controllers/checkRegistrationFields');

const router = express.Router();

router.post('/check-fields', checkRegistrationFields);

module.exports = router;
