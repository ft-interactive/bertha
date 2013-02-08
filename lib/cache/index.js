var events		= require('events'),
	util		= require('util'),
	_			= require('underscore'),
	memjs		= require('memjs'),
	redisLib	= require("redis");

var connectionTimeMax = 1000 * 100;

function isCached( opts ) {

	opts.callCount = (opts.callCount || 0) + 1;

	if ( opts.callCount >= 3 ) {
		console.log('Reached call count');
		opts.error( new Error('Too many tries'), opts.key );
		return;
	}

	pool.getRedisConnection().hgetall(opts.key, function( redisErr, obj ) {

		if ( redisErr ) {
			opts.always( opts.key );
			opts.error( redisEr, opts.key );
			return;
		}
		
		if ( !obj ) {
			opts.always( opts.key );
			opts.no( wrapIsCached(opts), opts );
			return;
		}

		if ( opts.etag && opts.etag === obj.etag && typeof opts.notModified === 'function' ) {
			opts.always( opts.key );
			opts.notModified( opts.key );
			return;
		}

		pool.getMemcachedConnection().get(opts.key, function( cacheErr, body, extras ) {
			if ( cacheErr ) {
				opts.always( opts.key );
				opts.error( cacheErr, opts.key );
				return;
			}

			if ( body ){
				obj.body = body;
				opts.always( opts.key );
				opts.yes( obj, opts.key );
			} else {
				opts.always( opts.key );
				opts.no( wrapIsCached(opts), opts );
			}
		});

	});

	return this;
}

function wrapIsCached( opts ) {
	return function() {
		isCached( opts );
	};
}

function purgeCache( msg, queue, callback ) {

	pool.getRedisConnection().del(msg, function() {

		pool.getMemcachedConnection()['delete'](msg, function( cacheErr, doc ) {

			if ( cacheErr ) {
				callback( cacheErr, doc );
			}

			queue.remove(msg, function( queueErr, reply ) {
				callback( queueErr, doc, reply );
			});
			
		});
	});
}


/**
* Redis connection convenience function
*
*/
function connectToRedis( timeout, name ) {
	name = name || 'Unnamed';
	var redisHost = '127.0.0.1',
		redisPort = '6379',
		defaultRedisURL = redisHost + ':' + redisPort,
		redisURL = (process.env.REDIS_URL_NAME ? process.env[process.env.REDIS_URL_NAME] : defaultRedisURL).split(':');

	if ( redisURL.length == 1 ) {
		throw new Error('Cannot find Redis host and port: ' + redisURL.join(':'));
	} else if ( redisURL[0] === 'redis' ) {
		redisURL.shift();
	}

	redisHost = redisURL[0];
	redisPort = redisURL[1];

	var connection = redisLib.createClient(redisPort, redisHost);

	connection.on('error', function( err ) {
		console.error( "Redis Error: " + name + '\n', err );
		process.exit( 1 );
	});

	var hasStartedOk = false;

	connection.on('connect', function() {
		console.log( 'Redis connection begun: ' + name );
		hasStartedOk = true;
	});

	connection.on('end', function() {
		console.log( 'Redis connection ended: ' + name );
	});

	setTimeout(function() {

		if ( hasStartedOk ) {
			return;
		}

		console.log( 'Startup timed out on Redis connection : ' + name );
		process.exit( 1 );

	}, timeout || 10000);

	return connection;
}

function connectToMemcached( timeout ) {
	var connection =  memjs.Client.create();

	function handleCacheError( err ) {
		var isErrorOk = false;
		if ( isErrorOk ) {
			return;
		}
		console.error( 'Cache error detected', err.message, err.stack );
		process.exit( 1 );
	}

	// Wait for all cache servers to be available or just one
	// var remainingServers = cache.servers.length;
	var remainingServers = 1;

	var hasStartedOk = false;

	try{
		
		for (var serverKey in connection.servers) {
			connection.servers[serverKey].on('error', handleCacheError);
		}

		connection.stats(function( err, connectionDetails, result ){
			console.log('Memcached stats', err, connectionDetails);

			if ( err ) {
				return;
			}

			remainingServers -= 1;

			if ( !remainingServers ) {
				hasStartedOk = true;
			}
		});

	} catch ( e ) {
		console.error( e.message, e.stack );
		process.exit( 1 );
	}


	setTimeout(function() {

		if ( hasStartedOk ) {
			return;
		}

		console.log( 'Startup timed out on memchached connection' );
		process.exit( 1 );

	}, timeout || connectionTimeMax);

	return connection;
}

var connections = {
	publish:null,
	subscribe:null,
	normalRedis:null,
	memcached: null
};

var pool = {

	getPubishConnection: function( timeout ) {
		if ( !connections.publish ) {
			connections.publish = connectToRedis( timeout || connectionTimeMax, 'Redis Publish Client' );
		}

		return connections.publish;
	},

	getSubscribeConnection: function( timeout ) {
		if ( !connections.subscribe ) {
			connections.subscribe = connectToRedis( timeout || connectionTimeMax, 'Redis Subscribe Client' );
		}

		return connections.subscribe;
	},

	getRedisConnection: function( timeout ) {
		if ( !connections.normalRedis ) {
			connections.normalRedis = connectToRedis( timeout || connectionTimeMax, 'Default Redis Client' );
		}

		return connections.normalRedis;
	},

	getMemcachedConnection: function( timeout ) {
		if ( !connections.memcached ) {
			connections.memcached = connectToMemcached( timeout || connectionTimeMax, 'Memcached Client' );
		}

		return connections.memcached;
	},

	disconnectAll: function( callback ) {

		if ( connections.memcached ) {
			connections.memcached.close();
		}

		var conns = [];

		if ( connections.publish ) {
			conns.push( connections.publish );
		}

		if ( connections.subscribe ) {
			conns.push( connections.subscribe );
		}

		if ( connections.normalRedis ) {
			conns.push( connections.normalRedis );
		}

		callback = _.after( conns.length, callback || function(){} );

		conns.forEach(function( c, i ){
			c.on( 'end', callback).quit();
		});
		
	},

	killAll: function() {
		try {
			if ( connections.publish ) {
				connections.publish.end();
			}

			if ( connections.subscribe ) {
				connections.subscribe.end();
			}

			if ( connections.normalRedis ) {
				connections.normalRedis.end();
			}
		} catch (e) {
			console.log('Error killing Redis connections');
		}
	}
};

// TODO: why do we need to do this? - cant Memcache be lazy connected?
pool.getMemcachedConnection();

exports.pool = pool;
exports.isCached = isCached;
exports.purgeCache = purgeCache;
exports.parseMessage = memjs.Utils.parseMessage;