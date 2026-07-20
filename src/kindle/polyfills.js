// ES5 runtime polyfills for the Kindle experimental browser (old WebKit).
// esbuild's --target=es5 only lowers *syntax*; these fill in the missing
// *built-ins*. Everything is guarded so modern browsers keep native code.
// Must be the first import of the Kindle entry so it runs before Preact.

/* eslint-disable no-extend-native */

// --- Function.prototype.bind (missing in WebKit < 534.30) ---
if (!Function.prototype.bind) {
  Function.prototype.bind = function (thisArg) {
    var fn = this;
    var partial = Array.prototype.slice.call(arguments, 1);
    return function () {
      return fn.apply(thisArg, partial.concat(Array.prototype.slice.call(arguments)));
    };
  };
}

// --- Object.assign ---
if (typeof Object.assign !== 'function') {
  Object.assign = function (target) {
    if (target == null) throw new TypeError('Cannot convert undefined or null to object');
    var to = Object(target);
    for (var i = 1; i < arguments.length; i++) {
      var src = arguments[i];
      if (src != null) {
        for (var key in src) {
          if (Object.prototype.hasOwnProperty.call(src, key)) to[key] = src[key];
        }
      }
    }
    return to;
  };
}

// --- String.prototype.startsWith / endsWith / includes ---
if (!String.prototype.startsWith) {
  String.prototype.startsWith = function (search, pos) {
    pos = pos || 0;
    return this.substring(pos, pos + search.length) === search;
  };
}
if (!String.prototype.endsWith) {
  String.prototype.endsWith = function (search, len) {
    if (len === undefined || len > this.length) len = this.length;
    return this.substring(len - search.length, len) === search;
  };
}
if (!String.prototype.includes) {
  String.prototype.includes = function (search, start) {
    return this.indexOf(search, start || 0) !== -1;
  };
}

// --- Array.prototype.includes / find / findIndex, Array.from ---
if (!Array.prototype.includes) {
  Array.prototype.includes = function (search, start) {
    return this.indexOf(search, start || 0) !== -1;
  };
}
if (!Array.prototype.findIndex) {
  Array.prototype.findIndex = function (predicate, thisArg) {
    for (var i = 0; i < this.length; i++) {
      if (predicate.call(thisArg, this[i], i, this)) return i;
    }
    return -1;
  };
}
if (!Array.prototype.find) {
  Array.prototype.find = function (predicate, thisArg) {
    var i = this.findIndex(predicate, thisArg);
    return i === -1 ? undefined : this[i];
  };
}
if (!Array.from) {
  Array.from = function (arrayLike, mapFn) {
    var out = [];
    for (var i = 0; i < arrayLike.length; i++) {
      out.push(mapFn ? mapFn(arrayLike[i], i) : arrayLike[i]);
    }
    return out;
  };
}

// --- Set (only what the app uses: new Set(array), add, has, delete) ---
if (typeof window.Set === 'undefined') {
  window.Set = (function () {
    function SetShim(iterable) {
      this._items = [];
      this.size = 0;
      if (iterable) {
        for (var i = 0; i < iterable.length; i++) this.add(iterable[i]);
      }
    }
    SetShim.prototype.add = function (value) {
      if (!this.has(value)) {
        this._items.push(value);
        this.size = this._items.length;
      }
      return this;
    };
    SetShim.prototype.has = function (value) {
      return this._items.indexOf(value) !== -1;
    };
    SetShim.prototype['delete'] = function (value) {
      var i = this._items.indexOf(value);
      if (i === -1) return false;
      this._items.splice(i, 1);
      this.size = this._items.length;
      return true;
    };
    SetShim.prototype.forEach = function (cb, thisArg) {
      for (var i = 0; i < this._items.length; i++) cb.call(thisArg, this._items[i], this._items[i], this);
    };
    SetShim.prototype.clear = function () {
      this._items = [];
      this.size = 0;
    };
    return SetShim;
  })();
}

// --- Promise (Promises/A+ subset: then/catch/finally/resolve/reject/all/race) ---
if (typeof window.Promise !== 'function') {
  window.Promise = (function () {
    function isFn(x) {
      return typeof x === 'function';
    }

    function PromiseShim(executor) {
      this._state = 0; // 0 pending, 1 fulfilled, 2 rejected, 3 adopted another PromiseShim
      this._value = undefined;
      this._deferreds = [];
      doResolve(executor, this);
    }

    function handle(self, deferred) {
      while (self._state === 3) self = self._value;
      if (self._state === 0) {
        self._deferreds.push(deferred);
        return;
      }
      setTimeout(function () {
        var cb = self._state === 1 ? deferred.onFulfilled : deferred.onRejected;
        if (cb === null) {
          (self._state === 1 ? resolve : reject)(deferred.promise, self._value);
          return;
        }
        var ret;
        try {
          ret = cb(self._value);
        } catch (e) {
          reject(deferred.promise, e);
          return;
        }
        resolve(deferred.promise, ret);
      }, 0);
    }

    function resolve(self, newValue) {
      try {
        if (newValue === self) throw new TypeError('A promise cannot be resolved with itself.');
        if (newValue && (typeof newValue === 'object' || isFn(newValue))) {
          if (newValue instanceof PromiseShim) {
            self._state = 3;
            self._value = newValue;
            finale(self);
            return;
          }
          var then = newValue.then;
          if (isFn(then)) {
            doResolve(function (res, rej) {
              then.call(newValue, res, rej);
            }, self);
            return;
          }
        }
        self._state = 1;
        self._value = newValue;
        finale(self);
      } catch (e) {
        reject(self, e);
      }
    }

    function reject(self, newValue) {
      self._state = 2;
      self._value = newValue;
      finale(self);
    }

    function finale(self) {
      for (var i = 0; i < self._deferreds.length; i++) handle(self, self._deferreds[i]);
      self._deferreds = [];
    }

    function doResolve(fn, self) {
      var done = false;
      try {
        fn(
          function (value) {
            if (done) return;
            done = true;
            resolve(self, value);
          },
          function (reason) {
            if (done) return;
            done = true;
            reject(self, reason);
          }
        );
      } catch (e) {
        if (done) return;
        done = true;
        reject(self, e);
      }
    }

    PromiseShim.prototype.then = function (onFulfilled, onRejected) {
      var prom = new PromiseShim(function () {});
      handle(this, {
        onFulfilled: isFn(onFulfilled) ? onFulfilled : null,
        onRejected: isFn(onRejected) ? onRejected : null,
        promise: prom,
      });
      return prom;
    };
    PromiseShim.prototype['catch'] = function (onRejected) {
      return this.then(null, onRejected);
    };
    PromiseShim.prototype['finally'] = function (cb) {
      return this.then(
        function (value) {
          return PromiseShim.resolve(cb()).then(function () {
            return value;
          });
        },
        function (reason) {
          return PromiseShim.resolve(cb()).then(function () {
            throw reason;
          });
        }
      );
    };
    PromiseShim.resolve = function (value) {
      if (value && typeof value === 'object' && value.constructor === PromiseShim) return value;
      return new PromiseShim(function (res) {
        res(value);
      });
    };
    PromiseShim.reject = function (reason) {
      return new PromiseShim(function (res, rej) {
        rej(reason);
      });
    };
    PromiseShim.all = function (arr) {
      return new PromiseShim(function (res, rej) {
        var args = Array.prototype.slice.call(arr);
        if (args.length === 0) {
          res([]);
          return;
        }
        var remaining = args.length;
        function settle(i, val) {
          try {
            if (val && (typeof val === 'object' || isFn(val)) && isFn(val.then)) {
              val.then(function (v) {
                settle(i, v);
              }, rej);
              return;
            }
            args[i] = val;
            if (--remaining === 0) res(args);
          } catch (e) {
            rej(e);
          }
        }
        for (var i = 0; i < args.length; i++) settle(i, args[i]);
      });
    };
    PromiseShim.race = function (arr) {
      return new PromiseShim(function (res, rej) {
        for (var i = 0; i < arr.length; i++) PromiseShim.resolve(arr[i]).then(res, rej);
      });
    };

    return PromiseShim;
  })();
}

// --- fetch (XMLHttpRequest-based; covers what stockfishClient.js uses:
//     method/headers/body request, and ok/status/text()/json() response) ---
if (!window.fetch) {
  window.fetch = function (url, options) {
    options = options || {};
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open(options.method || 'GET', url, true);
      var headers = options.headers || {};
      for (var key in headers) {
        if (Object.prototype.hasOwnProperty.call(headers, key)) xhr.setRequestHeader(key, headers[key]);
      }
      xhr.onreadystatechange = function () {
        if (xhr.readyState !== 4) return;
        if (xhr.status === 0) {
          reject(new TypeError('Network request failed'));
          return;
        }
        var body = xhr.responseText;
        resolve({
          ok: xhr.status >= 200 && xhr.status < 300,
          status: xhr.status,
          statusText: xhr.statusText,
          url: url,
          text: function () {
            return Promise.resolve(body);
          },
          json: function () {
            return new Promise(function (res, rej) {
              try {
                res(JSON.parse(body));
              } catch (e) {
                rej(e);
              }
            });
          },
        });
      };
      xhr.onerror = function () {
        reject(new TypeError('Network request failed'));
      };
      xhr.send(options.body != null ? options.body : null);
    });
  };
}

// --- requestAnimationFrame (Preact hooks fall back to setTimeout on their
//     own, but a shim keeps any other callers safe on old WebKit) ---
if (!window.requestAnimationFrame) {
  window.requestAnimationFrame =
    window.webkitRequestAnimationFrame ||
    function (cb) {
      return window.setTimeout(function () {
        cb(Date.now());
      }, 16);
    };
  window.cancelAnimationFrame =
    window.webkitCancelAnimationFrame ||
    function (id) {
      window.clearTimeout(id);
    };
}
