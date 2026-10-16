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
  var LEDGER = 'https://rabbitsoftware-io-ledger-public.storage.googleapis.com/anchors/';
  var short = function (id) { return String(id).slice(0, 10) + '…' + String(id).slice(-6); };
  function chainLine(c, what) {
    if (!c) return undefined;
    var r = (c.recent || [])[0];
    if (!r) return c.funded ? 'funded, the first anchor is about to be posted' : 'built and waiting for its gas account to be funded; nothing posted yet';
    return (r.status === 'confirmed' ? 'confirmed' : r.status === 'failed' ? 'failed' : 'submitted, waiting for confirmation') + ' — transaction ' + short(r.txid);
  }
  var anchorFacts = {
    'btc-anchor': function (idx) { var e = idx && idx[0]; return e ? (e.status === 'confirmed' ? 'confirmed in Bitcoin block ' + e.bitcoinHeight : 'submitted, waiting for a Bitcoin block (usually a few hours)') : undefined; },
    'eth-anchor': function (idx, ch) { return chainLine(ch && ch.ethereum); },
    'xrpl-anchor': function (idx, ch) { return chainLine(ch && ch.xrpl); }
  };
  var anchorNodes = document.querySelectorAll('[data-anchor]');
  if (anchorNodes.length && window.fetch) {
    Promise.all([fetch(LEDGER + 'index.json', { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; }),
                 fetch(LEDGER + 'chains.json', { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; })]).then(function (both) {
      Array.prototype.forEach.call(anchorNodes, function (n) {
        var fn = anchorFacts[n.getAttribute('data-anchor')];
        var v = fn && fn(both[0], both[1]);
        if (v) n.textContent = v;
      });
    });
  }
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
