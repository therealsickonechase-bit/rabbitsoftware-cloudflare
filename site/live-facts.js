// Fills elements marked data-fact="..." with live numbers from the public status feed. If the feed cannot be read, the page keeps its plain text.
(function () {
  var FEED = 'https://rabbitsoftware-io-status-public.storage.googleapis.com/status/latest.json';
  var facts = {
    'ledger-events': function (f) { return f.chain && f.chain.app && f.chain.app.length; },
    'chain-agree': function (f) { return f.chain && (f.chain.agree ? 'the app and the Google Cloud copy agree' : 'the copies are being checked'); },
    'services-up': function (f) { return f.up + ' of ' + f.total; },
    'research-records': function (f) { return f.research && f.research.records; },
    'topics-explored': function (f) { return f.research && f.research.topicsExplored; },
    'datasets': function (f) { return f.data && f.data.datasets; }
  };
  var nodes = document.querySelectorAll('[data-fact]');
  if (!nodes.length || !window.fetch) return;
  fetch(FEED, { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : Promise.reject(); }).then(function (feed) {
    Array.prototype.forEach.call(nodes, function (n) {
      var fn = facts[n.getAttribute('data-fact')];
      var v = fn && fn(feed);
      if (v !== undefined && v !== null && v !== '') n.textContent = String(v);
    });
    var when = document.getElementById('facts-when');
    if (when && feed.generatedAt) when.textContent = 'Live numbers as of ' + new Date(feed.generatedAt).toUTCString() + '.';
  }).catch(function () {});
})();
