define(['link'], function(Link) {
    // Inbox Master Server
    // ===================
    // delivers a simple inbox
    // configuration =
    // {
    //   services: [ { name:..., uri:... }, ... ],
    // }
    var InboxMS = function(structure, config) {
        this.structure = structure;
        this.config = config;
        this.config.services.forEach(function(s) { // prep for convenience
            s.messagesLink = { method:'get', uri:s.uri, accept:'application/json' };
        });
    };
    InboxMS.prototype.routes = [
        Link.route('serve', { uri:'^/?$', method:'get', accept:/application\/html\+json/i })
    ];
    InboxMS.prototype.serve = function() {
        var body = {
            _scripts:{ onload:setupAgent },
            _data:{ services:this.config.services, uri:this.config.uri }
        }; 
        return Link.response(200, body, 'application/html+json');
    };

    // Inbox Agent Server
    // ==================
    // serves an inbox instance
    var InboxAS = function(agent) {
        this.agent = agent;
        this.messages = [];
    };
    InboxAS.prototype.routes = [
        Link.route('servMsg', { uri:'^/([0-9]+)/?$' }),
        Link.route('servMsgRange', { uri:'^/([0-9]+)\-([0-9]+)/?$' }),
        Link.route('servAll', { uri:'^(/all)?/?$' }),
        Link.route('servChecked', { uri:'^/checked/?$' }),
        Link.route('servRead', { uri:'^/read/?' }),
        Link.route('servUnread', { uri:'^/unread/?' })
    ];
    InboxAS.prototype.runMethod = function(ids, request) {
        var f = request.method + 'Method';
        if (f in this) {
            return this[f](ids, request);
        } else {
            return Link.response(405);
        }
    };
    // Resources
    InboxAS.prototype.servMsg = function(request, match) {
        var i = +match.uri[1] - 1;
        return this.runMethod([i], request);
    };
    InboxAS.prototype.servMsgRange = function(request, match) {
        var low = +match.uri[1] - 1, high = +match.uri[2];
        var range = [];
        for (var i=low; i < high; i++) { range.push(i); }
        return this.runMethod(range, request);
    };
    InboxAS.prototype.servAll = function(request, match, response) {
        if (match.uri[0] == '/' && request.method != 'get') { return response; } // only handle GET at our base uri
        var range = [];
        for (var i=0; i < this.messages.length; i++) { range.push(i); }
        return this.runMethod(range, request);
    };
    InboxAS.prototype.servChecked = function(request) {
        var rows = this.agent.getBody().getElementsByTagName('tr');
        var ids = [];
        Array.prototype.forEach.call(rows, function(r, i) {
            var c = rows[i].getElementsByClassName('msg-checkbox')[0];
            if (c && c.checked) { ids.push(i); }
        });
        return this.runMethod(ids, request);
    };
    InboxAS.prototype.servRead = function(request) {
        var ids = [];
        this.messages.forEach(function(m, i) {
            if (m.flags && m.flags.seen) { ids.push(i); }
        });
        return this.runMethod(ids, request);
    };
    InboxAS.prototype.servUnread = function(request) {
        var ids = [];
        this.messages.forEach(function(m, i) {
            if (m.flags && !m.flags.seen) { ids.push(i); }
        });
        return this.runMethod(ids, request);
    };
    // Methods
    InboxAS.prototype.getMethod = function(ids, request) {
        if (ids.length > 1) {
            if (request.accept != 'application/json') {
                return { code:415, reason:'multiple messages can only be served in json' };
            }
            var messages = [];
            ids.forEach(function(id) {
                messages.push(this.messages[id]);
            }, this);
            return Link.response(200, { messages:messages }, 'application/json');
        }
        var m = this.messages[ids[0]];
        if (!m) { return { code:404 }; }
        // pipe to source service
        return this.agent.dispatch({ method:'get', uri:m.uri, accept:request.accept });
    };
    InboxAS.prototype.checkMethod = function(ids) {
        var rows = this.agent.getBody().getElementsByTagName('tr');
        // figure out if some need to be checked, or all dechecked
        var should_check = false;
        ids.forEach(function(id) {
            var c = rows[id].getElementsByClassName('msg-checkbox')[0];
            if (c && !c.checked) {
                should_check = true;
            }
        });
        // update elems
        ids.forEach(function(id) {
            var c = rows[id].getElementsByClassName('msg-checkbox')[0];
            if (c) {
                c.checked = should_check;
            }
        });
        return Link.response(204);
    };
    InboxAS.prototype.markreadMethod = function(ids) {
        var rows = this.agent.getBody().getElementsByTagName('tr');
        // mark read all given
        ids.forEach(function(id) {
            // update DOM
            var row = rows[id];
            row.className = row.className.replace('unread','');
            // send message
            var m = this.messages[id];
            if (m) {
                m.flags.seen = true;
                this.agent.dispatch({ method:'put', uri:m.uri+'/flags', 'content-type':'application/json', body:{ seen:1 } });
            }
        }, this);
        return Link.response(204);
    };
    InboxAS.prototype.markunreadMethod = function(ids) {
        var rows = this.agent.getBody().getElementsByTagName('tr');
        // mark read all given
        ids.forEach(function(id) {
            // update DOM
            var row = rows[id];
            if (/unread/i.test(row.className) == false) {
                row.className += 'unread';
            }
            // send message
            var m = this.messages[id];
            if (m) {
                m.flags.seen = false;
                this.agent.dispatch({ method:'put', uri:m.uri+'/flags', 'content-type':'application/json', body:{ seen:0 } });
            }
        }, this);
        return Link.response(204);
    };
    InboxAS.prototype.deleteMethod = function(ids) {
        var rows = this.agent.getBody().getElementsByTagName('tr');
        // delete all given
        ids.forEach(function(id) {
            // clear DOM
            var row = rows[id];
            row.innerHTML = '';
            // send delete message
            var m = this.messages[id];
            if (!m) { return; }
            this.agent.dispatch({ method:'delete', uri:m.uri, accept:'application/json' });
            // clear out entry in messages
            this.messages[id] = null;
            // :TODO: notify user of success?
        }, this);
        return Link.response(204);
    };

    // Agent Client
    // ============
    // client-side functions
    function setupAgent(agent, response) {
        try { 
            // grab params
            var uri = response.body._data.uri;
            var services = response.body._data.services;
        } catch(e) { throw "malformed response body"; }

        // setup agent
        agent.services = services;
        agent.attachServer(new InboxAS(agent));
        var server = agent.getServer();

        // get messages from all services
        services.forEach(function(service) {
            agent.dispatch(service.messagesLink).then(function(response) {
                if (response.code == 200) {
                    // cache
                    service.messages = response.body.messages;
                    for (var i=0; i < service.messages.length; i++) { service.messages[i].service = service.name; } // kind of sucks
                    server.messages = server.messages.concat(service.messages);
                    // render
                    render(agent, server.messages);
                }
            });
        });
    }
    function render(agent, messages) {
        var html = '';
        var body = agent.getBody();

        messages.sort(function(a,b) { return ((new Date(a.date).getTime() < new Date(b.date).getTime()) ? 1 : -1); });

        // styles
        html += '<style>';
        html += 'div.inbox-toolbar { height:35px }';
        html += 'div.inbox-toolbar .btn-group { display:inline-block }';
        html += 'table.inbox tr.unread a { color:black }';
        html += 'table.inbox tr a { color:gray }';
        html += '</style>';

        // toolbar
        html += '<div class="inbox-toolbar">';
        html += '<form action="'+agent.getUri()+'/checked"><span class="btn-group">';
        html += '<button class="btn tool-select" title="check '+agent.getUri()+'/all" formmethod="check" formaction="'+agent.getUri()+'/all" draggable="true"><i class="icon-check"></i> check</button>';
        html += '</span><span class="btn-group">';
        html += '<button class="btn tool-markread" title="mark as read '+agent.getUri()+'/checked" formmethod="markread" draggable="true"><i class="icon-eye-open"></i> markread</button>';
        html += '<button class="btn tool-markunread" title="mark unread '+agent.getUri()+'/checked" formmethod="markunread" draggable="true"><i class="icon-eye-close"></i> markunread</button>';
        html += '<button class="btn tool-delete" title="delete '+agent.getUri()+'/checked" formmethod="delete" draggable="true"><i class="icon-trash" formmethod="delete"></i> delete</button>';
        html += '</span></form>';
        html += '</div>';

        // composebar
        html += '<p> Compose: ';
        agent.services.forEach(function(serv) {
            html += '<a href="'+serv.uri+'/new" title="compose message with '+serv.name+'" target="_blank"><span class="label label-info">'+serv.name+'</span></a> ';
        });
        html += '</p>';

        // messages
        html += '<table class="table table-condensed inbox">';
        messages.forEach(function(m, i) {
            var date = new Date(m.date);
            var md = (date.getMonth()+1)+'/'+date.getDate()+'&nbsp;'+date.getHours()+':'+(date.getMinutes() < 10 ? '0' : '')+date.getMinutes();
            var trclass = (m.flags && !m.flags.seen ? 'unread' : '');
            html += '<tr class="'+trclass+'"><td style="color:gray">'+(i+1)+'</td><td><input class="msg-checkbox" type="checkbox" /></td><td><span class="label">'+m.service+'</span></td><td><a href="'+m.uri+'" target="_blank">'+m.summary+'</a></td><td><span style="color:gray">'+md+'</span></td></tr>';
        });
        html += '</table>';

        // add to DOM
        body.innerHTML = html;
    }

    return InboxMS;
});