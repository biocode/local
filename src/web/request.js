var util = require('../util');
var promise = require('../promises.js').promise;
var contentTypes = require('./content-types.js');
var httpHeaders = require('./http-headers.js');

// Request
// =======
// EXPORTED
// Interface for sending requests
function Request(options) {
	util.EventEmitter.call(this);

	if (!options) options = {};
	if (typeof options == 'string')
		options = { url: options };

	// Pull any header-like keys into the headers object
	var headers = options.headers || {};
	extractUppercaseKeys(options, headers); // Foo_Bar or Foo-Bar

	this.method = options.method ? options.method.toUpperCase() : 'GET';
	this.url = options.url || null;
	this.path = options.path || null;
	this.query = options.query || {};
	this.headers = lowercaseKeys(headers);
	if (!this.headers.host && options.host) {
		this.headers.host = options.host;
	}

	// Guess the content-type if a full body is included in the message
	if (options.body && !this.headers['content-type']) {
		this.headers['content-type'] = (typeof options.body == 'string') ? 'text/plain' : 'application/json';
	}
	// Make sure we have an accept header
	if (!this.headers['accept']) {
		this.headers['accept'] = '*/*';
	}

	// non-enumerables (dont include in request messages)
	Object.defineProperty(this, 'parsedHeaders', {
		value: {},
		configurable: true,
		enumerable: false,
		writable: true
	});
	Object.defineProperty(this, 'body', {
		value: options.body || '',
		configurable: true,
		enumerable: false,
		writable: true
	});
	Object.defineProperty(this, 'stream', {
		value: options.stream || false,
		configurable: true,
		enumerable: false,
		writable: true
	});
	Object.defineProperty(this, 'binary', {
		value: options.binary || false,
		configurable: true,
		enumerable: false,
		writable: true
	});
	Object.defineProperty(this, 'isConnOpen', {
		value: true,
		configurable: true,
		enumerable: false,
		writable: true
	});

	// request buffering
	Object.defineProperty(this, 'body_', {
		value: promise(),
		configurable: true,
		enumerable: false,
		writable: false
	});
	(function buffer(self) {
		self.on('data', function(data) {
			if (typeof data == 'string') {
				self.body += data;
			} else {
				self.body = data; // Assume it is an array buffer or some such
			}
		});
		self.on('end', function() {
			if (self.headers['content-type'])
				self.body = contentTypes.deserialize(self.headers['content-type'], self.body);
			self.body_.fulfill(self.body);
		});
	})(this);
}
module.exports = Request;
Request.prototype = Object.create(util.EventEmitter.prototype);

Request.prototype.header = function(k, v) {
	if (typeof v != 'undefined')
		return this.setHeader(k, v);
	return this.getHeader(k);
};
Request.prototype.setHeader    = function(k, v) { this.headers[k.toLowerCase()] = v; };
Request.prototype.getHeader    = function(k) { return this.headers[k.toLowerCase()]; };
Request.prototype.removeHeader = function(k) { delete this.headers[k.toLowerCase()]; };

// causes the request/response to abort after the given milliseconds
Request.prototype.setTimeout = function(ms) {
	var self = this;
	if (this.__timeoutId) return;
	Object.defineProperty(this, '__timeoutId', {
		value: setTimeout(function() {
			if (self.isConnOpen) { self.close(); }
			delete self.__timeoutId;
		}, ms),
		configurable: true,
		enumerable: false,
		writable: true
	});
};

// EXPORTED
// calls any registered header serialization functions
// - enables apps to use objects during their operation, but remain conformant with specs during transfer
Request.prototype.serializeHeaders = function() {
	for (var k in this.headers) {
		this.headers[k] = httpHeaders.serialize(k, this.headers[k]);
	}
};

// EXPORTED
// calls any registered header deserialization functions
// - enables apps to use objects during their operation, but remain conformant with specs during transfer
Request.prototype.deserializeHeaders = function() {
	for (var k in this.headers) {
		var parsedHeader = httpHeaders.deserialize(k, this.headers[k]);
		if (parsedHeader && typeof parsedHeader != 'string') {
			this.parsedHeaders[k] = parsedHeader;
		}
	}
};

// sends data over the stream
// - emits the 'data' event
Request.prototype.write = function(data) {
	if (!this.isConnOpen)
		return this;
	if (typeof data != 'string' && !(data instanceof ArrayBuffer))
		data = contentTypes.serialize(this.headers['content-type'], data);
	this.emit('data', data);
	return this;
};

// ends the request stream
// - `data`: optional mixed, to write before ending
// - emits 'end' and 'close' events
Request.prototype.end = function(data) {
	if (!this.isConnOpen)
		return this;
	if (typeof data != 'undefined')
		this.write(data);
	this.emit('end');
	// this.close();
	// ^ do not close - the response should close
	return this;
};

// closes the stream, aborting if not yet finished
// - emits 'close' event
Request.prototype.close = function() {
	if (!this.isConnOpen)
		return this;
	this.isConnOpen = false;
	this.emit('close');

	// :TODO: when events are suspended, this can cause problems
	//        maybe put these "removes" in a 'close' listener?
	// this.removeAllListeners('data');
	// this.removeAllListeners('end');
	// this.removeAllListeners('close');
	return this;
};

// internal helper
function lowercaseKeys(obj) {
	var obj2 = {};
	for (var k in obj) {
		if (obj.hasOwnProperty(k))
			obj2[k.toLowerCase()] = obj[k];
	}
	return obj2;
}

// internal helper - has side-effects
var underscoreRegEx = /_/g;
function extractUppercaseKeys(/*mutable*/ org, /*mutable*/ dst) {
	for (var k in org) {
		var kc = k.charAt(0);
		if (org.hasOwnProperty(k) && kc === kc.toUpperCase()) {
			var k2 = k.replace(underscoreRegEx, '-');
			dst[k2] = org[k];
			delete org[k];
		}
	}
}