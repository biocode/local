// :TODO: refactor

// Events
// ======
var util = require('../util');
var dispatch = require('./dispatch.js').dispatch;
var Request = require('./request.js');
var Response = require('./response.js');
var contentTypes = require('./content-types.js');

// subscribe()
// ===========
// EXPORTED
// Establishes a connection and begins an event stream
// - sends a GET request with 'text/event-stream' as the Accept header
// - `request`: request object, formed as in `dispatch()`
// - returns a `EventStream` object
function subscribe(request) {
	if (typeof request == 'string')
		request = { url: request };
	request.stream = true; // stream the response
	if (!request.method) request.method = 'SUBSCRIBE';
	if (!request.headers) request.headers = { accept : 'text/event-stream' };
	if (!request.headers.accept) request.headers.accept = 'text/event-stream';

	var response_ = dispatch(request);
	return new EventStream(response_.request, response_);
}


// EventStream
// ===========
// EXPORTED
// wraps a response to emit the events
function EventStream(request, response_) {
	util.EventEmitter.call(this);
	this.request = request;
	this.response = null;
	this.response_ = null;
	this.lastEventId = -1;
	this.isConnOpen = true;

	this.connect(response_);
}
EventStream.prototype = Object.create(util.EventEmitter.prototype);
EventStream.prototype.getUrl = function() { return this.request.url; };
EventStream.prototype.connect = function(response_) {
	var self = this;
	var buffer = '', eventDelimIndex;
	this.response_ = response_;
	response_.then(
		function(response) {
			self.isConnOpen = true;
			self.response = response;
			response.on('data', function(payload) {
				// Add any data we've buffered from past events
				payload = buffer + payload;
				// Step through each event, as its been given
				while ((eventDelimIndex = payload.indexOf('\r\n\r\n')) !== -1) {
					var event = payload.slice(0, eventDelimIndex);
					emitEvent.call(self, event);
					payload = payload.slice(eventDelimIndex+4);
				}
				// Hold onto any lefovers
				buffer = payload;
				// Clear the response' buffer
				response.body = '';
			});
			response.on('end', function() { self.close(); });
			response.on('close', function() { if (self.isConnOpen) { self.reconnect(); } });
			// ^ a close event should be predicated by an end(), giving us time to close ourselves
			//   if we get a close from the other side without an end message, we assume connection fault
			return response;
		},
		function(response) {
			self.response = response;
			emitError.call(self, { event: 'error', data: response });
			self.close();
			throw response;
		}
	);
};
EventStream.prototype.reconnect = function() {
	// Shut down anything old
	if (this.isConnOpen) {
		this.isConnOpen = false;
		this.request.close();
	}

	// Hold off if the app is tearing down (Firefox will succeed in the request and then hold onto the stream)
	if (util.isAppClosing) {
		return;
	}

	// Re-establish the connection
	this.request = new Request(this.request);
	if (!this.request.headers) this.request.headers = {};
	if (this.lastEventId) this.request.headers['last-event-id'] = this.lastEventId;
	this.connect(dispatch(this.request));
	this.request.end();
};
EventStream.prototype.close = function() {
	if (this.isConnOpen) {
		this.isConnOpen = false;
		this.request.close();
		this.emit('close');
	}
};
function emitError(e) {
	this.emit('message', e);
	this.emit('error', e);
}
function emitEvent(e) {
	e = contentTypes.deserialize('text/event-stream', e);
	var id = parseInt(e.id, 10);
	if (typeof id != 'undefined' && id > this.lastEventId)
		this.lastEventId = id;
	this.emit('message', e);
	this.emit(e.event, e);
}


// EventHost
// =========
// EXPORTED
// manages response streams for a server to emit events to
function EventHost() {
	this.streams = [];
}

// listener management
EventHost.prototype.addStream = function(responseStream) {
	responseStream.broadcastStreamId = this.streams.length;
	this.streams.push(responseStream);
	var self = this;
	responseStream.on('close', function() {
		self.endStream(responseStream);
	});
	return responseStream.broadcastStreamId;
};
EventHost.prototype.endStream = function(responseStream) {
	if (typeof responseStream == 'number') {
		responseStream = this.streams[responseStream];
	}
	delete this.streams[responseStream.broadcastStreamId];
	responseStream.end();
};
EventHost.prototype.endAllStreams = function() {
	this.streams.forEach(function(rS) { rS.end(); });
	this.streams.length = 0;
};

// Sends an event to all streams
// - `opts.exclude`: optional number|Response|[number]|[Response], streams not to send to
EventHost.prototype.emit = function(eventName, data, opts) {
	if (!opts) opts = {};
	if (opts.exclude) {
		if (!Array.isArray(opts.exclude)) {
			opts.exclude = [opts.exclude];
		}
		// Convert to ids
		opts.exclude = opts.exclude.map(function(v) {
			if (v instanceof Response) {
				return v.broadcastStreamId;
			}
			return v;
		}, this);
	}
	this.streams.forEach(function(rS, i) {
		if (opts.exclude && opts.exclude.indexOf(i) !== -1) {
			return;
		}
		this.emitTo(rS, eventName, data);
	}, this);
};

// sends an event to the given response stream
EventHost.prototype.emitTo = function(responseStream, eventName, data) {
	if (typeof responseStream == 'number') {
		responseStream = this.streams[responseStream];
	}
	responseStream.write({ event: eventName, data: data });

	// Clear the response's buffer, as the data is handled on emit
	responseStream.body = '';
};

module.exports = {
	subscribe: subscribe,
	EventStream: EventStream,
	EventHost: EventHost
};