const { withGradleProperties } = require('expo/config-plugins');

// Realtime signaling carries the one-use credential in an Authorization header.
module.exports = config => withGradleProperties(config, mod => {
  mod.modResults = mod.modResults.filter(row => row.key !== 'EX_DEV_CLIENT_NETWORK_INSPECTOR');
  mod.modResults.push({ type: 'property', key: 'EX_DEV_CLIENT_NETWORK_INSPECTOR', value: 'false' });
  return mod;
});
