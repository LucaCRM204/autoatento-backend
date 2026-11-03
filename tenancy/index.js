/** Punto único de importación de la capa multi-tenant. */
module.exports = {
  ...require('./context'),
  ...require('./realtime'),
  ...require('./jobs'),
  ...require('./state'),
  ...require('./time'),
  ...require('./settings'),
  registry: require('./registry'),
  pools: require('./pools'),
  control: require('./control'),
  crypto: require('./crypto'),
  modules: require('./modules'),
};
